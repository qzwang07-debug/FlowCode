import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import type { BrowserSemanticEvent } from "../../common/browser";
import type { FlowEvent } from "../../common/evidence";
import { EvidenceIndexSchema } from "../../common/evidence";
import type { SessionMetaV2 } from "../../common/session";
import { fuseEvidence } from "./fusion";

const session: SessionMetaV2 = {
  schemaVersion: 2,
  eventSchemaVersion: 1,
  startedAtMonotonicMs: 1_000,
  id: "session-one",
  startedAt: 1_000,
  stoppedAt: 3_000,
  platform: "win32",
  appVersion: "0.5.0",
  link: { mode: "analyze-only", browserEnhancement: "semantic" },
};

function desktop(
  eventId: string,
  seq: number,
  epochMs: number,
  type: string,
  payload: Record<string, unknown>,
): FlowEvent {
  return {
    schemaVersion: 1,
    eventId,
    sessionId: session.id,
    sourceId: "desktop",
    source: type === "assertion.marker" ? "user" : "desktop",
    seq,
    epochMs,
    monotonicMs: epochMs - session.startedAt,
    type,
    payload,
  };
}

function browser(
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
    sourceId: "chrome-source",
    source: "browser",
    seq,
    epochMs,
    monotonicMs: epochMs,
    type,
    payload,
  } as BrowserSemanticEvent;
}

const target = { tag: "input", role: "textbox", name: "Customer" };
const locators = [
  { kind: "role" as const, value: "textbox|Customer", unique: true, score: 100 },
];

test("fusion corrects clocks, preserves source order, deduplicates, and links causes", () => {
  const copied = "Acme";
  const clipboardHash = createHash("sha1")
    .update(copied)
    .digest("hex")
    .slice(0, 16);
  const click = browser("click", 1, 1_000, "browser.click", {
    tabId: 1,
    frameId: 0,
    documentId: "doc-one",
    url: "https://example.test/form",
    target: { tag: "button", role: "button", name: "Next" },
    locators: [
      { kind: "role", value: "button|Next", unique: true, score: 100 },
    ],
    button: 0,
    modifiers: [],
  });
  const navigate = browser("navigate", 2, 990, "browser.navigate", {
    tabId: 1,
    frameId: 0,
    documentId: "doc-two",
    url: "https://example.test/next",
    navigationKind: "document",
  });
  const document = browser("document", 3, 1_020, "browser.document", {
    tabId: 1,
    frameId: 0,
    documentId: "doc-two",
    url: "https://example.test/next",
    title: "Next",
  });
  const fill = browser("fill", 4, 1_080, "browser.fill", {
    tabId: 1,
    frameId: 0,
    documentId: "doc-two",
    url: "https://example.test/next",
    target,
    locators,
    value: { kind: "text", value: copied, length: copied.length, truncated: false },
  });
  const network: FlowEvent = {
    schemaVersion: 1,
    eventId: "network",
    sessionId: session.id,
    sourceId: "chrome-source",
    source: "browser",
    seq: 5,
    epochMs: 1_090,
    monotonicMs: 1_090,
    type: "browser.network",
    payload: { tabId: 1, method: "GET", status: 200, url: "https://example.test/api" },
  };

  const result = fuseEvidence({
    session,
    desktopEvents: [
      desktop("clipboard", 0, 1_170, "clipboard.change", {
        formats: ["text/plain"],
        length: copied.length,
        hash: clipboardHash,
        textPreview: copied,
      }),
      desktop("marker", 1, 1_210, "assertion.marker", {
        markerId: "marker-one",
        note: "The customer appears",
      }),
    ],
    browserEvents: [click, click, navigate, document, fill, network],
    clockSamples: [
      {
        schemaVersion: 1,
        sampleId: "clock-one",
        sessionId: session.id,
        browser: "chrome",
        sourceId: "chrome-source",
        nonce: "ping-one",
        desktopSentEpochMs: 1_080,
        desktopReceivedEpochMs: 1_120,
        sourceEpochMs: 1_000,
        sourceMonotonicMs: 1_000,
      },
    ],
    gaps: [],
    frames: [{ file: "frames/marker.jpg", epochMs: 1_212 }],
  });

  assert.deepEqual(EvidenceIndexSchema.parse(result.index), result.index);
  assert.equal(result.index.stats.duplicatesRemoved, 1);
  const browserEvents = result.events.filter(
    (event) => event.sourceId === "chrome-source",
  );
  assert.deepEqual(
    browserEvents.map((event) => event.seq),
    [1, 2, 3, 4, 5],
  );
  assert.ok(
    browserEvents.every(
      (event, index) =>
        index === 0 ||
        event.effectiveEpochMs > browserEvents[index - 1].effectiveEpochMs,
    ),
  );
  assert.ok(
    result.index.causalLinks.some(
      (link) => link.fromEventId === "click" && link.toEventId === "navigate",
    ),
  );
  assert.ok(
    result.index.causalLinks.some(
      (link) => link.fromEventId === "click" && link.toEventId === "document",
    ),
  );
  assert.ok(
    result.index.causalLinks.some(
      (link) => link.fromEventId === "fill" && link.toEventId === "network",
    ),
  );
  assert.ok(
    result.index.causalLinks.some(
      (link) =>
        link.kind === "clipboard-to-fill" &&
        link.fromEventId === "clipboard" &&
        link.toEventId === "fill",
    ),
  );
  const marker = result.index.timeline.find((item) => item.eventId === "marker");
  assert.deepEqual(marker?.screenshotRefs, ["frames/marker.jpg"]);
  assert.equal(marker?.relatedStepId, "step-0004");
});
