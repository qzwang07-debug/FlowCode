import assert from "node:assert/strict";
import test from "node:test";

import { AutomationBlueprintSchema } from "../../common/blueprint";
import type { BrowserSemanticEvent } from "../../common/browser";
import type { FlowEvent } from "../../common/evidence";
import type { SessionMetaV2 } from "../../common/session";
import {
  buildDeterministicBlueprint,
  createBlueprintReview,
} from "./blueprint-builder";
import { fuseEvidence } from "./fusion";

const session: SessionMetaV2 = {
  schemaVersion: 2,
  eventSchemaVersion: 1,
  startedAtMonotonicMs: 10_000,
  id: "blueprint-session",
  startedAt: 10_000,
  stoppedAt: 20_000,
  platform: "win32",
  appVersion: "0.5.0",
  link: {
    projectId: "project-one",
    mode: "analyze-and-build",
    browserEnhancement: "semantic",
  },
};

const commonPayload = {
  tabId: 1,
  frameId: 0,
  documentId: "doc-one",
  url: "https://example.test/login",
};
const passwordTarget = {
  tag: "input",
  role: "textbox",
  name: "Password",
  inputType: "password",
};
const locators = [
  { kind: "role" as const, value: "textbox|Password", unique: true, score: 100 },
];

function browserEvent(
  eventId: string,
  seq: number,
  epochMs: number,
  type: BrowserSemanticEvent["type"],
  payload: BrowserSemanticEvent["payload"],
): BrowserSemanticEvent {
  return {
    schemaVersion: 1,
    eventId,
    sessionId: session.id,
    sourceId: "edge-source",
    source: "browser",
    seq,
    epochMs,
    monotonicMs: epochMs,
    type,
    payload,
  } as BrowserSemanticEvent;
}

test("the deterministic builder produces variables, evidence, and marker assertions", () => {
  const navigate = browserEvent("navigate", 0, 11_000, "browser.navigate", {
    ...commonPayload,
    navigationKind: "document",
  });
  const fill = browserEvent("fill-password", 1, 12_000, "browser.fill", {
    ...commonPayload,
    target: passwordTarget,
    locators,
    value: { kind: "redacted", length: 12, reason: "password" },
  });
  const click = browserEvent("click-login", 2, 13_000, "browser.click", {
    ...commonPayload,
    target: { tag: "button", role: "button", name: "Sign in" },
    locators: [
      { kind: "role", value: "button|Sign in", unique: true, score: 100 },
    ],
    button: 0,
    modifiers: [],
  });
  const marker: FlowEvent = {
    schemaVersion: 1,
    eventId: "assert-success",
    sessionId: session.id,
    sourceId: "user",
    source: "user",
    seq: 3,
    epochMs: 13_100,
    monotonicMs: 3_100,
    type: "assertion.marker",
    payload: { markerId: "marker-success", note: "Dashboard is visible" },
  };
  const evidence = fuseEvidence({
    session,
    desktopEvents: [marker],
    browserEvents: [navigate, fill, click],
    clockSamples: [],
    gaps: [],
    frames: [{ file: "frames/assert-success.jpg", epochMs: 13_110 }],
  });

  const review = createBlueprintReview(session, "web-test", evidence);
  const blueprint = buildDeterministicBlueprint(session, evidence, review);

  assert.deepEqual(AutomationBlueprintSchema.parse(blueprint), blueprint);
  assert.equal(blueprint.steps.length, 3);
  assert.equal(blueprint.variables[0]?.type, "secret");
  assert.equal(blueprint.variables[0]?.sensitive, true);
  assert.equal(blueprint.variables[0]?.defaultValue, undefined);
  assert.equal(blueprint.assertions[0]?.source, "user-marker");
  assert.equal(blueprint.assertions[0]?.confirmed, false);
  assert.deepEqual(blueprint.assertions[0]?.target, {
    kind: "role",
    role: "button",
    name: "Sign in",
  });
  assert.ok(
    blueprint.assertions[0]?.evidenceRefs.some((id) =>
      blueprint.evidenceRefs.some(
        (ref) => ref.id === id && ref.kind === "screenshot",
      ),
    ),
  );

  review.intent = "Sign in and verify the dashboard.";
  review.assertions[0].confirmed = true;
  review.assertions[0].matcher = "toBeVisible";
  review.privacyReviewed = true;
  const revised = buildDeterministicBlueprint(session, evidence, review);
  assert.equal(revised.intent, review.intent);
  assert.equal(revised.assertions[0]?.confirmed, true);
  assert.equal(revised.privacy.userReviewed, true);
});
