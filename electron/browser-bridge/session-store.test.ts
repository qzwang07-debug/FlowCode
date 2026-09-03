import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  BrowserCaptureSummarySchema,
  type BrowserSemanticEvent,
} from "../../common/browser";
import { BrowserSessionStore } from "./session-store";

function event(sequence: number): BrowserSemanticEvent {
  return {
    schemaVersion: 1,
    eventId: `event-${sequence}`,
    sessionId: "session-1",
    sourceId: "chrome-source",
    source: "browser",
    seq: sequence,
    epochMs: 1000 + sequence,
    type: "browser.navigate",
    payload: {
      tabId: 1,
      frameId: 0,
      documentId: "document-1",
      url: "https://example.test/",
      navigationKind: "document",
    },
  };
}

test("browser sessions persist ordered events, deduplicate retries, and record sequence gaps", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "flowcode-browser-session-"));
  const sessionDirectory = path.join(root, "session-1");
  await mkdir(sessionDirectory);
  try {
    const store = await BrowserSessionStore.create(
      "session-1",
      1000,
      sessionDirectory,
    );
    assert.equal(await store.appendEvent("chrome", event(8)), "written");
    assert.equal(await store.appendEvent("chrome", event(8)), "duplicate");
    assert.equal(await store.appendEvent("chrome", event(10)), "written");
    store.markFlushed("chrome", "chrome-source", 0);
    const summary = await store.finalize(2000);
    assert.deepEqual(BrowserCaptureSummarySchema.parse(summary), summary);
    assert.equal(summary.eventCount, 2);
    assert.equal(summary.gapCount, 1);
    assert.equal(summary.degraded, true);
    const events = (await readFile(store.eventPath, "utf8")).trim().split("\n");
    assert.equal(events.length, 2);
    const gaps = (await readFile(store.gapPath, "utf8")).trim().split("\n");
    assert.equal(gaps.length, 1);
    assert.deepEqual(JSON.parse(gaps[0]) as unknown, {
      schemaVersion: 1,
      gapId: JSON.parse(gaps[0]).gapId as string,
      sessionId: "session-1",
      browser: "chrome",
      sourceId: "chrome-source",
      epochMs: 1010,
      reason: "sequence-gap",
      fromSequence: 9,
      toSequence: 9,
      droppedEvents: 1,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a session with no connected browser is finalized as degraded", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "flowcode-browser-empty-"));
  try {
    const store = await BrowserSessionStore.create("session-empty", 1, root);
    const summary = await store.finalize(2);
    assert.equal(summary.degraded, true);
    assert.deepEqual(summary.sources, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
