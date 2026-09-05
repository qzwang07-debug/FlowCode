import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { AutomationBlueprintV2Schema } from "./blueprint-v2";
import { fixtureBlueprintV2 } from "../scripts/stage5a/contract-fixtures";
import {
  blueprintHash,
  migrateBlueprintV1,
  readBlueprintDocument,
  sealBlueprint,
} from "../electron/evidence/blueprint-contract";
import {
  confirmationMatches,
  createConfirmationBinding,
} from "../electron/evidence/confirmation";

test("v2 expresses ordered assertions, frames, popup results, data bindings and manual steps", () => {
  const bp = fixtureBlueprintV2();
  assert.deepEqual(
    AutomationBlueprintV2Schema.parse(JSON.parse(JSON.stringify(bp))),
    bp,
  );
  assert.equal(bp.assertions[0].afterStepId, "submit");
  assert.equal(bp.assertions[0].beforeStepId, "navigate-result");
  assert.equal(bp.frames[0].locatorChain[0].kind, "test-id");
  assert.equal(bp.results[0].triggerStepId, "open-popup");
});

test("v2 rejects dangling, cross-owner, future variable and lifecycle references", () => {
  const mutations: Array<(bp: ReturnType<typeof fixtureBlueprintV2>) => void> =
    [
      (bp) => {
        bp.steps[0].pageRef = "absent";
      },
      (bp) => {
        bp.steps[0].frameRef = "absent";
      },
      (bp) => {
        bp.frames[0].pageRef = "popup";
      },
      (bp) => {
        bp.steps[0].input = { kind: "variable", variableRef: "absent" };
      },
      (bp) => {
        bp.steps[0].input = { kind: "variable", variableRef: "order-id" };
      },
      (bp) => {
        bp.steps[0].evidenceRefs = ["absent"];
      },
      (bp) => {
        bp.evidenceRefs[0].sessionId = "other";
      },
      (bp) => {
        bp.assertions[0].afterStepId = "absent";
      },
      (bp) => {
        bp.assertions[0].beforeStepId = "fill-name";
      },
      (bp) => {
        bp.results[0].triggerStepId = "absent";
      },
      (bp) => {
        bp.pages[1].openedByResultRef = "absent";
      },
      (bp) => {
        delete bp.pages[1].closedByStepId;
      },
      (bp) => {
        bp.steps[0].pageRef = "popup";
      },
      (bp) => {
        bp.steps[0].id = bp.steps[1].id;
      },
      (bp) => {
        bp.assertions[0].source = "ai-suggestion";
      },
    ];
  for (const mutate of mutations) {
    const bp = fixtureBlueprintV2();
    mutate(bp);
    assert.equal(
      AutomationBlueprintV2Schema.safeParse(bp).success,
      false,
      mutate.toString(),
    );
  }
});

test("content hash is canonical and detects tampering independently of structural validity", () => {
  const bp = sealBlueprint(fixtureBlueprintV2());
  const reordered = Object.fromEntries(Object.entries(bp).reverse());
  assert.equal(blueprintHash(reordered as typeof bp), bp.contentHash);
  assert.deepEqual(readBlueprintDocument(bp), bp);
  assert.throws(
    () => readBlueprintDocument({ ...bp, intent: "changed" }),
    /hash/i,
  );
});

test("legacy fixture remains readable and migration never invents missing execution context", async () => {
  const raw = await readFile(
    new URL("../fixtures/stage5a/blueprint-v1.json", import.meta.url),
    "utf8",
  );
  const source = JSON.parse(raw);
  assert.deepEqual(readBlueprintDocument(source), source);
  const migrated = migrateBlueprintV1(source, {
    sessionId: "legacy-session",
    evidenceVersion: 1,
    evidenceHash: "a".repeat(64),
    review: {
      schemaVersion: 1,
      sessionId: "legacy-session",
      revision: 2,
      updatedAt: 1000,
      projectKind: "web-test",
      intent: source.intent,
      variables: [],
      privacyReviewed: true,
      assertions: [
        {
          id: "success",
          markerEventId: "evt-success",
          note: "Success",
          stepId: "submit",
          matcher: "toBeVisible",
          confirmed: true,
        },
      ],
    },
  });
  assert.equal(migrated.assertions[0].afterStepId, "submit");
  assert.equal(migrated.assertions[0].contextStatus, "unresolved");
  assert.equal(migrated.pages.length, 0);
  assert.ok(migrated.gaps.length > 0);
  assert.equal(JSON.stringify(source), JSON.stringify(JSON.parse(raw)));
  assert.throws(() =>
    migrateBlueprintV1(source, {
      sessionId: "other",
      evidenceVersion: 1,
      evidenceHash: "a".repeat(64),
      review: { ...{ schemaVersion: 1 }, sessionId: "legacy-session" } as never,
    }),
  );
});

test("confirmation binds blueprint, parameters, plan, target, environment and code", () => {
  const bp = sealBlueprint(fixtureBlueprintV2());
  const input = {
    blueprint: bp,
    projectId: "project",
    targetId: "target",
    environmentProfileId: "env",
    environmentHash: "e".repeat(64),
    codeHash: "b".repeat(64),
    planHash: "c".repeat(64),
    parameters: {
      customer: {
        kind: "value" as const,
        type: "string" as const,
        value: "Fixture",
      },
    },
  };
  const binding = createConfirmationBinding(input);
  assert.equal(confirmationMatches(binding, input), true);
  for (const change of [
    { blueprint: sealBlueprint({ ...bp, revision: 2 }) },
    { targetId: "other" },
    { codeHash: "d".repeat(64) },
    { planHash: "f".repeat(64) },
    { environmentHash: "f".repeat(64) },
    { parameters: {} },
    {
      blueprint: sealBlueprint({
        ...bp,
        assertions: bp.assertions.map((a) => ({ ...a, matcher: "toHaveText" })),
      }),
    },
  ])
    assert.equal(confirmationMatches(binding, { ...input, ...change }), false);
});
