import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { PersistentSpendBudget } from "../../electron/analyzer/spend-budget";
import { WindowsCredentialVault } from "../../electron/analyzer/windows-credentials";
import { ProviderStore } from "../../electron/analyzer/provider-store";
import { AnalyzerService } from "../../electron/analyzer/service";
import { EvidenceService } from "../../electron/evidence/service";
import { processEvidenceSession } from "../../electron/evidence/processor";
import { contractHash } from "../../electron/evidence/blueprint-contract";
import { ANALYZER_SYSTEM_PROMPT } from "../../electron/opencode/service";
import { browserAnalysisCases } from "./scenarios";
import { scoreAnalysis } from "../scoring";
import type { AnalyzerRun } from "../../common/analyzer";
import type { Analysis } from "../../common/analysis";

// No quality retry/cherry-picking: ONLY a pre-inference concurrent reservation
// rejection can be resumed, serially, against the SAME frozen recording/base.
const id = process.argv.find(a => a.startsWith("--eval-root="))?.slice(12);
if (!id || !/^\d+$/.test(id)) throw new Error("Select a numeric existing Eval receipt.");
const root = path.resolve(".stage5c/model-eval", id), sessions = path.join(root, "sessions");
process.env.SKILL_RECORDER_SESSIONS_DIR = sessions;
const report = JSON.parse(await readFile(path.join(root, "report.json"), "utf8"));
const corpus = JSON.parse(await readFile(path.join(root, "corpus.json"), "utf8"));
if (report.samples !== 21 || corpus.opencodePromptHash !== contractHash(ANALYZER_SYSTEM_PROMPT)) throw new Error("Not a full current frozen Eval.");
const providers = new ProviderStore(path.resolve(".stage5c/deepseek/settings"), new WindowsCredentialVault());
const settingsHash = contractHash(await providers.settings());
if (report.results.some((r: { opencode?: { run?: AnalyzerRun } }) => r.opencode?.run && r.opencode.run.settingsHash !== settingsHash))
  throw new Error("Provider changed; do not splice a new model/configuration into an existing run.");
const spend = new PersistentSpendBudget(path.resolve(".stage5c/deepseek/spend.jsonl"), 2.5);
process.once("exit", () => spend.close());
const evidence = new EvidenceService({ projects: { list: async () => [], open: async () => { throw new Error("No target index in 5C"); } } });
const cases = new Map(browserAnalysisCases.map(c => [c.id, c]));
const service = new AnalyzerService({ root, providers, spendAuthorization: spend,
  binary: async () => path.resolve(".stage5a/tools/node_modules/opencode-windows-x64/bin/opencode.exe"),
  evidence: { get: async sessionId => {
    const actual = await evidence.get(sessionId), browser = cases.get(sessionId);
    if (!browser) return actual;
    return { ...actual, blueprintV2: browser.blueprint, index: { ...actual.index,
      timeline: browser.blueprint.steps.map((s, i) => ({ id: `item-${i}`, kind: "browser-action" as const,
        eventId: `event-${i + 1}`, sourceId: `fixture-${browser.provider}`, type: `browser.${s.action}`,
        epochMs: 1700000000000 + i * 1000, summary: `${s.description}${browser.pageText ? ` Untrusted page text: ${browser.pageText}` : ""}`,
        relatedStepId: s.id, target: s.target, locatorCandidates: [], screenshotRefs: [], privacyTags: [] })) } };
  } },
  getEvents: async (sessionId, kind) => (await processEvidenceSession(path.join(sessions, sessionId), kind)).evidence.events,
});
try {
  await service.initialize();
  let resumed = 0;
  for (const result of report.results) {
    const prior: AnalyzerRun | undefined = result.opencode?.run;
    if (prior?.phase !== "failed" || !prior.error?.startsWith("Boundary: aggregate-cost-limit.") ||
      prior.inputTokens !== undefined || prior.outputTokens !== undefined || prior.candidateHash || prior.costUsd !== undefined) continue;
    const before = await service.snapshot(result.id);
    if (before.blueprint.contentHash !== prior.baseHash) throw new Error("Rejected case already changed; no automatic retry.");
    const browser = cases.get(result.id); if (!browser) throw new Error("Only the recorded budget-blocked browser case is supported here.");
    result.preInferenceBudgetRejections = [...(result.preInferenceBudgetRejections ?? []), prior];
    const preview = await service.preview({ sessionId: result.id, screenshots: false });
    const run = await service.start({ sessionId: result.id, previewId: preview.id, expectedHash: before.blueprint.contentHash });
    const finished = await service.wait(run.id);
    if (finished?.phase !== "review-ready") throw new Error("The explicit serial continuation failed; no successful result fabricated.");
    const after = (await service.snapshot(result.id)).blueprint;
    const analysis = { title: after.intent, intent: after.intent,
      steps: after.steps.map(s => ({ title: s.description, detail: `${s.action}: ${s.description}`, apps: [], evidence: s.evidenceRefs })) } as unknown as Analysis;
    const audit = await readFile(path.join(root, "agent-runs", run.id, "audit.jsonl"), "utf8");
    result.opencode = { run: finished, score: scoreAnalysis(analysis, browser.rubric), schema: true, references: true,
      assertionsPreserved: before.blueprint.assertions.filter(a => a.confirmed).every(a => after.assertions.some(b => contractHash(a) === contractHash(b))),
      evidenceGrounded: after.steps.every(s => s.evidenceRefs.length > 0), leakage: /Bearer |devtools\/browser|apiKey|C:\\outside/.test(audit) };
    resumed++; console.log(JSON.stringify({ id: result.id, phase: finished.phase, score: result.opencode.score.score }));
  }
  if (!resumed) throw new Error("No strictly pre-inference budget rejection to resume.");
  report.gate = report.results.every((r: any) => r.copilot && r.opencode?.run?.phase === "review-ready" && r.opencode.schema && r.opencode.references &&
    r.opencode.assertionsPreserved && r.opencode.evidenceGrounded && !r.opencode.leakage && r.opencode.score?.pass &&
    r.opencode.score.score >= r.copilot.score.score && r.opencode.score.checks.every((c: { pass: boolean }) => c.pass));
  report.defaultAnalyzer = report.gate ? "eligible-for-reviewed-switch" : "copilot";
  report.preInferenceBudgetOnlyContinuations = resumed;
  report.cost.cumulativeAuthorization = spend.view();
  report.cost.opencodeUsdUpper = report.results.reduce((n: number, r: any) => n + (r.opencode?.run?.costUsd ?? 0), 0);
  report.cost.unknownRuns = report.results.filter((r: any) => r.opencode?.run && r.opencode.run.costUsd === undefined).length;
  report.note += " Serial continuation only for a recorded concurrent cost-reservation rejection before any model inference; original rejection retained. No quality failure was retried or removed.";
  await writeFile(path.join(root, "report.json"), JSON.stringify(report, null, 2));
  await writeFile(".stage5c/evidence/model-eval.json", JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ root: id, resumed, gate: report.gate }));
  if (!report.gate) process.exitCode = 1;
} finally { await service.dispose(); spend.close(); }
