import assert from "node:assert/strict";
import test from "node:test";

import type { BrowserCaptureSummary } from "../common/browser";
import { BrowserCaptureCoordinator } from "./browser-capture-coordinator";

const summary = (sessionId: string): BrowserCaptureSummary => ({
  schemaVersion: 1,
  sessionId,
  startedAt: 1,
  completedAt: 2,
  eventCount: 0,
  gapCount: 0,
  degraded: false,
  sources: [],
});

test("each recording activates exactly one semantic capture channel", async () => {
  const calls: string[] = [];
  const standard = {
    async startSession(
      _sessionId: string,
      _sessionDir: string,
      _startedAt: number,
      browser?: "chrome" | "edge",
    ) {
      calls.push(`standard:${browser ?? "all"}`);
    },
    async stopSession(sessionId: string) {
      calls.push("standard:stop");
      return summary(sessionId);
    },
    async dispose() {},
  };
  const ziniao = {
    async startSession() {
      calls.push("ziniao:start");
    },
    async stopSession(sessionId: string) {
      calls.push("ziniao:stop");
      return summary(sessionId);
    },
    async dispose() {},
  };
  const coordinator = new BrowserCaptureCoordinator(standard, ziniao);
  await coordinator.startSession("one", "dir", 1, {
    provider: "ziniao",
    environmentProfileId: "env",
    preparationId: "prep",
    pageId: "page",
    allowAssociatedPopups: true,
  });
  await coordinator.stopSession("one");
  await coordinator.startSession("two", "dir", 1, { provider: "edge" });
  await coordinator.stopSession("two");
  assert.deepEqual(calls, [
    "ziniao:start",
    "ziniao:stop",
    "standard:edge",
    "standard:stop",
  ]);
});
