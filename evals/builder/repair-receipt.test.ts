import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import { AutomationPlanSchema } from "../../common/automation";
import { AUTOMATION_BUILDER_PROMPT_VERSION } from "../../electron/automationbuilder/instructions";
import { NATIVE_TOOL_POLICY_VERSION, nativeToolPlanIssues } from "../../electron/automationbuilder/native-tool-policy";
import { BUILDER_SCORER_VERSION, scoreBuilder } from "./score";
import { builderScenarios } from "./scenarios";

const repository = new URL("../../", import.meta.url);
const read = (file: string) => readFileSync(new URL(file, repository), "utf8");
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const receipt = JSON.parse(read("fixtures/legacy-builder/repair-eval.json"));

test("repair evidence binds current sources/corpus and preserves incomplete real-model status", () => {
  assert.equal(receipt.currentImplementation.promptVersion, AUTOMATION_BUILDER_PROMPT_VERSION);
  assert.equal(receipt.currentImplementation.policyVersion, NATIVE_TOOL_POLICY_VERSION);
  assert.equal(receipt.currentImplementation.scorerVersion, BUILDER_SCORER_VERSION);
  assert.equal(receipt.currentImplementation.scenarioHash, hash(JSON.stringify(builderScenarios)));
  for (const [file, expected] of Object.entries(receipt.currentImplementation.sourceHashes)) {
    assert.equal(hash(read(file).replace(/\r\n/g, "\n")), expected, file);
  }
  assert.equal(receipt.status, "implemented-real-eval-incomplete");
  assert.equal(receipt.currentImplementation.realFullTrialsAtTheseVersions, 0);
  assert.equal(receipt.baseline.originalPassing, 5);
  assert.equal(receipt.describer.passing, 9);
  assert.match(receipt.cost, /unavailable, not zero/);
  const frozen = receipt.attempts.filter((a: { kind: string }) => a.kind === "quota-interrupted-frozen-trial");
  assert.equal(frozen.length, 2);
  for (const attempt of frozen) {
    assert.equal(attempt.originalPassing, 9);
    assert.equal(attempt.errors.length, 1);
    assert.equal(attempt.errors[0].id, "lead-to-crm");
    assert.match(attempt.errors[0].error, /monthly quota/);
  }
});

test("frozen Copilot snapshots remain internally consistent; current policy is reassessed separately", () => {
  assert.equal(receipt.frozenReassessmentPolicyVersion, "legacy-native-tools.5");
  assert.equal(receipt.latestReassessment.policyVersion, NATIVE_TOOL_POLICY_VERSION);
  const latestCounts: number[] = [];
  const changed: { attemptIndex: number; id: string; wasPassing: boolean; nowPassing: boolean }[] = [];
  for (const [attemptIndex, attempt] of receipt.attempts.entries()) {
    const serialized = read(attempt.file);
    assert.doesNotMatch(serialized, /sr-builder-evals-|Request ID:|nxbw7|TK008B-BR|api[_-]?key\s*[=:]/i);
    const data = JSON.parse(serialized);
    assert.deepEqual(data.cases.map((c: { id: string }) => c.id), builderScenarios.map((s) => s.id));
    assert.equal(data.metadata.model, "gpt-6.1-sol");
    assert.equal(data.metadata.scenarioHash, receipt.currentImplementation.scenarioHash);
    assert.equal(data.originalPassing, attempt.originalPassing);
    assert.equal(data.currentPassing, attempt.currentPassing);
    let latestPassing = 0;
    for (const c of data.cases) {
      if (!c.plan) {
        assert.equal(c.originalOk, false);
        assert.equal(c.currentOk, false);
        assert.match(c.error, /monthly quota/);
        continue;
      }
      const plan = AutomationPlanSchema.parse(c.plan);
      const scenario = builderScenarios.find((s) => s.id === c.id)!;
      const score = scoreBuilder(plan.steps.map((s) => `${s.label}\n${s.prompt}`).join("\n\n"), scenario.rubric);
      const issues = nativeToolPlanIssues(plan, scenario.analysis);
      assert.deepEqual(JSON.parse(JSON.stringify(score)), c.currentScore);
      assert.equal(c.currentOk, c.currentScore.pass && c.currentPlanIssues.length === 0);
      const nowPassing = score.pass && issues.length === 0;
      if (nowPassing) latestPassing++;
      if (nowPassing !== c.currentOk) changed.push({ attemptIndex, id: c.id, wasPassing: c.currentOk, nowPassing });
    }
    latestCounts.push(latestPassing);
  }
  assert.deepEqual(latestCounts, receipt.latestReassessment.passingByAttempt);
  assert.deepEqual(changed, receipt.latestReassessment.changedHistoricalCases);
});
