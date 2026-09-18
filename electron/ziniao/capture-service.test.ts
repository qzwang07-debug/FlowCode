import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { BrowserEnvironmentProfileSchema } from "../../common/browser-environment";
import { createSessionMeta } from "../../common/session";
import { processEvidenceSession } from "../evidence/processor";
import { validatedZiniaoCapabilities } from "./capabilities";
import {
  ZiniaoCaptureService,
  type RecordingAdapter,
} from "./capture-service";
import type { ZiniaoCdpRecordingAdapterOptions } from "./cdp-recording-adapter";
import type { ZiniaoEnvironmentService } from "./environment-service";
import { ZiniaoLeaseStore } from "./profile-store";

test("production Ziniao capture persists one human source and builds a valid model-free v2 Blueprint", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "flowcode-ziniao-capture-"));
  const sessionDir = path.join(root, "session-fixture");
  const sensor = path.join(root, "semantic-sensor.js");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(sessionDir));
  await writeFile(sensor, "globalThis.__flowcodeSensorControl=()=>{}", "utf8");
  const profile = BrowserEnvironmentProfileSchema.parse({
    schemaVersion: 1,
    id: "env-fixture",
    revision: 1,
    provider: "ziniao",
    binding: {
      accountRef: "a".repeat(64),
      storeId: "fixture-store",
      expectedName: "Fixture store",
    },
    siteScopes: ["https://fixture.example"],
    displayMode: "visible",
    loginMode: "existing-context",
    capabilities: validatedZiniaoCapabilities(1000),
  });
  if (profile.provider !== "ziniao") throw new Error("Expected Ziniao profile.");
  const selection = {
    provider: "ziniao" as const,
    environmentProfileId: profile.id,
    preparationId: "prep-fixture",
    pageId: "page-fixture",
    allowAssociatedPopups: true,
  };
  const statuses: unknown[] = [];
  const environments = {
    resolveSelection: async () => ({
      selection,
      profile,
      binding: profile.binding,
      endpoint: {
        endpoint: "http://127.0.0.1:9222",
        webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/fixture",
        processId: 1,
        clientVersion: "6.26.6.7",
        kernelVersion: "142.0.7444.168",
        state: {
          running: true,
          storeId: "fixture-store",
          storeName: "Fixture store",
          downloadFolderPath: "C:\\Fixture\\Downloads",
        },
      },
      target: {
        targetId: "raw-target-never-persisted",
        title: "Fixture page",
        url: "https://fixture.example/form",
        origin: "https://fixture.example",
      },
      logicalPageId: "page-fixture",
      launchOwnership: "borrowed" as const,
    }),
    updateCaptureStatus: (status: unknown) => statuses.push(status),
    releaseSelection: () => undefined,
  } as unknown as ZiniaoEnvironmentService;
  const adapterFactory = (
    options: ZiniaoCdpRecordingAdapterOptions,
  ): RecordingAdapter => ({
    async start() {
      await options.onEvent({
        type: "browser.document",
        epochMs: 1100,
        monotonicMs: 2100,
        payload: {
          tabId: 1,
          frameId: 0,
          documentId: "document-main",
          url: "https://fixture.example/form",
          title: "Fixture page",
        },
      });
      await options.onEvent({
        type: "browser.fill",
        epochMs: 1200,
        monotonicMs: 2200,
        payload: {
          tabId: 1,
          frameId: 0,
          documentId: "document-main",
          url: "https://fixture.example/form",
          target: {
            tag: "input",
            role: "textbox",
            name: "Customer",
            inputType: "text",
          },
          locators: [
            {
              kind: "role",
              value: "textbox|Customer",
              unique: true,
              score: 100,
            },
          ],
          value: {
            kind: "text",
            value: "Fixture customer",
            length: 16,
            truncated: false,
          },
        },
      });
      await options.onEvent({
        type: "browser.click",
        epochMs: 1300,
        monotonicMs: 2300,
        payload: {
          tabId: 1,
          frameId: 0,
          documentId: "document-main",
          url: "https://fixture.example/form",
          target: { tag: "button", role: "button", name: "Submit" },
          locators: [
            {
              kind: "role",
              value: "button|Submit",
              unique: true,
              score: 100,
            },
          ],
          button: 0,
          modifiers: [],
        },
      });
    },
    async stop() {
      return { missingFlushes: 0 };
    },
  });
  const capture = new ZiniaoCaptureService(
    environments,
    new ZiniaoLeaseStore(root, () => 1000),
    sensor,
    () => 2000,
    adapterFactory,
  );
  try {
    const meta = createSessionMeta({
      id: "session-fixture",
      startedAt: 1000,
      stoppedAt: null,
      platform: process.platform,
      appVersion: "0.5.0",
    });
    await writeFile(
      path.join(sessionDir, "session.json"),
      `${JSON.stringify(meta, null, 2)}\n`,
      "utf8",
    );
    await writeFile(path.join(sessionDir, "events.jsonl"), "", "utf8");
    await capture.initialize();
    await capture.startSession(
      meta.id,
      sessionDir,
      meta.startedAt,
      selection,
    );
    const summary = await capture.stopSession(meta.id);
    assert.equal(summary.degraded, false);
    assert.equal(summary.eventCount, 3);
    const completed = { ...meta, stoppedAt: 2000 };
    await writeFile(
      path.join(sessionDir, "session.json"),
      `${JSON.stringify(completed, null, 2)}\n`,
      "utf8",
    );
    const processed = await processEvidenceSession(sessionDir, "web-test");
    assert.equal(processed.blueprintV2.schemaVersion, 2);
    assert.equal(processed.blueprintV2.pages.length, 1);
    assert.equal(processed.blueprintV2.steps.length, 2);
    assert.equal(processed.blueprintV2.steps.every((step) => step.contextStatus === "resolved"), true);
    assert.equal(processed.blueprintV2.contentHash.length, 64);
    const serialized = JSON.stringify(processed.blueprintV2);
    assert.equal(serialized.includes("fixture-store"), false);
    assert.equal(serialized.includes("raw-target"), false);
    assert.equal(serialized.includes("ws://"), false);
    assert.ok(statuses.length > 0);
    assert.match(
      await readFile(path.join(sessionDir, "browser-source.json"), "utf8"),
      /"actor": "human"/,
    );
  } finally {
    await capture.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
