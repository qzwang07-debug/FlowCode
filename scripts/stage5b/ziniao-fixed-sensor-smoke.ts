import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { BrowserCaptureSummarySchema } from "../../common/browser";
import { createSessionMeta } from "../../common/session";
import { ZiniaoCaptureService } from "../../electron/ziniao/capture-service";
import { ZiniaoEnvironmentService } from "../../electron/ziniao/environment-service";
import { ZiniaoLeaseStore, ZiniaoProfileStore } from "../../electron/ziniao/profile-store";

const storeId = process.env.FLOWCODE_TEST_STORE_ID;
const storeName = process.env.FLOWCODE_TEST_STORE_NAME;
const clientVersion = process.env.FLOWCODE_TEST_CLIENT_VERSION;
const pagePath = process.env.FLOWCODE_TEST_PAGE_PATH;
if (!storeId || !storeName || !clientVersion || !pagePath)
  throw new Error("Missing scoped Ziniao smoke-test environment variables.");
const root = path.resolve(".stage5b", "fixed-sensor-smoke");
await rm(root, { recursive: true, force: true });
await mkdir(root, { recursive: true });
const environments = new ZiniaoEnvironmentService(
  new ZiniaoProfileStore(root),
  () => undefined,
  Date.now,
  [clientVersion],
);
await environments.initialize();
const prepared = await environments.prepare({
  kind: "store",
  storeId,
  expectedName: storeName,
});
if (!prepared.ok) throw new Error(prepared.error);
const page = prepared.pages
  .find(
    (candidate) =>
      candidate.title === "FlowCode 5B 本地验收" &&
      new URL(candidate.url).pathname.startsWith(`/${pagePath}/`),
  );
if (!page) throw new Error("No active FlowCode 5B fixture page was found.");
const selected = await environments.selectPage({
  preparationId: prepared.preparationId,
  pageId: page.id,
  allowAssociatedPopups: true,
  approvedFrameOrigins: page.frameOrigins,
});
assert.equal(selected.selection.provider, "ziniao");
const sessionId = "stage5b-fixed-sensor";
const sessionDir = path.join(root, sessionId);
await mkdir(sessionDir, { recursive: true });
const startedAt = Date.now();
const session = createSessionMeta({
  id: sessionId,
  startedAt,
  stoppedAt: null,
  platform: process.platform,
  appVersion: "0.5.0",
});
await Promise.all([
  writeFile(
    path.join(sessionDir, "session.json"),
    `${JSON.stringify(session, null, 2)}\n`,
    "utf8",
  ),
  writeFile(path.join(sessionDir, "events.jsonl"), "", "utf8"),
]);
const capture = new ZiniaoCaptureService(
  environments,
  new ZiniaoLeaseStore(root),
  path.resolve(".flowcode-build", "ziniao", "semantic-sensor.js"),
);
await capture.initialize();
await capture.startSession(
  sessionId,
  sessionDir,
  startedAt,
  selected.selection,
);
console.log("STAGE5B_FIXED_SENSOR_READY");
console.log("请在当前本地 Fixture 页手动点击一次“Shadow 操作”。");
const eventFile = path.join(sessionDir, "browser-events.jsonl");
const deadline = Date.now() + 10 * 60 * 1000;
let observed = false;
while (Date.now() < deadline) {
  const lines = (await readFile(eventFile, "utf8")).split(/\r?\n/).filter(Boolean);
  observed = lines.some((line) => {
    try {
      const event = JSON.parse(line) as {
        type?: string;
        payload?: { target?: { name?: string }; button?: number };
      };
      return (
        event.type === "browser.click" &&
        event.payload?.target?.name === "Shadow 操作" &&
        event.payload.button === 0
      );
    } catch {
      return false;
    }
  });
  if (observed) break;
  await new Promise((resolve) => setTimeout(resolve, 250));
}
if (!observed) {
  await capture.stopSession(sessionId).catch(() => undefined);
  throw new Error("The fixed sensor click was not observed.");
}
const summary = BrowserCaptureSummarySchema.parse(
  await capture.stopSession(sessionId),
);
assert.equal(summary.degraded, false);
assert.equal(summary.gapCount, 0);
assert.equal(summary.sources.every((source) => source.flushed), true);
const receipt = {
  schemaVersion: 1,
  clientVersion,
  event: "trusted Shadow click",
  normalizedButton: 0,
  gapCount: summary.gapCount,
  flush: "pass",
  sourceActor: "human",
};
await writeFile(
  path.resolve(".stage5b", "evidence", "ziniao-fixed-sensor.json"),
  `${JSON.stringify(receipt, null, 2)}\n`,
  "utf8",
);
console.log("STAGE5B_FIXED_SENSOR_COMPLETE");
console.log(JSON.stringify(receipt, null, 2));
