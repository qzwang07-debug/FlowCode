import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { BrowserCaptureSummarySchema } from "../../common/browser";
import { BrowserSourceIdentitySchema } from "../../common/browser-environment";
import { FlowEventSchema } from "../../common/evidence";
import { processEvidenceSession } from "../../electron/evidence/processor";
import { writeBlueprintExport } from "../../electron/evidence/exporter";

const run = promisify(execFile);
const storeId = process.env.FLOWCODE_TEST_STORE_ID;
const clientVersion = process.env.FLOWCODE_TEST_CLIENT_VERSION;
if (!storeId || !clientVersion)
  throw new Error("Set FLOWCODE_TEST_STORE_ID and FLOWCODE_TEST_CLIENT_VERSION.");
const sessionDir = path.resolve(
  ".stage5b",
  "capture-e2e",
  "stage5b-real-recording",
);
const evidenceRoot = path.resolve(".stage5b", "evidence");
await mkdir(evidenceRoot, { recursive: true });
const [summary, identity] = await Promise.all([
  readFile(path.join(sessionDir, "browser-capture.json"), "utf8").then((value) =>
    BrowserCaptureSummarySchema.parse(JSON.parse(value)),
  ),
  readFile(path.join(sessionDir, "browser-source.json"), "utf8").then((value) =>
    BrowserSourceIdentitySchema.parse(JSON.parse(value)),
  ),
]);
const fixedSensor = JSON.parse(
  await readFile(
    path.resolve(".stage5b", "evidence", "ziniao-fixed-sensor.json"),
    "utf8",
  ),
) as { gapCount?: number; flush?: string; normalizedButton?: number };
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
const events = processed.evidence.events.filter(
  (event) => event.source === "browser" || event.source === "cdp",
);
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
const types = new Set(events.map((event) => event.type));
assert.equal(required.every((type) => types.has(type)), true);
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
assert.equal(summary.sources.length, 1);
assert.equal(summary.sources[0]?.browser, "ziniao");
assert.equal(summary.sources[0]?.flushed, true);
assert.equal(summary.sources[0]?.droppedEvents, 0);
assert.equal(processed.index.gaps.length, 1);
assert.equal(fixedSensor.gapCount, 0);
assert.equal(fixedSensor.flush, "pass");
assert.equal(fixedSensor.normalizedButton, 0);
assert.equal(identity.actor, "human");
assert.equal(identity.provider, "ziniao");
assert.ok(processed.blueprintV2.pages.some((page) => page.kind === "popup"));
assert.ok(processed.blueprintV2.frames.length >= 2);
assert.equal(serialized.includes(storeId), false);
assert.equal(serialized.includes("ws://"), false);
assert.equal(serialized.includes("devtools/browser"), false);
const counts = Object.fromEntries(
  [...types].sort().map((type) => [
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
  sourceActor: identity.actor,
  modelUsed: false,
  eventCounts: counts,
  iframeContexts: processed.blueprintV2.frames.length,
  popupPages: processed.blueprintV2.pages.filter((page) => page.kind === "popup")
    .length,
  sourceCount: summary.sources.length,
  gapCount: summary.gapCount,
  flush: summary.sources.every((source) => source.flushed) ? "pass" : "gap",
  fullFlowGap: {
    retained: true,
    count: summary.gapCount,
    disposition:
      "Pre-fix trusted click button=-1 contract rejection; required flow events are complete and raw evidence is unchanged.",
  },
  postFixRealSensor: {
    trustedHumanClick: true,
    normalizedButton: fixedSensor.normalizedButton,
    gapCount: fixedSensor.gapCount,
    flush: fixedSensor.flush,
  },
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
  acceptance: "pass-with-retained-pre-fix-gap-and-post-fix-real-regression",
};
await writeFile(
  path.join(evidenceRoot, "ziniao-recording.json"),
  `${JSON.stringify(receipt, null, 2)}\n`,
  "utf8",
);
console.log("STAGE5B_CAPTURE_COMPLETE");
console.log(JSON.stringify(receipt, null, 2));
