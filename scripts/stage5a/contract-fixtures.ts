import type {
  AutomationBlueprintV2,
  BlueprintStepV2,
} from "../../common/blueprint-v2";

/** Independently authored full executable example, not the illustrative design snippet. */
export function fixtureBlueprintV2(): AutomationBlueprintV2 {
  const step = (
    id: string,
    action: BlueprintStepV2["action"],
    extra: Partial<BlueprintStepV2> = {},
  ): BlueprintStepV2 => ({
    id,
    action,
    description: `Fixture ${id}`,
    handling: "automatic",
    contextStatus: "resolved",
    pageRef: "main",
    outputs: [],
    evidenceRefs: ["event"],
    ...extra,
  });
  return {
    schemaVersion: 2,
    id: "fixture-order",
    revision: 1,
    contentHash: "0".repeat(64),
    source: {
      sessionId: "fixture-session",
      sessionSchemaVersion: 2,
      eventSchemaVersion: 1,
      evidenceVersion: 1,
      evidenceHash: "a".repeat(64),
    },
    projectKind: "web-test",
    intent:
      "Submit, assert success before navigation, inspect a popup and pass an extracted identifier to a later input.",
    pages: [
      { id: "main", kind: "existing" },
      {
        id: "popup",
        kind: "popup",
        openedByResultRef: "popup-opened",
        closedByStepId: "close-popup",
      },
    ],
    frames: [
      {
        id: "order-frame",
        pageRef: "main",
        locatorChain: [{ kind: "test-id", value: "order-frame" }],
      },
    ],
    preconditions: [
      {
        id: "local-fixture",
        kind: "environment",
        description: "Use an authorized local test environment.",
      },
    ],
    variables: [
      {
        id: "customer",
        name: "Customer",
        type: "string",
        source: "runtime",
        required: true,
        sensitive: false,
      },
      {
        id: "order-id",
        name: "Order ID",
        type: "string",
        source: "derived",
        required: true,
        sensitive: false,
        producer: { stepId: "extract-id", outputRef: "identifier" },
      },
      {
        id: "upload-file",
        name: "Upload file",
        type: "file",
        source: "runtime",
        required: true,
        sensitive: false,
      },
    ],
    steps: [
      step("fill-name", "fill", {
        frameRef: "order-frame",
        target: { kind: "label", value: "Customer" },
        input: { kind: "variable", variableRef: "customer" },
      }),
      step("submit", "submit", {
        target: { kind: "test-id", value: "fixture-form" },
      }),
      step("navigate-result", "navigate", { urlPattern: "/fixture/result" }),
      step("open-popup", "click", {
        target: { kind: "role", role: "button", name: "Details" },
      }),
      step("extract-id", "extract", {
        pageRef: "popup",
        outputs: [
          {
            id: "identifier",
            kind: "text",
            variableRef: "order-id",
            target: { kind: "test-id", value: "order-id" },
          },
        ],
      }),
      step("fill-reference", "fill", {
        target: { kind: "label", value: "Reference" },
        input: { kind: "variable", variableRef: "order-id" },
      }),
      step("upload", "upload", {
        target: { kind: "label", value: "Attachment" },
        input: { kind: "variable", variableRef: "upload-file" },
      }),
      step("inspect", "manual", {
        handling: "manual",
        description: "Ask the user to inspect the local fixture result.",
      }),
    ],
    cleanup: [step("close-popup", "close-page", { pageRef: "popup" })],
    assertions: [
      {
        id: "success",
        source: "user-marker",
        matcher: "toContainText",
        expected: { kind: "literal", value: "Success" },
        target: { kind: "role", role: "status" },
        confirmed: true,
        contextStatus: "resolved",
        afterStepId: "submit",
        beforeStepId: "navigate-result",
        pageRef: "main",
        wait: {
          kind: "locator",
          target: { kind: "role", role: "status" },
          state: "visible",
          timeoutMs: 5000,
        },
        evidenceRefs: ["event"],
      },
    ],
    results: [
      {
        id: "popup-opened",
        kind: "popup",
        triggerStepId: "open-popup",
        pageRef: "popup",
        evidenceRef: "event",
      },
    ],
    evidenceRefs: [
      {
        id: "event",
        kind: "event",
        reference: "fixture-event",
        sessionId: "fixture-session",
        evidenceVersion: 1,
      },
    ],
    gaps: [],
    privacy: {
      containsSensitiveData: false,
      redactions: [],
      userReviewed: true,
    },
  };
}
