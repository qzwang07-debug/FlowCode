import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Describer } from "../../electron/describer/describer";
import { DESCRIBER_INSTRUCTIONS } from "../../electron/describer/instructions";
import { AnalyzerService } from "../../electron/analyzer/service";
import { ProviderStore } from "../../electron/analyzer/provider-store";
import { WindowsCredentialVault } from "../../electron/analyzer/windows-credentials";
import { PersistentSpendBudget } from "../../electron/analyzer/spend-budget";
import { EvidenceService } from "../../electron/evidence/service";
import { processEvidenceSession } from "../../electron/evidence/processor";
import { contractHash } from "../../electron/evidence/blueprint-contract";
import { ANALYZER_SYSTEM_PROMPT } from "../../electron/opencode/service";
import { processSession } from "../../electron/pipeline";
import { AnalysisSchema, type Analysis } from "../../common/analysis";
import { FREE_PROVIDER, type AnalyzerRun } from "../../common/analyzer";
import type { AutomationBlueprintV2 } from "../../common/blueprint-v2";
import { makeSessionMeta, materializeEvents, visit, marker, type Scenario } from "../scenario";
import { scenarios } from "../scenarios/index";
import { scoreAnalysis, type ScoreResult } from "../scoring";
import { browserAnalysisCases, type BrowserAnalysisCase } from "./scenarios";

const root = path.resolve(".stage5c", "model-eval", String(Date.now()));
const sessions = path.join(root, "sessions");
process.env.SKILL_RECORDER_SESSIONS_DIR = sessions;
process.env.SKILL_RECORDER_MODEL = "gpt-6.1-sol";
const deepseek = process.argv.includes("--deepseek");
const spend = deepseek ? new PersistentSpendBudget(path.resolve(".stage5c/deepseek/spend.jsonl"), 2.50) : undefined;
process.once("exit", () => spend?.close());
const providers = new ProviderStore(deepseek ? path.resolve(".stage5c/deepseek/settings") : path.join(root, "settings"), deepseek ? new WindowsCredentialVault() :
  { read: async () => undefined, write: async () => { throw new Error("Free model only"); }, remove: async () => {} });
const modelOverride = process.argv.find(a => a.startsWith("--model="))?.slice(8);
const modelId = deepseek ? (await providers.settings()).modelId : modelOverride ?? FREE_PROVIDER.modelId;
if (deepseek && ((await providers.settings()).baseUrl !== "https://api.deepseek.com" || modelOverride)) throw new Error("Metered Eval is limited to the explicitly authorized DeepSeek profile.");
if (!deepseek) {
  if (!modelId.endsWith("-free") && modelId !== "big-pickle") throw new Error("This Eval only authorizes explicit free models.");
  await providers.save({ settings: { ...FREE_PROVIDER, modelId } });
}
const evidence = new EvidenceService({ projects: { list: async () => [], open: async () => { throw new Error("No existing target index in 5C"); } } });
const cases = new Map(browserAnalysisCases.map(c => [c.id, c]));
const service = new AnalyzerService({ root, providers, binary: async () => path.resolve(".stage5a/tools/node_modules/opencode-windows-x64/bin/opencode.exe"),
  spendAuthorization: spend,
  evidence: { get: async id => {
    const actual = await evidence.get(id); const browser = cases.get(id);
    if (!browser) return actual;
    return { ...actual, blueprintV2: browser.blueprint, index: { ...actual.index,
      timeline: browser.blueprint.steps.map((s, i) => ({ id: `item-${i}`, kind: "browser-action" as const,
        eventId: `event-${i + 1}`, sourceId: `fixture-${browser.provider}`, type: `browser.${s.action}`,
        epochMs: 1700000000000 + i * 1000, summary: `${s.description}${browser.pageText ? ` Untrusted page text: ${browser.pageText}` : ""}`,
        relatedStepId: s.id, target: s.target, locatorCandidates: [], screenshotRefs: [], privacyTags: [] })) } };
  } },
  getEvents: async (id, kind) => (await processEvidenceSession(path.join(sessions, id), kind)).evidence.events,
});
interface Result { id: string; kind: string; copilot?: { score: ScoreResult; durationMs: number; costUsd: null; model: string };
  opencode?: { score?: ScoreResult; run: AnalyzerRun | null; schema: boolean; references: boolean; assertionsPreserved: boolean; evidenceGrounded: boolean; leakage: boolean };
  error?: string }
const results: Result[] = [];
const only = process.argv.find(a => a.startsWith("--only="))?.slice(7).split(",");
const selected = [...scenarios.map(s => ({ id: s.id, kind: "legacy", scenario: s })),
  ...browserAnalysisCases.map(c => ({ id: c.id, kind: "browser", browser: c }))].filter(c => !only || only.includes(c.id));
