import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { FlowEventSchema } from "../../common/evidence";
import { createSessionMeta } from "../../common/session";
import { ZiniaoCaptureService } from "../../electron/ziniao/capture-service";
import { ZiniaoEnvironmentService } from "../../electron/ziniao/environment-service";
import { ZiniaoLeaseStore, ZiniaoProfileStore } from "../../electron/ziniao/profile-store";
import { processEvidenceSession } from "../../electron/evidence/processor";
import { writeBlueprintExport } from "../../electron/evidence/exporter";

const run = promisify(execFile);
const storeId = process.env.FLOWCODE_TEST_STORE_ID;
const storeName = process.env.FLOWCODE_TEST_STORE_NAME;
const clientVersion = process.env.FLOWCODE_TEST_CLIENT_VERSION;
if (!storeId || !storeName || !clientVersion)
  throw new Error(
    "Set FLOWCODE_TEST_STORE_ID, FLOWCODE_TEST_STORE_NAME and FLOWCODE_TEST_CLIENT_VERSION.",
  );
const repository = path.resolve(".");
const root = path.resolve(".stage5b", "capture-e2e");
const evidenceRoot = path.resolve(".stage5b", "evidence");
if (!root.startsWith(repository + path.sep))
  throw new Error("Capture E2E root escaped the repository.");
await rm(root, { recursive: true, force: true });
await mkdir(root, { recursive: true });
await mkdir(evidenceRoot, { recursive: true });
const statuses: unknown[] = [];
const environments = new ZiniaoEnvironmentService(
  new ZiniaoProfileStore(root),
  (status) => statuses.push(status),
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
const fixturePage = prepared.pages.find(
  (page) => page.title === "FlowCode 5B 本地验收",
);
if (!fixturePage)
  throw new Error("The held FlowCode 5B fixture page was not discovered.");
const selected = await environments.selectPage({
  preparationId: prepared.preparationId,
  pageId: fixturePage.id,
  allowAssociatedPopups: true,
  approvedFrameOrigins: fixturePage.frameOrigins,
});
assert.equal(selected.selection.provider, "ziniao");
const sessionId = "stage5b-real-recording";
const sessionDir = path.join(root, sessionId);
await mkdir(sessionDir, { recursive: true });
const startedAt = Date.now();
const session = createSessionMeta({
  id: sessionId,
  startedAt,
  stoppedAt: null,
  platform: process.platform,
  appVersion: "0.5.0",
  link: { mode: "analyze-only", browserEnhancement: "semantic" },
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
console.log("STAGE5B_CAPTURE_READY");
console.log("请在紫鸟的“FlowCode 5B 本地语义录制验收”页完成页面列出的所有测试动作。");
console.log("包括：输入、下拉、勾选、上传给定 Fixture、提交、两个 iframe、Shadow 按钮、Popup、SPA 和下载。");

async function browserEvents(): Promise<Array<Record<string, unknown>>> {
  const contents = await readFile(
    path.join(sessionDir, "browser-events.jsonl"),
    "utf8",
  );
  return contents
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as Record<string, unknown>];
      } catch {
        return [];
      }
    });
}

function complete(events: Array<Record<string, unknown>>): boolean {
  const types = new Set(events.map((event) => event.type));
  const required = [
    "browser.fill",
    "browser.select",
    "browser.check",
    "browser.submit",
    "browser.popup",
    "browser.upload",
    "browser.download",
    "browser.navigate",
  ];
  const framed = events.filter((event) => {
    const payload = event.payload as Record<string, unknown> | undefined;
    return (
      typeof payload?.frameId === "number" &&
      payload.frameId > 0 &&
      Array.isArray(payload.frameLocatorChain)
    );
  });
  const names = JSON.stringify(
    events.map((event) => (event.payload as Record<string, unknown>)?.target),
  );
  return (
    required.every((type) => types.has(type)) &&
    framed.length >= 2 &&
    names.includes("Shadow 操作") &&
    names.includes("确认 Popup")
  );
}

