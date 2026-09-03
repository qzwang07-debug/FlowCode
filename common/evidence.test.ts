import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  FlowEventSchema,
  normalizeStoredFlowEvent,
} from "./evidence";

test("new FlowEvents round-trip and legacy events remain readable", () => {
  const current = FlowEventSchema.parse({
    schemaVersion: 1,
    eventId: "event-current",
    sessionId: "session-one",
    sourceId: "clipboard",
    source: "desktop",
    seq: 4,
    epochMs: 1_400,
    monotonicMs: 400,
    type: "clipboard.change",
    payload: { hash: "abcdef0123456789", length: 4, formats: ["text/plain"] },
    privacyTags: ["clipboard-preview"],
  });
  assert.deepEqual(
    normalizeStoredFlowEvent(current, {
      sessionId: "session-one",
      startedAt: 1_000,
    }),
    current,
  );

  const legacy = {
    seq: 2,
    t: 250,
    epoch: 1_250,
    type: "marker",
    source: "user",
    payload: { note: "The banner is visible" },
  };
  const normalized = normalizeStoredFlowEvent(legacy, {
    sessionId: "session-one",
    startedAt: 1_000,
  });
  assert.equal(normalized.schemaVersion, 1);
  assert.equal(normalized.sessionId, "session-one");
  assert.equal(normalized.source, "user");
  assert.equal(normalized.sourceId, "user");
  assert.equal(normalized.epochMs, 1_250);
  assert.equal(normalized.monotonicMs, 250);
  assert.match(normalized.eventId, /^legacy-/);
});

test("malformed legacy and current events fail closed", () => {
  assert.throws(() =>
    normalizeStoredFlowEvent(
      {
        schemaVersion: 1,
        eventId: "event-bad",
        sessionId: "another-session",
        sourceId: "desktop",
        source: "desktop",
        seq: 0,
        epochMs: 1,
        type: "marker",
        payload: {},
      },
      { sessionId: "session-one", startedAt: 0 },
    ),
  );
  assert.throws(() =>
    normalizeStoredFlowEvent(
      { seq: -1, t: 0, epoch: 0, type: "marker", source: "user", payload: {} },
      { sessionId: "session-one", startedAt: 0 },
    ),
  );
});

test("Stage 4 evidence review stays wired through the safe IPC surface", async () => {
  const [ipc, preload, main, controls, studio] = await Promise.all([
    readFile("common/ipc.ts", "utf8"),
    readFile("electron/preload.cjs", "utf8"),
    readFile("electron/main.ts", "utf8"),
    readFile("src/RecordingControls.tsx", "utf8"),
    readFile("src/projects/ProjectStudio.tsx", "utf8"),
  ]);
  for (const source of [ipc, preload]) {
    assert.match(source, /evidence:review-get/);
    assert.match(source, /evidence:review-update/);
    assert.match(source, /evidence:blueprint-export/);
  }
  assert.match(main, /registerEvidenceIpc/);
  assert.match(controls, /Add expected result/);
  assert.match(studio, /EvidenceReview/);
});
