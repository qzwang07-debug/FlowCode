import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import type { CdpEvent, CdpTransport } from "./cdp-client";
import {
  ZiniaoCdpRecordingAdapter,
  type ZiniaoAdapterEvent,
} from "./cdp-recording-adapter";

class FakeCdp implements CdpTransport {
  private readonly eventListeners = new Set<(event: CdpEvent) => void>();
  private readonly closeListeners = new Set<(error: Error | null) => void>();
  private binding = "";
  private token = "";
  private world = "";
  private nextSession = 1;
  readonly sessions = new Map<string, string>();
  closed = false;

  async send<T extends Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
  ): Promise<T> {
    let result: Record<string, unknown> = {};
    if (method === "Target.getTargets") {
      result = {
        targetInfos: [
          {
            targetId: "root-target",
            type: "page",
            title: "Fixture",
            url: "https://fixture.example/start",
          },
          {
            targetId: "other-store-target",
            type: "page",
            title: "Other store",
            url: "https://fixture.example/other",
          },
        ],
      };
    } else if (method === "Target.attachToTarget") {
      const targetId = String(params.targetId);
      const id = `session-${this.nextSession++}`;
      this.sessions.set(targetId, id);
      result = { sessionId: id };
    } else if (method === "Page.getFrameTree") {
      result = {
        frameTree: {
          frame: {
            id: sessionId === this.sessions.get("root-target") ? "main" : "popup-main",
            url: "https://fixture.example/start",
          },
          ...(sessionId === this.sessions.get("root-target")
            ? {
                childFrames: [
                  {
                    frame: {
                      id: "child",
                      parentId: "main",
                      url: "https://frame.example/form",
                    },
                  },
                ],
              }
            : {}),
        },
      };
    } else if (method === "Runtime.addBinding") {
      this.binding = String(params.name);
      this.world = String(params.executionContextName);
    } else if (method === "Page.addScriptToEvaluateOnNewDocument") {
      const match = /__flowcodeSensorConfig=([^;]+);/.exec(String(params.source));
      assert.ok(match);
      this.token = (JSON.parse(match[1]) as { token: string }).token;
      result = { identifier: `script-${sessionId}` };
      queueMicrotask(() => {
        if (sessionId === this.sessions.get("root-target")) {
          this.emitContext(sessionId!, 1, "main");
          this.emitContext(sessionId!, 2, "child");
        } else this.emitContext(sessionId!, 3, "popup-main");
      });
    } else if (method === "DOM.getFrameOwner") {
      result = { backendNodeId: 44 };
    } else if (method === "DOM.describeNode") {
      result = {
        node: {
          localName: "iframe",
          attributes: ["title", "Fixture frame"],
        },
      };
    } else if (method === "Runtime.evaluate") {
      const contextId = Number(params.contextId);
      this.bindingPacket(sessionId!, contextId, 99, "sensor.flushed", {
        documentId: `document-${contextId}`,
      });
    }
    return result as T;
  }

  onEvent(listener: (event: CdpEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  onClose(listener: (error: Error | null) => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  emit(event: CdpEvent): void {
    for (const listener of this.eventListeners) listener(event);
  }

  bindingPacket(
    sessionId: string,
    contextId: number,
    seq: number,
    type: string,
    payload: unknown,
  ): void {
    this.emit({
      method: "Runtime.bindingCalled",
      sessionId,
      params: {
        name: this.binding,
        executionContextId: contextId,
        payload: JSON.stringify({
          token: this.token,
          seq,
          epochMs: 1000 + seq,
          monotonicMs: 2000 + seq,
          type,
          payload,
        }),
      },
    });
  }

  private emitContext(sessionId: string, id: number, frameId: string): void {
    this.emit({
      method: "Runtime.executionContextCreated",
      sessionId,
      params: {
        context: {
          id,
          name: this.world,
          auxData: { isDefault: false, frameId },
        },
      },
    });
  }
}

const pause = () => new Promise((resolve) => setTimeout(resolve, 25));

test("production CDP adapter scopes one store, maps frames/popups, deduplicates, and flushes", async () => {
  const fake = new FakeCdp();
  const events: ZiniaoAdapterEvent[] = [];
  const gaps: string[] = [];
  const adapter = new ZiniaoCdpRecordingAdapter({
    webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/fixture",
    rootTargetId: "root-target",
    allowedOrigins: ["https://fixture.example", "https://frame.example"],
    allowAssociatedPopups: true,
    sensorSource: "globalThis.__flowcodeSensorControl=()=>{}",
    connect: async () => fake,
    onEvent: (event) => {
      events.push(event);
    },
    onGap: (reason) => {
      gaps.push(reason);
    },
  });
  await adapter.start();
  await pause();
  const rootSession = fake.sessions.get("root-target")!;
  fake.bindingPacket(rootSession, 1, 0, "browser.click", {
    documentId: "document-main",
    url: "https://fixture.example/start",
    target: { tag: "button", role: "button", name: "Submit" },
    locators: [{ kind: "role", value: "button|Submit", unique: true, score: 100 }],
    button: 0,
    modifiers: [],
  });
  fake.bindingPacket(rootSession, 1, 0, "browser.click", {
    documentId: "document-main",
    url: "https://fixture.example/start",
    target: { tag: "button", name: "Duplicate" },
    locators: [{ kind: "text", value: "Duplicate", unique: true, score: 70 }],
    button: 0,
    modifiers: [],
  });
  fake.bindingPacket(rootSession, 2, 0, "browser.fill", {
    documentId: "document-frame",
    url: "https://frame.example/form",
    target: { tag: "input", role: "textbox", name: "Frame input", inputType: "text" },
    locators: [{ kind: "role", value: "textbox|Frame input", unique: true, score: 100 }],
    value: { kind: "text", value: "fixture", length: 7, truncated: false },
  });
  // Another open store target has no approved opener and must never attach.
  fake.emit({
    method: "Target.targetCreated",
    params: {
      targetInfo: {
        targetId: "unrelated-target",
        type: "page",
        title: "Unrelated",
        url: "https://fixture.example/unrelated",
      },
    },
  });
  fake.emit({
    method: "Target.targetCreated",
    params: {
      targetInfo: {
        targetId: "popup-target",
        openerId: "root-target",
        type: "page",
        title: "Popup",
        url: "https://fixture.example/popup",
      },
    },
  });
  await pause();
  assert.equal(fake.sessions.has("unrelated-target"), false);
  assert.equal(fake.sessions.has("popup-target"), true);
  assert.equal(events.filter((event) => event.type === "browser.click").length, 1);
  const fill = events.find((event) => event.type === "browser.fill");
  assert.ok(fill);
  assert.deepEqual(
    (fill.payload as { frameLocatorChain?: unknown }).frameLocatorChain,
    [{ kind: "css", value: 'iframe[title="Fixture\\ frame"]', unique: false, score: 20 }],
  );
  assert.ok(events.some((event) => event.type === "browser.tab-open"));
  assert.ok(events.some((event) => event.type === "browser.popup"));
  const stopped = await adapter.stop(500);
  assert.equal(stopped.missingFlushes, 0);
  assert.equal(fake.closed, true);
  assert.deepEqual(gaps, []);
});

test("production sensor retains trusted-only privacy/locator logic without page messaging", async () => {
  const source = await readFile("electron/ziniao/semantic-sensor.ts", "utf8");
  assert.match(source, /event\.isTrusted/);
  assert.match(source, /buildLocatorCandidates/);
  assert.match(source, /captureFieldValue/);
  assert.match(source, /safeUploadMetadata/);
  assert.match(source, /event\.button >= 0/);
  assert.doesNotMatch(source, /addEventListener\(["']message["']/);
});
