import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import { AutomationPlanSchema } from "../../common/automation";
import { AUTOMATION_BUILDER_INSTRUCTIONS, AUTOMATION_BUILDER_PROMPT_VERSION } from "../../electron/automationbuilder/instructions";
import { NATIVE_TOOL_POLICY_VERSION, nativeToolPlanIssues } from "../../electron/automationbuilder/native-tool-policy";
import { requireCatalogue } from "../../electron/architectures/catalogue-registry";
import { builderScenarios } from "./scenarios";
import { BUILDER_SCORER_VERSION, scoreBuilder } from "./score";

const repository = new URL("../../", import.meta.url);
const read = (file: string) => readFileSync(new URL(file, repository), "utf8");
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const evidenceText = read("fixtures/legacy-builder/codex-acceptance-2026-10-01.json");
const evidence = JSON.parse(evidenceText);
const usage = JSON.parse(read("fixtures/legacy-builder/codex-usage-2026-10-01.json"));

test("Codex acceptance is two complete fixed-corpus rounds bound to current production inputs", () => {
  assert.equal(evidence.status, "complete");
  assert.equal(evidence.provider, "codex-chatgpt-subscription");
  assert.equal(evidence.authMethod, "chatgpt");
  assert.equal(evidence.requestedModel, "gpt-6-sol");
  assert.equal(evidence.requestedEffort, "medium");
  assert.equal(evidence.promptVersion, AUTOMATION_BUILDER_PROMPT_VERSION);
  assert.equal(evidence.policyVersion, NATIVE_TOOL_POLICY_VERSION);
  assert.equal(evidence.scorerVersion, BUILDER_SCORER_VERSION);
  assert.equal(evidence.scenarioHash, hash(JSON.stringify(builderScenarios)));
  const catalogue = requireCatalogue("scout", "automation");
  assert.equal(evidence.catalogueVersion, catalogue.version);
  assert.equal(evidence.systemPromptHash, hash(`${AUTOMATION_BUILDER_INSTRUCTIONS}\n\n${catalogue.content}`.trim()));
  for (const [file, expected] of Object.entries(evidence.sourceHashes)) {
    assert.equal(hash(read(file).replace(/\r\n/g, "\n")), expected, file);
  }
  assert.deepEqual(evidence.scenarioIds, builderScenarios.map((scenario) => scenario.id));
  assert.equal(evidence.roundsRequested, 2);
  assert.deepEqual(evidence.results.map((result: { round: number; id: string }) => `${result.round}:${result.id}`),
    [1, 2].flatMap((round) => builderScenarios.map((scenario) => `${round}:${scenario.id}`)));
  assert.equal(evidence.cost, null);
  assert.equal(evidence.costStatus, "unavailable");
});

test("all twenty real turns used production handlers; rejections and model usage remain visible", () => {
  let rejectedCount = 0;
  for (const result of evidence.results) {
    const scenario = builderScenarios.find((item) => item.id === result.id)!;
    const plan = AutomationPlanSchema.parse(result.plan);
    assert.equal(result.status, "pass", `${result.round}:${result.id}`);
    assert.equal(result.ok, true);
    assert.equal(result.turnStatus, "completed");
    assert.equal(result.model, "gpt-6-sol");
    assert.equal(result.modelProvider, "openai");
    assert.equal(result.analysisRead, true);
    assert.deepEqual(result.unexpectedTools, []);
    assert.ok(result.durationMs > 0 && result.durationMs <= 180_000);
    assert.match(result.exportSha256, /^[a-f0-9]{64}$/);
    const names = result.toolTrace.map((call: { name: string }) => call.name);
    assert.equal(names[0], "get_analysis");
    assert.ok(names.includes("get_timeline"));
    assert.equal(names.at(-1), "propose_automation_plan");
    assert.equal(result.toolTrace.at(-1).success, true);
    const rejected = result.toolTrace.filter((call: { name: string; success: boolean }) =>
      call.name === "propose_automation_plan" && !call.success);
    assert.equal(rejected.length, result.rejectedProposals.length);
    rejectedCount += rejected.length;
    const score = scoreBuilder(plan.steps.map((step) => `${step.label}\n${step.prompt}`).join("\n\n"), scenario.rubric);
    assert.deepEqual(JSON.parse(JSON.stringify(score)), result.score);
    assert.equal(score.pass, true);
    assert.deepEqual(nativeToolPlanIssues(plan, scenario.analysis), []);
  }
  assert.equal(rejectedCount, 5);
});

test("per-thread total usage is derived from matching local Codex rollouts, not last-call counts", () => {
  assert.equal(usage.sourceEvidenceSha256, hash(evidenceText));
  assert.equal(usage.results.length, evidence.results.length);
  for (const [index, item] of usage.results.entries()) {
    const result = evidence.results[index];
    assert.equal(item.round, result.round);
    assert.equal(item.id, result.id);
    assert.equal(item.threadId, result.threadId);
    assert.match(item.rolloutSha256, /^[a-f0-9]{64}$/);
    assert.equal(item.lastTokenUsage.total_tokens, result.tokenUsage.totalTokens);
    assert.ok(item.totalTokenUsage.total_tokens >= item.lastTokenUsage.total_tokens);
    assert.ok(item.totalTokenUsage.input_tokens > 0);
  }
  assert.ok(usage.results.some((item: { totalTokenUsage: { total_tokens: number }; lastTokenUsage: { total_tokens: number } }) =>
    item.totalTokenUsage.total_tokens > item.lastTokenUsage.total_tokens));
});

test("interrupted development attempt is retained without being counted as final acceptance", () => {
  const text = read("fixtures/legacy-builder/codex-development-interrupted.json");
  const attempt = JSON.parse(text);
  assert.equal(attempt.status, "interrupted-after-new-policy-defect");
  assert.equal(attempt.results.length, 7);
  assert.equal(attempt.promptVersion, "legacy-automation.6");
  assert.equal(attempt.policyVersion, "legacy-native-tools.6");
  for (const fixture of [text, evidenceText, read("fixtures/legacy-builder/codex-usage-2026-10-01.json")]) {
    assert.doesNotMatch(fixture, /nxbw7|Request ID:|sr-builder-evals-|sk-[A-Za-z0-9]{10}|Bearer\s+\S+/i);
  }
});
