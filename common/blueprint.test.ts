import assert from "node:assert/strict";
import test from "node:test";

import { AutomationBlueprintSchema, BlueprintVariableSchema } from "./blueprint";

test("AutomationBlueprint survives a JSON round-trip", () => {
  const blueprint = {
    schemaVersion: 1,
    id: "blueprint-checkout",
    projectKind: "web-test",
    intent: "Submit an order and verify the success message.",
    preconditions: [
      {
        id: "authenticated",
        kind: "authentication",
        description: "The sales user is signed in.",
      },
    ],
    variables: [
      {
        id: "customer_name",
        name: "Customer name",
        type: "string",
        source: "runtime",
        required: true,
        sensitive: false,
      },
    ],
    steps: [
      {
        id: "step-submit",
        action: "click",
        description: "Submit the order.",
        target: { kind: "role", role: "button", name: "Submit" },
        evidenceRefs: ["event-submit"],
      },
    ],
    assertions: [
      {
        id: "assert-success",
        source: "user-marker",
        matcher: "toContainText",
        target: { kind: "role", role: "status" },
        expected: "Created successfully",
        confirmed: true,
        evidenceRefs: ["event-success"],
      },
    ],
    cleanup: [],
    evidenceRefs: [
      {
        id: "event-submit",
        kind: "event",
        reference: "evt_42",
      },
      {
        id: "event-success",
        kind: "event",
        reference: "evt_43",
      },
    ],
    privacy: {
      containsSensitiveData: false,
      redactions: [],
      userReviewed: true,
    },
  };

  assert.deepEqual(
    AutomationBlueprintSchema.parse(
      JSON.parse(JSON.stringify(blueprint)) as unknown,
    ),
    blueprint,
  );
});

test("AutomationBlueprint rejects duplicate ids and unconfirmed AI assertions", () => {
  const base = {
    schemaVersion: 1,
    id: "blueprint-one",
    projectKind: "web-test",
    intent: "Test the page.",
    preconditions: [],
    variables: [],
    steps: [
      {
        id: "same",
        action: "navigate",
        description: "Open the page.",
        evidenceRefs: [],
      },
      {
        id: "same",
        action: "click",
        description: "Click the button.",
        evidenceRefs: [],
      },
    ],
    assertions: [],
    cleanup: [],
    evidenceRefs: [],
    privacy: {
      containsSensitiveData: false,
      redactions: [],
      userReviewed: false,
    },
  };
  assert.equal(AutomationBlueprintSchema.safeParse(base).success, false);

  assert.equal(
    AutomationBlueprintSchema.safeParse({
      ...base,
      steps: [],
      assertions: [
        {
          id: "ai-assertion",
          source: "ai-suggestion",
          matcher: "toBeVisible",
          confirmed: true,
          evidenceRefs: [],
        },
      ],
    }).success,
    false,
  );
});

test("secret Blueprint variables cannot be downgraded or contain defaults", () => {
  const base = {
    id: "password",
    name: "Password",
    type: "secret",
    source: "environment",
    required: true,
    sensitive: true,
  };
  assert.equal(BlueprintVariableSchema.safeParse(base).success, true);
  assert.equal(
    BlueprintVariableSchema.safeParse({ ...base, sensitive: false }).success,
    false,
  );
  assert.equal(
    BlueprintVariableSchema.safeParse({ ...base, defaultValue: "secret" }).success,
    false,
  );
});
