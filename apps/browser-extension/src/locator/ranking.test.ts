import assert from "node:assert/strict";
import test from "node:test";

import { isStableDomId, rankLocatorCandidates } from "./ranking";

test("locator candidates prefer unique accessible selectors and retain fallbacks", () => {
  const candidates = rankLocatorCandidates([
    { kind: "css", value: "main > button:nth-of-type(2)", unique: true },
    { kind: "text", value: "Submit", unique: false },
    { kind: "role", value: "button|Submit", unique: true },
    { kind: "test-id", value: "submit-order", unique: true },
    { kind: "role", value: "button|Submit", unique: true },
  ]);
  assert.deepEqual(
    candidates.map(({ kind, score }) => [kind, score]),
    [
      ["role", 100],
      ["test-id", 90],
      ["css", 30],
      ["text", 35],
    ].sort((left, right) => Number(right[1]) - Number(left[1])),
  );
  assert.equal(
    candidates.filter((candidate) => candidate.kind === "role").length,
    1,
  );
});

test("generated and random-looking DOM ids are not treated as stable", () => {
  assert.equal(isStableDomId("submit-order"), true);
  assert.equal(isStableDomId("123456789"), false);
  assert.equal(isStableDomId("550e8400-e29b-41d4-a716-446655440000"), false);
  assert.equal(isStableDomId("react-129834"), false);
  assert.equal(isStableDomId("a7f312cc98b441ff"), false);
});
