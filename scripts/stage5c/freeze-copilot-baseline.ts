import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { DESCRIBER_INSTRUCTIONS } from "../../electron/describer/instructions";
import { contractHash } from "../../electron/evidence/blueprint-contract";
import { scenarios } from "../../evals/scenarios/index";
import { browserAnalysisCases } from "../../evals/analyzer/scenarios";
const root = process.argv[2];
if (!root || !root.replaceAll("\\", "/").startsWith(".stage5c/model-eval/")) throw new Error("Supply a task-owned actual model Eval root.");
const corpus = JSON.parse(await readFile(`${root}/corpus.json`, "utf8"));
assert.ok(corpus.browserLegacyContextAdapter);
assert.equal(corpus.copilotModel, "gpt-6.1-sol");
assert.equal(corpus.copilotPromptHash, contractHash(DESCRIBER_INSTRUCTIONS));
const progress = JSON.parse(await readFile(`${root}/results-in-progress.json`, "utf8"));
const expected = [...scenarios.map(s => s.id), ...browserAnalysisCases.map(c => c.id)];
assert.equal(progress.results.length, 21);
const results = expected.map(id => {
  const actual = progress.results.find((r: { id: string }) => r.id === id)?.copilot;
  assert.ok(actual?.score?.pass, `Real baseline not successful: ${id}`);
  assert.equal(actual.score.score, 1);
  return { id, score: actual.score, durationMs: actual.durationMs, costUsd: null, model: "gpt-6.1-sol" };
});
const inputHash = contractHash({ legacy: corpus.legacy, browser: corpus.browser, browserLegacyContextAdapter: corpus.browserLegacyContextAdapter });
await mkdir("fixtures/stage5c", { recursive: true });
await writeFile("fixtures/stage5c/copilot-baseline.json", JSON.stringify({ schemaVersion: 1, date: "2026-10-01", provider: "GitHub Copilot (existing authenticated account)", model: "gpt-6.1-sol",
  promptHash: corpus.copilotPromptHash, inputHash, repeats: 1, samples: 21, results, cost: "Not exposed by the existing Describer; unavailable, not zero.",
  evidence: "Actual unmodified Describer: 9 existing Eval cases + 12 browser/e-commerce cases with the frozen legacy context adapter. Invalid empty-context trial excluded, not silently counted." }, null, 2) + "\n");
console.log(JSON.stringify({ samples: 21, passed: 21, inputHash }));