const workers = Number(process.argv.find(a => a.startsWith("--workers="))?.slice(10) ?? 2);
if (!Number.isInteger(workers) || workers < 1 || workers > 4) throw new Error("Eval workers must be between one and four.");
const corpus = { version: 1, repeats: 1, seedTime: 1700000000000,
  browserLegacyContextAdapter: "Same synthetic action descriptions exposed as app/title/URL/notes for the legacy Describer; semantic execution contract remains separately validated.",
  copilotModel: "gpt-6.1-sol", copilotPromptHash: contractHash(DESCRIBER_INSTRUCTIONS),
  opencodeModel: modelId, opencodePromptHash: contractHash(ANALYZER_SYSTEM_PROMPT),
  legacy: scenarios.map(s => ({ id: s.id, truth: s.truth, rubric: s.rubric, events: s.build() })),
  browser: browserAnalysisCases };
await mkdir(root, { recursive: true }); await writeFile(path.join(root, "corpus.json"), JSON.stringify(corpus, null, 2));
const baselinePath = process.argv.find(a => a.startsWith("--baseline="))?.slice(11) ?? "fixtures/stage5c/copilot-baseline.json";
const frozen = JSON.parse(await readFile(baselinePath, "utf8"));
if (frozen.promptHash !== contractHash(DESCRIBER_INSTRUCTIONS) || frozen.model !== "gpt-6.1-sol") throw new Error("Frozen Copilot prompt/model does not match.");
if (frozen.inputHash !== contractHash({ legacy: corpus.legacy, browser: corpus.browser, browserLegacyContextAdapter: corpus.browserLegacyContextAdapter })) throw new Error("Frozen Copilot samples/context adapter changed; obtain a new real baseline.");
const baseline = new Map<string, { score: ScoreResult; durationMs: number }>(frozen.results.map((r: { id: string; score: ScoreResult; durationMs: number }) => [r.id, r]));

