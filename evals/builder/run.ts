// Builder eval harness: runs the real final-stage builder against each fixed
// scenario and scores how it GENERALIZES the analysis — specifically whether it
// reaches for the right native tool (the `gh` CLI for GitHub) instead of replaying
// the UI in the browser.
//
// For every scenario it: seeds a session with the scenario's FIXED approved
// analysis (analysis.json) into a temp sessions root, runs the real
// AutomationBuilder.build (one turn → a proposed plan), then scores the plan's
// step prompts against the rubric. No describer, no capture — this isolates the
// builder, the part with the variance we're measuring.
//
// Run:
//   node --experimental-transform-types --import ./evals/register.mjs evals/builder/run.ts [flags]
// Flags:
//   --only=slug,slug   run a subset of scenarios
//   --keep             print the temp sessions dir (artifacts kept for inspection)
//   --model=<id>       override the builder model

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

import { AutomationBuilder } from "../../electron/automationbuilder/builder";
import { AUTOMATION_BUILDER_INSTRUCTIONS, AUTOMATION_BUILDER_PROMPT_VERSION } from "../../electron/automationbuilder/instructions";
import { NATIVE_TOOL_POLICY_VERSION, nativeToolPlanIssues, type NativeToolPlanIssue } from "../../electron/automationbuilder/native-tool-policy";
import { requireCatalogue } from "../../electron/architectures/catalogue-registry";
import type { AutomationPlan } from "../../common/automation";
import { seedScenario } from "../lib/seed";
import { builderScenarios } from "./scenarios";
import { BUILDER_SCORER_VERSION, scoreBuilder, type BuilderScoreResult } from "./score";

interface Flags {
  only: Set<string> | null;
  keep: boolean;
  model?: string;
}

function parseFlags(argv: string[]): Flags {
  const flags: Flags = { only: null, keep: false };
  for (const arg of argv) {
    if (arg.startsWith("--only=")) flags.only = new Set(arg.slice(7).split(",").map((s) => s.trim()).filter(Boolean));
    else if (arg === "--keep") flags.keep = true;
    else if (arg.startsWith("--model=")) flags.model = arg.slice(8);
  }
  return flags;
}

interface Result {
  id: string;
  title: string;
  ok: boolean;
  error?: string;
  durationMs: number;
  plan?: AutomationPlan;
  score?: BuilderScoreResult;
  planIssues?: NativeToolPlanIssue[];
  /** Validation rejections are retained, not silently discarded as successes. */
  rejectedProposals: string[];
}

/** The actionable text we score: the ordered step labels + prompts. */
function stepsText(plan: AutomationPlan): string {
  return plan.steps.map((s) => `${s.label}\n${s.prompt}`).join("\n\n");
}

