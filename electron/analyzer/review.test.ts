import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { sealBlueprint, contractHash } from "../evidence/blueprint-contract";
import { applyBlueprintEdit, validateCandidate, generationPreflight } from "./review";
import type { AutomationBlueprintV2 } from "../../common/blueprint-v2";

async function fixture(): Promise<AutomationBlueprintV2> {
  return JSON.parse(await readFile(new URL("../../fixtures/stage5a/blueprint-v2.json", import.meta.url), "utf8"));
}

test("step edits are derived, versioned and preserve assertion anchors", async () => {
  const base = await fixture();
  const hash = contractHash(base);
  const step = base.steps.find(s => s.action === "fill")!;
  const next = applyBlueprintEdit(base, { kind: "manual", stepId: step.id, description: "User performs this input" });
  assert.equal(next.revision, base.revision + 1);
  assert.deepEqual(next.parent, { revision: base.revision, contentHash: base.contentHash });
  assert.deepEqual(next.assertions, base.assertions);
  assert.equal(contractHash(base), hash);
  assert.equal(next.steps.find(s => s.id === step.id)?.handling, "manual");
  const anchored = base.assertions.find(a => a.afterStepId || a.beforeStepId)!;
  assert.throws(() => applyBlueprintEdit(base, { kind: "delete", stepId: anchored.afterStepId ?? anchored.beforeStepId! }));
});

test("merge inputs checks page/frame, dependencies and intervening actions", async () => {
  const bp = await fixture();
  const first = bp.steps.find(s => s.action === "fill")!;
  const index = bp.steps.indexOf(first);
  bp.steps.splice(index + 1, 0, { ...structuredClone(first), id: "repeat-input" });
  const base = sealBlueprint(bp);
  const next = applyBlueprintEdit(base, { kind: "merge-inputs", stepIds: [first.id, "repeat-input"] });
  assert.equal(next.steps.length, base.steps.length - 1);
  assert.ok(!next.steps.some(s => s.id === "repeat-input"));
  assert.throws(() => applyBlueprintEdit(base, { kind: "merge-inputs", stepIds: [first.id, base.steps.at(-1)!.id] }));
});

test("candidate boundary rejects fabricated provenance and confirmed assertions", async () => {
  const base = await fixture();
  const next = sealBlueprint({ ...structuredClone(base), revision: 2, parent: { revision: 1, contentHash: base.contentHash } });
  assert.doesNotThrow(() => validateCandidate(base, next));
  const foreign = structuredClone(next);
  foreign.source.sessionId = "another-store-session";
  assert.throws(() => validateCandidate(base, foreign));
  const lost = structuredClone(next);
  lost.assertions = lost.assertions.filter(a => !a.confirmed);
  assert.throws(() => validateCandidate(base, lost));
  const moved = structuredClone(next); moved.steps[0]!.contextStatus = "unresolved"; delete moved.steps[0]!.pageRef; delete moved.steps[0]!.frameRef;
  moved.steps[0]!.handling = "manual"; moved.gaps.push({ id: "moved-gap", ownerId: moved.steps[0]!.id, field: "context", reason: "Synthetic movement test" });
  assert.throws(() => validateCandidate(base, moved), /page\/frame binding/);
});

test("preflight separates schema, review and generation, with explicit blockers", async () => {
  const base = await fixture();
  const result = generationPreflight(base, { recordingGaps: 1, locatorStatus: {}, capabilities: null });
  assert.equal(result.schemaValid, true);
  assert.equal(result.reviewable, true);
  assert.equal(result.generationReady, false);
  assert.ok(result.todos.some(t => t.code === "recording-gap"));
  assert.ok(result.todos.some(t => t.code === "capability-unknown"));
  assert.ok(result.todos.some(t => t.code === "parameter-review"));
  assert.equal(generationPreflight({}).schemaValid, false);
  const badExpected = structuredClone(base);
  badExpected.assertions[0]!.matcher = "toHaveCount";
  badExpected.assertions[0]!.expected = { kind: "literal", value: "not-a-count" };
  const checks = generationPreflight(sealBlueprint(badExpected), { existingTarget: true });
  assert.ok(checks.todos.some(t => t.code === "assertion-expected-type"));
  assert.ok(checks.todos.some(t => t.code === "target-not-indexed"));
});
test("human assertion edits reset confirmation and revalidate both anchors", async () => {
  const base = await fixture(); const a = base.assertions[0]!;
  const changed = applyBlueprintEdit(base, { kind: "edit-assertion", assertionId: a.id, matcher: "toHaveURL",
    expected: { kind: "literal", value: "/fixture/result" }, pageRef: "main", afterStepId: "submit", beforeStepId: "navigate-result" });
  assert.equal(changed.assertions[0]!.confirmed, false);
  assert.equal(changed.assertions[0]!.source, "user-editor");
  assert.throws(() => applyBlueprintEdit(base, { kind: "edit-assertion", assertionId: a.id, matcher: "toBeVisible", pageRef: "main", afterStepId: "missing" }));
  assert.equal(base.assertions[0]!.confirmed, true);
  if (a.target) assert.doesNotThrow(() => applyBlueprintEdit(base, { kind: "edit-assertion", assertionId: a.id,
    matcher: "toBeVisible", target: a.target, pageRef: a.pageRef, afterStepId: a.afterStepId }));
});
