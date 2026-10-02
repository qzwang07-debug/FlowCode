import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { ANALYZER_PROMPT_VERSION, ANALYZER_SCHEMA_VERSION } from "../../common/analyzer";
import { ANALYZER_SYSTEM_PROMPT } from "../../electron/opencode/service";
import { contractHash } from "../../electron/evidence/blueprint-contract";

// Publish only sanitized receipts/synthetic corpus, never raw model/runtime state.
const rootArg = process.argv.find(a => a.startsWith("--eval-root="))?.slice(12);
if (!rootArg || !/^\d+$/.test(rootArg)) throw new Error("Select an explicit local numeric Eval receipt, not an arbitrary path.");
const root = path.resolve(".stage5c/model-eval", rootArg), destination = path.resolve("fixtures/stage5c");
const report = JSON.parse(await readFile(path.join(root, "report.json"), "utf8"));
const corpus = JSON.parse(await readFile(path.join(root, "corpus.json"), "utf8"));
if (report.samples !== 21 || corpus.opencodePromptHash !== contractHash(ANALYZER_SYSTEM_PROMPT)) throw new Error("Full current-prompt receipt required. Failed full receipts remain publishable as failures.");
const baseline = JSON.parse(await readFile("fixtures/stage5c/copilot-baseline.json", "utf8"));
const reviewedProvider = JSON.parse(await readFile(".stage5c/deepseek/settings/provider.json", "utf8"));
const legacyBuilder = JSON.parse(await readFile("evals/results/builder-2026-10-01T05-47-41-691Z.json", "utf8"));
if (contractHash(reviewedProvider) !== report.results[0]?.opencode?.run?.settingsHash || reviewedProvider.modelId !== report.model)
  throw new Error("Current provider does not match the actual receipt; preset export refused.");
const inputHash = contractHash({ legacy: corpus.legacy, browser: corpus.browser, browserLegacyContextAdapter: corpus.browserLegacyContextAdapter });
if (baseline.inputHash !== inputHash) throw new Error("Frozen corpus was changed.");
const sanitizeReport = (r: typeof report) => ({
  schemaVersion: 1, gate: r.gate, samples: r.samples, repeats: r.repeats, provider: r.provider, model: r.model,
  copilotModel: r.copilotModel, promptHashes: r.promptHashes,
  results: r.results.map((s: typeof report.results[number]) => ({ id: s.id, kind: s.kind,
    copilot: s.copilot, opencode: s.opencode, ...(s.error ? { error: s.error } : {}),
    ...(s.preInferenceBudgetRejections ? { preInferenceBudgetRejections: s.preInferenceBudgetRejections } : {}) })), cost: r.cost,
  preInferenceBudgetOnlyContinuations: r.preInferenceBudgetOnlyContinuations ?? 0,
  note: r.note,
});
const attempts = [];
for (const name of await readdir(path.resolve(".stage5c/model-eval"))) {
  if (!/^\d+$/.test(name)) continue;
  const directory = path.resolve(".stage5c/model-eval", name);
  const previous = await readFile(path.join(directory, "report.json"), "utf8").then(JSON.parse).catch(() => null);
  if (previous) attempts.push({ receipt: name, model: previous.model, samples: previous.samples, gate: previous.gate,
    promptHashes: previous.promptHashes, cost: previous.cost,
    failedCases: previous.results.filter((s: typeof report.results[number]) => !s.opencode?.score?.checks.every((c: { pass: boolean }) => c.pass) || s.opencode?.run?.phase !== "review-ready")
      .map((s: typeof report.results[number]) => ({ id: s.id, phase: s.opencode?.run?.phase ?? "unavailable", checks: s.opencode?.score?.checks.filter((c: { pass: boolean }) => !c.pass) ?? [], error: s.error ?? null })) });
  else {
    const capabilities = await readFile(path.join(directory, "settings/provider-capabilities.json"), "utf8").then(JSON.parse).catch(() => null);
    const settings = await readFile(path.join(directory, "settings/provider.json"), "utf8").then(JSON.parse).catch(() => null);
    if (capabilities && settings) attempts.push({ receipt: name, model: settings.modelId, gate: false,
      status: "No full completed quality receipt; capability probe only", capabilities });
  }
}
const artifacts = {
  "legacy-builder-eval.json": { schemaVersion: 1, model: "gpt-6.1-sol", at: legacyBuilder.at,
    unchangedLegacyCode: true, passing: legacyBuilder.results.filter((r: { ok: boolean }) => r.ok).length,
    samples: legacyBuilder.results.length, result: "not-passing",
    cases: legacyBuilder.results.map((r: { id: string; ok: boolean; durationMs: number; score: unknown }) => ({ id: r.id, ok: r.ok, durationMs: r.durationMs, score: r.score })) },
  "reviewed-provider.json": reviewedProvider,
  "model-eval.json": { ...sanitizeReport(report), inputHash, promptVersion: ANALYZER_PROMPT_VERSION, schemaVersionName: ANALYZER_SCHEMA_VERSION },
  "corpus.json": { schemaVersion: 1, inputHash, browserLegacyContextAdapter: corpus.browserLegacyContextAdapter,
    legacy: corpus.legacy, browser: corpus.browser },
  "model-attempts.json": { schemaVersion: 1, currentReceipt: rootArg, attempts },
  "runtime-protocol.json": JSON.parse(await readFile(".stage5c/evidence/protocol.json", "utf8")),
  "runtime-cancel.json": JSON.parse(await readFile(".stage5c/evidence/cancel.json", "utf8")),
  "windows-isolation.json": JSON.parse(await readFile(".stage5c/evidence/windows-isolation.json", "utf8")),
  "credential-transfer.json": JSON.parse(await readFile(".stage5c/deepseek/key-check.json", "utf8")),
  "provider-capabilities.json": JSON.parse(await readFile(".stage5c/deepseek/settings/provider-capabilities.json", "utf8")),
  "migration-policy.json": { schemaVersion: 1, qualityPassed: report.gate, samples: report.samples,
    individualCasesMet: report.results.every((r: typeof report.results[number]) => r.copilot && r.opencode?.score?.score >= r.copilot.score.score && r.opencode?.score?.checks.every((c: { pass: boolean }) => c.pass)),
    safetyMet: report.results.every((r: typeof report.results[number]) => r.opencode?.schema && r.opencode?.references && r.opencode?.assertionsPreserved && r.opencode?.evidenceGrounded && !r.opencode?.leakage && r.opencode?.run?.phase === "review-ready"),
    promptVersion: ANALYZER_PROMPT_VERSION, schemaVersionName: ANALYZER_SCHEMA_VERSION, promptHash: corpus.opencodePromptHash,
    settingsHash: report.results[0]?.opencode?.run?.settingsHash ?? "", receiptHash: contractHash(sanitizeReport(report)), inputHash },
};
await mkdir(destination, { recursive: true });
for (const [name, value] of Object.entries(artifacts)) {
  const text = JSON.stringify(value, null, 2) + "\n";
  // All sources here are receipt/corpus documents. Private directories/config,
  // API keys, runtime passwords and process endpoints may never be copied.
  if (/sk-[A-Za-z0-9_-]{20,}|Bearer |devtools\/browser|C:\\\\Users\\\\|D:\\\\code\\\\FlowCode|storageState/.test(text))
    throw new Error(`Private data detected in ${name}; export refused.`);
  await writeFile(path.join(destination, name), text);
}
console.log(JSON.stringify({ exported: Object.keys(artifacts), gate: report.gate, samples: report.samples, inputHash }));