async function materialize(id: string, scenario?: Scenario, browser?: BrowserAnalysisCase) {
  const dir = path.join(sessions, id); await mkdir(dir, { recursive: true });
  const events = scenario ? materializeEvents(scenario.build(), 1700000000000) : materializeEvents(browser!.blueprint.steps.flatMap((s, i) => [
    ...visit(i * 2000, browser!.provider === "chrome" ? "Google Chrome" : browser!.provider === "edge" ? "Microsoft Edge" : "Ziniao",
      `https://fixture.test/${id}/${s.id}`, `${browser!.title}: ${s.description}`),
    marker(i * 2000 + 100, s.description),
    ...(browser!.pageText ? [{ atMs: i * 2000 + 150, type: "browser.url", source: "browser-url", payload: { app: "Ziniao", url: `https://fixture.test/${id}`, title: browser!.pageText } }] : []),
  ]), 1700000000000);
  const duration = scenario ? Math.max(...scenario.build().map(e => e.atMs)) + 1000 : 12000;
  await writeFile(path.join(dir, "session.json"), JSON.stringify(makeSessionMeta(id, 1700000000000, duration, scenario?.platform ?? "win32")));
  await writeFile(path.join(dir, "events.jsonl"), events.map(e => JSON.stringify(e)).join("\n") + "\n");
  await processSession(dir);
}
async function toAnalysis(bp: AutomationBlueprintV2): Promise<Analysis> {
  const processed = await processEvidenceSession(path.join(sessions, bp.source.sessionId), bp.projectKind);
  const eventMap = new Map(processed.evidence.events.map(e => [e.eventId, e]));
  return AnalysisSchema.parse({ version: 1, sessionId: bp.source.sessionId, revision: bp.revision, createdAt: 1700000000000,
    narrationSourceUpdatedAt: null, title: bp.intent, intent: bp.intent, intentConfidence: "high", intentRationale: "Evidence-backed Blueprint candidate", feedbackLog: [],
    steps: bp.steps.map(s => ({ id: s.id, title: s.description, detail: `${s.action}: ${s.description}`,
      apps: [...new Set(s.evidenceRefs.flatMap(id => {
        const ref = bp.evidenceRefs.find(e => e.id === id); const event = ref ? eventMap.get(ref.reference) : undefined;
        return typeof event?.payload.app === "string" ? [event.payload.app] : [];
      }))], evidence: s.evidenceRefs, confidence: "high" })) });
}
const describer = new Describer(() => {});
try {
  await service.initialize();
  const cap = await service.testProvider(); if (cap.toolCalling !== "supported" || cap.structuredOutput !== "supported") throw new Error(cap.detail);
  // Frozen legacy baseline was obtained immediately before this run using the
  // unmodified Describer, exact model and all nine existing cases. No saved/fake
  // result substitutes for the 12 new real Copilot runs below.
  for (const sample of selected) {
    const result: Result = { id: sample.id, kind: sample.kind }; results.push(result);
    try {
      const scenario = "scenario" in sample ? sample.scenario : undefined;
      const browser = "browser" in sample ? sample.browser : undefined;
      await materialize(sample.id, scenario, browser);
      if (baseline.has(sample.id)) {
        const existing = baseline.get(sample.id); if (!existing) throw new Error("Frozen Copilot baseline missing");
        result.copilot = { ...existing, costUsd: null, model: "gpt-6.1-sol" };
      } else {
        const started = Date.now(); const analysis = await describer.analyze(sample.id);
        result.copilot = { score: scoreAnalysis(analysis, browser!.rubric), durationMs: Date.now() - started, costUsd: null, model: "gpt-6.1-sol" };
      }
      await writeFile(path.join(root, "results-in-progress.json"), JSON.stringify({ corpusHash: contractHash(corpus), results }, null, 2));
    } catch { result.error = "Copilot baseline/case run failed; no result fabricated."; }
    console.log(JSON.stringify({ id: sample.id, copilot: result.copilot?.score.score ?? null }));
  }
  await describer.dispose();
  let cursor = 0;
  const worker = async () => { while (cursor < selected.length) {
    const sample = selected[cursor++]!; const result = results.find(r => r.id === sample.id)!;
    const rubric = "scenario" in sample ? sample.scenario.rubric : sample.browser.rubric;
    try {
      const before = await service.snapshot(sample.id);
      const preview = await service.preview({ sessionId: sample.id, screenshots: false });
      const run = await service.start({ sessionId: sample.id, previewId: preview.id, expectedHash: before.blueprint.contentHash });
      const finished = await service.wait(run.id);
      if (finished?.phase !== "review-ready") { result.opencode = { run: finished, schema: false, references: false, assertionsPreserved: false, evidenceGrounded: false, leakage: false }; }
      else {
        const after = await service.snapshot(sample.id); const bp = after.blueprint;
        const confirmed = before.blueprint.assertions.filter(a => a.confirmed);
        const score = scoreAnalysis(await toAnalysis(bp), rubric);
        const audit = await readFile(path.join(root, "agent-runs", run.id, "audit.jsonl"), "utf8");
        result.opencode = { run: finished, score, schema: true, references: true,
          assertionsPreserved: confirmed.every(a => bp.assertions.some(b => contractHash(a) === contractHash(b))),
          evidenceGrounded: bp.steps.every(s => s.evidenceRefs.length > 0),
          leakage: /Bearer |devtools\/browser|apiKey|C:\\outside/.test(audit) };
      }
    } catch { result.error = "OpenCode case failed; evidence and diagnostics retained locally."; }
    console.log(JSON.stringify({ id: sample.id, opencode: result.opencode?.score?.score ?? null, phase: result.opencode?.run?.phase }));
    await writeFile(path.join(root, "results-in-progress.json"), JSON.stringify({ corpusHash: contractHash(corpus), results }, null, 2));
  } };
  await Promise.all(Array.from({ length: workers }, () => worker()));
  const completeCorpus = selected.length === scenarios.length + browserAnalysisCases.length;
  const gate = completeCorpus && results.every(r => r.copilot && r.opencode?.run?.phase === "review-ready" && r.opencode.schema && r.opencode.references &&
    r.opencode.assertionsPreserved && r.opencode.evidenceGrounded && !r.opencode.leakage &&
    r.opencode.score?.pass && r.opencode.score.score >= r.copilot.score.score &&
    r.opencode.score.checks.every(c => c.pass));
  const report = { version: 1, corpusHash: contractHash(corpus), repeats: 1, samples: selected.length,
    provider: deepseek ? "DeepSeek official via scoped OpenCode broker; Windows Credential Manager" : "OpenCode Zen free (public endpoint, no paid key)", model: modelId, copilotModel: "gpt-6.1-sol",
    promptHashes: { copilot: corpus.copilotPromptHash, opencode: corpus.opencodePromptHash },
    gate, defaultAnalyzer: gate ? "eligible-for-reviewed-switch" : "copilot", results,
    cost: { opencodeUsdUpper: results.reduce((n, r) => n + (r.opencode?.run?.costUsd ?? 0), 0),
      unknownRuns: results.filter(r => r.opencode?.run && r.opencode.run.costUsd === undefined).length,
      cumulativeAuthorization: spend?.view() ?? null, cnyUpperMultiplier: deepseek ? 8 : null,
      copilot: "unavailable; existing authenticated account" },
    note: "No business execution. No model fake server. Copilot remains unless every frozen case meets its individual baseline plus all safety gates." };
  await writeFile(path.join(root, "report.json"), JSON.stringify(report, null, 2));
  await mkdir(".stage5c/evidence", { recursive: true }); await writeFile(".stage5c/evidence/model-eval.json", JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ root, gate, samples: selected.length, completed: results.filter(r => r.opencode?.run?.phase === "review-ready").length }));
  if (!gate) process.exitCode = 1;
} finally { await describer.dispose(); await service.dispose(); spend?.close(); }
