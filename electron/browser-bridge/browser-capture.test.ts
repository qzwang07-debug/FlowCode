import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import type {
  BrowserBridgeRuntime,
  BrowserToDesktopMessage,
  DesktopToBrowserMessage,
} from "../../common/browser";
import {
  BrowserCaptureService,
  type BrowserBridgeTransport,
} from "./browser-capture";
import type {
  NativeBridgeServerListener,
  NativeBrowserConnection,
} from "./server";

const TEST_OPERATION_TIMEOUT_MS = 5_000;

class FakeTransport implements BrowserBridgeTransport {
  registrationError: string | null = null;
  listener: NativeBridgeServerListener | null = null;
  readonly sent: Array<{
    connectionId: string;
    message: DesktopToBrowserMessage;
  }> = [];
  readonly connections = new Map<string, NativeBrowserConnection>();

  setListener(listener: NativeBridgeServerListener): void {
    this.listener = listener;
  }

  async start(): Promise<BrowserBridgeRuntime> {
    return {
      schemaVersion: 1,
      endpoint: "fake-endpoint",
      token: "a".repeat(64),
      maxMessageBytes: 256 * 1024,
    };
  }

  registrationFor(): boolean {
    return true;
  }

  listConnections(): NativeBrowserConnection[] {
    return [...this.connections.values()];
  }

  send(connectionId: string, message: DesktopToBrowserMessage): boolean {
    if (!this.connections.has(connectionId)) return false;
    this.sent.push({ connectionId, message });
    return true;
  }

  closeConnection(connectionId: string): void {
    const connection = this.connections.get(connectionId);
    if (!connection) return;
    this.connections.delete(connectionId);
    this.listener?.disconnected(connection);
  }

  async dispose(): Promise<void> {
    for (const connection of [...this.connections.values()]) {
      this.closeConnection(connection.id);
    }
  }

  connect(id = "connection-1"): NativeBrowserConnection {
    const connection: NativeBrowserConnection = {
      id,
      browser: "chrome",
      origin: "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/",
    };
    this.connections.set(id, connection);
    this.listener?.connected(connection);
    return connection;
  }

  deliver(
    connection: NativeBrowserConnection,
    message: BrowserToDesktopMessage,
  ): void {
    void this.listener?.message(connection, message);
  }
}

function hello(): BrowserToDesktopMessage {
  return {
    kind: "browser.hello",
    protocolVersion: 1,
    browser: "chrome",
    sourceId: "chrome-source",
    extensionVersion: "0.5.0",
    captureState: "idle",
    sessionId: null,
    lastSequence: -1,
    bufferedEvents: 0,
    droppedEvents: 0,
    grantedOriginCount: 1,
    capabilities: [
      "browser.document",
      "browser.navigate",
      "browser.click",
      "browser.fill",
      "browser.select",
      "browser.check",
      "browser.submit",
      "browser.tab-open",
      "browser.tab-close",
      "browser.popup",
      "browser.upload",
      "browser.download",
    ],
  };
}

function browserEvent(sessionId: string): BrowserToDesktopMessage {
  return {
    kind: "browser.event",
    protocolVersion: 1,
    event: {
      schemaVersion: 1,
      eventId: "event-1",
      sessionId,
      sourceId: "chrome-source",
      source: "browser",
      seq: 4,
      epochMs: 1100,
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
    },
  };
}

