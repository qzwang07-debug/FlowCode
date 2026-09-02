import assert from "node:assert/strict";
import test from "node:test";

import type { BrowserSemanticEvent } from "../../../../common/browser";
import { ReliableEventBuffer } from "./buffer";

function click(sequence: number): BrowserSemanticEvent {
  return {
    schemaVersion: 1,
    eventId: `event-${sequence}`,
    sessionId: "session-1",
    sourceId: "chrome-profile-1",
    source: "browser",
    seq: sequence,
    epochMs: 1000 + sequence,
    type: "browser.click",
    payload: {
      tabId: 1,
      frameId: 0,
      documentId: "document-1",
      url: "https://example.test/",
      target: { tag: "button", role: "button", name: "Save" },
      locators: [
        { kind: "role", value: "button|Save", unique: true, score: 100 },
      ],
      button: 0,
      modifiers: [],
    },
  };
}

test("the service-worker buffer is bounded, deduplicated, and acknowledged", () => {
  const buffer = new ReliableEventBuffer(2, 100_000);
  assert.equal(buffer.enqueue(click(0)).accepted, true);
  assert.equal(buffer.enqueue(click(0)).accepted, false);
  assert.equal(buffer.enqueue(click(1)).accepted, true);
  assert.deepEqual(buffer.enqueue(click(2)), { accepted: true, dropped: 1 });
  assert.deepEqual(
    buffer.pending().map((event) => event.seq),
    [1, 2],
  );
  assert.equal(buffer.droppedEvents, 1);
  assert.equal(buffer.acknowledge("session-1", "chrome-profile-1", 1), true);
  assert.deepEqual(
    buffer.pending().map((event) => event.seq),
    [2],
  );
  assert.equal(buffer.acknowledge("session-1", "other", 2), false);
});

test("restoring persisted state drops malformed events without throwing", () => {
  const buffer = new ReliableEventBuffer(4, 100_000);
  buffer.restore({ events: [click(3), { unsafe: true }], droppedEvents: 2 });
  assert.deepEqual(
    buffer.pending().map((event) => event.seq),
    [3],
  );
  assert.equal(buffer.droppedEvents, 3);
  const restored = new ReliableEventBuffer(4, 100_000);
  restored.restore(buffer.serialize());
  assert.deepEqual(
    restored.pending().map((event) => event.seq),
    [3],
  );
  assert.equal(restored.droppedEvents, 3);
});