const bar = "─".repeat(64);
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
// Capture before any model call: later workspace edits cannot relabel the run.
const sourceHashes = Object.fromEntries([
  "../../electron/automationbuilder/builder.ts",
  "../../electron/automationbuilder/tools.ts",
  "../../electron/automationbuilder/instructions.ts",
  "../../electron/automationbuilder/native-tool-policy.ts",
  "./score.ts",
].map((file) => [file, hash(readFileSync(new URL(file, import.meta.url), "utf8").replace(/\r\n/g, "\n"))]));

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  if (flags.model) process.env.SKILL_RECORDER_MODEL = flags.model;

  let root = process.env.SKILL_RECORDER_SESSIONS_DIR;
  if (!root) {
    root = mkdtempSync(path.join(os.tmpdir(), "sr-builder-evals-"));
    process.env.SKILL_RECORDER_SESSIONS_DIR = root;
  }

  const selected = builderScenarios.filter((s) => !flags.only || flags.only.has(s.id));
  if (selected.length === 0) {
    console.error("No scenarios matched", flags.only ? [...flags.only] : "");
    process.exit(2);
  }

  console.error(`\nFlowCode — builder evals`);
  console.error(`${selected.length} scenario(s) · sessions root: ${root}`);
  console.error(bar);

  let current: Result | undefined;
  const builder = new AutomationBuilder((p) => {
    if (p.message) process.stderr.write(`   · [${p.sessionId}] ${p.message}\n`);
    if (p.message.startsWith("Rejected plan: ")) current?.rejectedProposals.push(p.message.slice(15));
  });

  const results: Result[] = [];
  for (const scenario of selected) {
    console.error(`\n▶ ${scenario.id} — ${scenario.title}`);
    const started = Date.now();
    const res: Result = { id: scenario.id, title: scenario.title, ok: false, durationMs: 0, rejectedProposals: [] };
    current = res;
    try {
      seedScenario(root, scenario);
      const plan = await builder.build({ sessionId: scenario.id, architecture: scenario.architecture });
      res.plan = plan;
      res.score = scoreBuilder(stepsText(plan), scenario.rubric);
      res.planIssues = nativeToolPlanIssues(plan, scenario.analysis);
      res.ok = res.score.pass && res.planIssues.length === 0;
    } catch (err) {
      res.error = err instanceof Error ? err.message : String(err);
    }
    res.durationMs = Date.now() - started;
    results.push(res);
    printResult(res);
  }

  await builder.dispose();

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outFile = path.join(process.cwd(), "evals", "results", `builder-${stamp}.json`);
  mkdirSync(path.dirname(outFile), { recursive: true });
  const catalogues = [...new Set(selected.map((s) => s.architecture))].map((architecture) => {
    const catalogue = requireCatalogue(architecture, "automation");
    return { architecture, version: catalogue.version, systemPromptHash: hash(`${AUTOMATION_BUILDER_INSTRUCTIONS}\n\n${catalogue.content}`.trim()) };
  });
  writeFileSync(outFile, JSON.stringify({ at: stamp, root, metadata: {
    provider: "github-copilot", model: flags.model ?? process.env.SKILL_RECORDER_MODEL ?? "provider-default",
    promptVersion: AUTOMATION_BUILDER_PROMPT_VERSION, scorerVersion: BUILDER_SCORER_VERSION,
    policyVersion: NATIVE_TOOL_POLICY_VERSION, scenarioHash: hash(JSON.stringify(selected)),
    sourceHashes,
    samples: selected.length, repeats: 1, catalogues, cost: "unavailable (not zero)",
    mode: "plan-only; no business actions executed",
  }, results }, null, 2));

  console.error(`\n${bar}\nSummary`);
  const passed = results.filter((r) => r.ok).length;
  for (const r of results) {
    const pct = r.score ? `${Math.round(r.score.score * 100)}%` : "  — ";
    const status = r.error ? "ERROR" : r.ok ? "PASS " : "FAIL ";
    console.error(`  ${status}  ${pct.padStart(4)}  ${r.id}${r.error ? `  (${r.error})` : ""}`);
  }
  console.error(`\n  ${passed}/${results.length} scenarios passed`);
  if (flags.keep) console.error(`  artifacts: ${root}`);
  console.error(`  results:   ${path.relative(process.cwd(), outFile)}\n`);

  process.exit(passed === results.length ? 0 : 1);
}

function printResult(r: Result): void {
  if (r.error) {
    console.error(`   ✗ error: ${r.error}`);
    return;
  }
  for (const [i, s] of (r.plan?.steps ?? []).entries()) {
    console.error(`   ${i + 1}. ${s.label}: ${s.prompt}`);
  }
  console.error(`   score: ${Math.round((r.score?.score ?? 0) * 100)}% · ${r.ok ? "PASS" : "FAIL"} · ${(r.durationMs / 1000).toFixed(1)}s`);
  for (const c of r.score?.checks ?? []) {
    if (!c.pass) console.error(`     ✗ ${c.name}${c.detail ? ` — ${c.detail}` : ""}`);
  }
  for (const issue of r.planIssues ?? []) console.error(`     ✗ [${issue.code}] ${issue.message}`);
}

main().catch((err) => {
  console.error("Harness crashed:", err);
  process.exit(3);
});
