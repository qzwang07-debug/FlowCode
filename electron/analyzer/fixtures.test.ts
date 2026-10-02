import assert from "node:assert/strict";
import test from "node:test";
import { browserAnalysisCases } from "../../evals/analyzer/scenarios";
import { AutomationBlueprintV2Schema } from "../../common/blueprint-v2";
import { readBlueprintDocument, contractHash } from "../evidence/blueprint-contract";
import { readFile } from "node:fs/promises";
import { ProviderSettingsSchema } from "../../common/analyzer";
import { applyBlueprintEdit, validateCandidate, generationPreflight } from "./review";
import { nextReviewVersion } from "./revision-store";
test("12 frozen browser/e-commerce contracts cover all three sources without a model", () => {
  assert.equal(browserAnalysisCases.length, 12);
  assert.deepEqual(new Set(browserAnalysisCases.map(c => c.provider)), new Set(["chrome", "edge", "ziniao"]));
  for (const c of browserAnalysisCases) {
    assert.deepEqual(AutomationBlueprintV2Schema.parse(c.blueprint), c.blueprint);
    readBlueprintDocument(c.blueprint);
    validateCandidate(c.blueprint, nextReviewVersion(c.blueprint));
    assert.ok(generationPreflight(c.blueprint).reviewable);
    const manual = applyBlueprintEdit(c.blueprint, { kind: "manual", stepId: c.blueprint.steps[0]!.id, description: "Human completes this step" });
    assert.deepEqual(manual.assertions, c.blueprint.assertions);
  }
});

test("published real migration receipt covers every frozen case and has no private configuration", async () => {
  const read = async (name: string) => JSON.parse(await readFile(new URL(`../../fixtures/stage5c/${name}`, import.meta.url), "utf8"));
  const report = await read("model-eval.json"), policy = await read("migration-policy.json"), provider = ProviderSettingsSchema.parse(await read("reviewed-provider.json"));
  assert.equal(report.samples, 21); assert.equal(report.results.length, 21); assert.equal(report.gate, true);
  assert.equal(policy.settingsHash, contractHash(provider)); assert.equal(policy.inputHash, report.inputHash);
  for (const r of report.results) {
    assert.equal(r.opencode.run.phase, "review-ready");
    assert.ok(r.opencode.score.score >= r.copilot.score.score);
    assert.ok(r.opencode.score.checks.every((c: { pass: boolean }) => c.pass));
    assert.ok(r.opencode.schema && r.opencode.references && r.opencode.assertionsPreserved && r.opencode.evidenceGrounded && !r.opencode.leakage);
  }
  assert.equal(report.preInferenceBudgetOnlyContinuations, 1);
  const prior = report.results.find((r: { id: string }) => r.id === "chrome-secret-binding").preInferenceBudgetRejections[0];
  assert.equal(prior.inputTokens, undefined); assert.equal(prior.outputTokens, undefined); assert.equal(prior.costUsd, undefined);
  assert.ok(report.cost.cumulativeAuthorization.accountedUsd * 8 <= 20);
  assert.ok(!/sk-[A-Za-z0-9_-]{20,}|Bearer |devtools\/browser|C:\\\\Users\\\\/.test(JSON.stringify({ report, provider })));
});