async function turn(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + TEST_OPERATION_TIMEOUT_MS;
  while (!predicate()) {
    if (Date.now() >= deadline)
      throw new Error("Timed out waiting for bridge state.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("browser capture synchronizes start, persists events, acknowledges, and flushes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "flowcode-browser-capture-"));
  const sessionDirectory = path.join(root, "session-ok");
  await mkdir(sessionDirectory);
  const transport = new FakeTransport();
  const statuses: number[] = [];
  const service = new BrowserCaptureService({
    dataDir: root,
    transport,
    flushTimeoutMs: TEST_OPERATION_TIMEOUT_MS,
    onStatus: (status) => statuses.push(status.receivedEvents),
  });
  try {
    await service.initialize();
    const connection = transport.connect();
    transport.deliver(connection, hello());
    await turn();
    await service.startSession("session-ok", sessionDirectory, 1000);
    assert.ok(
      transport.sent.some(
        ({ message }) =>
          message.kind === "record.start" && message.sessionId === "session-ok",
      ),
    );
    const startCount = transport.sent.filter(
      ({ message }) => message.kind === "record.start",
    ).length;
    transport.deliver(connection, {
      kind: "browser.heartbeat",
      protocolVersion: 1,
      browser: "chrome",
      sourceId: "chrome-source",
      extensionVersion: "0.5.0",
      captureState: "recording",
      sessionId: "session-ok",
      lastSequence: -1,
      bufferedEvents: 0,
      droppedEvents: 0,
      grantedOriginCount: 1,
      epochMs: 1050,
    });
    await turn();
    assert.equal(
      transport.sent.filter(({ message }) => message.kind === "record.start")
        .length,
      startCount,
      "an in-sync heartbeat must not create a Start/heartbeat feedback loop",
    );
    transport.deliver(connection, browserEvent("session-ok"));
    await waitUntil(() =>
      transport.sent.some(
        ({ message }) => message.kind === "browser.ack" && message.seq === 4,
      ),
    );
    assert.ok(
      transport.sent.some(
        ({ message }) => message.kind === "browser.ack" && message.seq === 4,
      ),
    );

    const stopping = service.stopSession("session-ok");
    await turn();
    const lateEvent = browserEvent("session-ok");
    if (lateEvent.kind !== "browser.event") throw new Error("Expected event.");
    transport.deliver(connection, {
      ...lateEvent,
      event: { ...lateEvent.event, eventId: "event-2", seq: 5 },
    });
    await waitUntil(() =>
      transport.sent.some(
        ({ message }) => message.kind === "browser.ack" && message.seq === 5,
      ),
    );
    transport.deliver(connection, {
      kind: "browser.flushed",
      protocolVersion: 1,
      browser: "chrome",
      sourceId: "chrome-source",
      sessionId: "session-ok",
      lastSequence: 5,
      droppedEvents: 0,
    });
    const summary = await stopping;
    assert.equal(summary.eventCount, 2);
    assert.equal(summary.gapCount, 0);
    assert.equal(summary.degraded, false);
    assert.equal(service.status().activeSessionId, null);
    assert.equal(service.status().chrome.connectedSources, 1);
    assert.ok(statuses.includes(1));
    assert.match(
      await readFile(
        path.join(sessionDirectory, "browser-events.jsonl"),
        "utf8",
      ),
      /browser\.click/,
    );
  } finally {
    await service.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("missing browser flush produces an explicit gap instead of silent completion", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "flowcode-browser-timeout-"));
  const sessionDirectory = path.join(root, "session-timeout");
  await mkdir(sessionDirectory);
  const transport = new FakeTransport();
  const service = new BrowserCaptureService({
    dataDir: root,
    transport,
    flushTimeoutMs: 20,
  });
  try {
    await service.initialize();
    const connection = transport.connect();
    transport.deliver(connection, hello());
    await turn();
    await service.startSession("session-timeout", sessionDirectory, 1000);
    const summary = await service.stopSession("session-timeout");
    assert.equal(summary.degraded, true);
    assert.equal(summary.gapCount, 1);
    assert.match(
      await readFile(path.join(sessionDirectory, "browser-gaps.jsonl"), "utf8"),
      /flush-timeout/,
    );
  } finally {
    await service.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("a disconnected source is recorded as a source gap", async () => {
  const root = await mkdtemp(
    path.join(tmpdir(), "flowcode-browser-disconnect-"),
  );
  const sessionDirectory = path.join(root, "session-disconnect");
  await mkdir(sessionDirectory);
  const transport = new FakeTransport();
  const service = new BrowserCaptureService({
    dataDir: root,
    transport,
    flushTimeoutMs: 100,
  });
  try {
    await service.initialize();
    const connection = transport.connect();
    transport.deliver(connection, hello());
    await turn();
    await service.startSession("session-disconnect", sessionDirectory, 1000);
    transport.closeConnection(connection.id);
    const summary = await service.stopSession("session-disconnect");
    assert.equal(summary.gapCount, 1);
    assert.match(
      await readFile(path.join(sessionDirectory, "browser-gaps.jsonl"), "utf8"),
      /source-disconnected/,
    );
  } finally {
    await service.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("a browser that starts or reconnects mid-session receives the active Start state", async () => {
  const root = await mkdtemp(
    path.join(tmpdir(), "flowcode-browser-reconnect-"),
  );
  const sessionDirectory = path.join(root, "session-reconnect");
  await mkdir(sessionDirectory);
  const transport = new FakeTransport();
  const service = new BrowserCaptureService({
    dataDir: root,
    transport,
    flushTimeoutMs: TEST_OPERATION_TIMEOUT_MS,
  });
  try {
    await service.initialize();
    await service.startSession("session-reconnect", sessionDirectory, 1000);
    const first = transport.connect("connection-first");
    transport.deliver(first, hello());
    await turn();
    assert.ok(
      transport.sent.some(
        ({ connectionId, message }) =>
          connectionId === first.id && message.kind === "record.start",
      ),
    );
    transport.closeConnection(first.id);
    const second = transport.connect("connection-second");
    const resumed = hello();
    if (resumed.kind !== "browser.hello") throw new Error("Expected hello.");
    transport.deliver(second, {
      ...resumed,
      captureState: "recording",
      sessionId: "session-reconnect",
    });
    await turn();
    assert.ok(
      transport.sent.some(
        ({ connectionId, message }) =>
          connectionId === second.id && message.kind === "record.start",
      ),
    );
    const stopping = service.stopSession("session-reconnect");
    await turn();
    transport.deliver(second, {
      kind: "browser.flushed",
      protocolVersion: 1,
      browser: "chrome",
      sourceId: "chrome-source",
      sessionId: "session-reconnect",
      lastSequence: -1,
      droppedEvents: 0,
    });
    const summary = await stopping;
    assert.equal(summary.gapCount, 0);
    assert.equal(summary.degraded, false);
  } finally {
    await service.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