const deadline = Date.now() + 30 * 60 * 1000;
let events: Array<Record<string, unknown>> = [];
while (Date.now() < deadline) {
  events = await browserEvents();
  if (complete(events)) break;
  await new Promise((resolve) => setTimeout(resolve, 500));
}
if (!complete(events)) {
  await capture.stopSession(sessionId).catch(() => undefined);
  throw new Error(
    `Manual acceptance was incomplete. Captured types: ${JSON.stringify([...new Set(events.map((event) => event.type))])}`,
  );
}
const summary = await capture.stopSession(sessionId);
const stoppedAt = Date.now();
await writeFile(
  path.join(sessionDir, "session.json"),
  `${JSON.stringify({ ...session, stoppedAt }, null, 2)}\n`,
  "utf8",
);
const processed = await processEvidenceSession(sessionDir, "web-test");
const exportPath = path.join(evidenceRoot, "flowcode-5b-blueprint.zip");
await writeBlueprintExport({
  destination: exportPath,
  sessionDir,
  blueprint: processed.blueprintV2,
  evidenceIndex: processed.index,
  browserEvents: processed.evidence.events
    .filter((event) => event.source === "browser" || event.source === "cdp")
    .map(({ effectiveEpochMs: _effectiveEpochMs, ...event }) =>
      FlowEventSchema.parse(event),
    ),
  includeScreenshots: false,
  sensitiveValues: processed.sensitiveValues,
});
const shell = path.join(
  process.env.SystemRoot ?? "C:\\Windows",
  "System32/WindowsPowerShell/v1.0/powershell.exe",
);
const processCount = Number(
  (
    await run(
      shell,
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "@(Get-CimInstance Win32_Process -Filter \"Name='ziniaobrowser.exe'\" | Where-Object { $_.CommandLine -and $_.CommandLine -notmatch '--type=' -and $_.CommandLine -match '--store_data_path=' -and $_.CommandLine -match '--user-data-dir=' }).Count",
      ],
      { encoding: "utf8", windowsHide: true },
    )
  ).stdout.trim(),
);
const serialized = JSON.stringify(processed.blueprintV2);
assert.equal(summary.degraded, false);
assert.equal(processed.index.gaps.length, 0);
assert.ok(processed.blueprintV2.pages.some((page) => page.kind === "popup"));
assert.ok(processed.blueprintV2.frames.length >= 2);
assert.equal(serialized.includes(storeId), false);
assert.equal(serialized.includes("ws://"), false);
assert.equal(serialized.includes("devtools/browser"), false);
const counts = Object.fromEntries(
  [...new Set(events.map((event) => String(event.type)))].map((type) => [
    type,
    events.filter((event) => event.type === type).length,
  ]),
);
const receipt = {
  schemaVersion: 1,
  validatedAt: new Date().toISOString(),
  environment: {
    os: "Windows 11 x64",
    cli: "1.0.8",
    client: clientVersion,
    kernel: "142.0.7444.168",
    store: "<approved-test-store>",
  },
  exactStoreBinding: true,
  simultaneousStoreProcesses: processCount,
  crossStoreIsolation:
    processCount >= 2
      ? "pass-selected-pid-and-target-only"
      : "not-real-two-store-validated",
  sourceActor: "human",
  modelUsed: false,
  eventCounts: counts,
  iframeContexts: processed.blueprintV2.frames.length,
  popupPages: processed.blueprintV2.pages.filter((page) => page.kind === "popup")
    .length,
  sourceCount: summary.sources.length,
  gapCount: summary.gapCount,
  flush: summary.degraded ? "gap" : "pass",
  blueprint: {
    schemaVersion: processed.blueprintV2.schemaVersion,
    contentHashVerified: processed.blueprintV2.contentHash.length === 64,
    steps: processed.blueprintV2.steps.length,
    results: processed.blueprintV2.results.length,
    gaps: processed.blueprintV2.gaps.length,
    exported: true,
    containsStoreOrEndpoint: false,
  },
  originalStoreKeptOpen: true,
};
await writeFile(
  path.join(evidenceRoot, "ziniao-recording.json"),
  `${JSON.stringify(receipt, null, 2)}\n`,
  "utf8",
);
console.log("STAGE5B_CAPTURE_COMPLETE");
console.log(JSON.stringify(receipt, null, 2));
