import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";

import {
  BROWSER_BRIDGE_PROTOCOL_VERSION,
  BrowserCaptureStatusSchema,
  type BrowserBridgeRuntime,
  type BrowserCaptureStatus,
  type BrowserCaptureSummary,
  type BrowserGap,
  type BrowserKind,
  type BrowserSemanticEventType,
  type BrowserToDesktopMessage,
  type DesktopToBrowserMessage,
} from "../../common/browser";
import {
  NativeBridgeServer,
  type NativeBridgeServerListener,
  type NativeBrowserConnection,
} from "./server";
import { BrowserSessionStore } from "./session-store";

export interface BrowserBridgeTransport {
  registrationError: string | null;
  setListener(listener: NativeBridgeServerListener): void;
  start(): Promise<BrowserBridgeRuntime>;
  registrationFor(browser: BrowserKind): boolean;
  listConnections(): NativeBrowserConnection[];
  send(connectionId: string, message: DesktopToBrowserMessage): boolean;
  closeConnection(connectionId: string): void;
  dispose(): Promise<void>;
}

interface BrowserClient {
  connection: NativeBrowserConnection;
  sourceId: string | null;
  extensionVersion: string | null;
  captureState: "idle" | "recording" | "flushing";
  sessionId: string | null;
  grantedOriginCount: number;
  droppedEvents: number;
  lastSequence: number;
  lastSeenAt: number;
  error: string | null;
}

interface ActiveBrowserSession {
  id: string;
  startedAt: number;
  phase: "recording" | "flushing";
  store: BrowserSessionStore;
  expectedSources: Map<string, BrowserKind>;
  flushedSources: Set<string>;
  terminalSources: Set<string>;
  droppedBaselines: Map<string, number>;
  droppedReported: Set<string>;
  resolveFlush: (() => void) | null;
  flushDeadlineEpochMs: number | null;
}

export interface BrowserCaptureServiceOptions {
  dataDir: string;
  transport?: BrowserBridgeTransport;
  flushTimeoutMs?: number;
  heartbeatIntervalMs?: number;
  staleConnectionMs?: number;
  now?: () => number;
  onStatus?: (status: BrowserCaptureStatus) => void;
}

const SUPPORTED_CAPABILITIES = new Set<BrowserSemanticEventType>([
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
]);

export class BrowserCaptureService {
  private readonly transport: BrowserBridgeTransport;
  private readonly flushTimeoutMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly staleConnectionMs: number;
  private readonly now: () => number;
  private readonly onStatus: (status: BrowserCaptureStatus) => void;
  private readonly clients = new Map<string, BrowserClient>();
  private readonly pendingClockPings = new Map<
    string,
    { connectionId: string; sentAt: number }
  >();
  private active: ActiveBrowserSession | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private receivedEvents = 0;
  private gaps = 0;
  private initialized = false;
  private disposed = false;

  constructor(private readonly options: BrowserCaptureServiceOptions) {
    this.transport =
      options.transport ?? new NativeBridgeServer({ dataDir: options.dataDir });
    this.flushTimeoutMs = options.flushTimeoutMs ?? 5000;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 10_000;
    this.staleConnectionMs = options.staleConnectionMs ?? 30_000;
    this.now = options.now ?? Date.now;
    this.onStatus = options.onStatus ?? (() => undefined);
    this.transport.setListener({
      connected: (connection) => this.connected(connection),
      message: (connection, message) =>
        this.handleMessageSafely(connection, message),
      disconnected: (connection) => this.disconnected(connection),
      rejected: () => this.emitStatus(),
    });
  }

  async initialize(): Promise<void> {
    if (this.initialized || this.disposed) return;
    await mkdir(this.options.dataDir, { recursive: true });
    await this.transport.start();
    this.initialized = true;
    this.heartbeatTimer = setInterval(
      () => this.heartbeatSweep(),
      this.heartbeatIntervalMs,
    );
    this.heartbeatTimer.unref?.();
    this.emitStatus();
  }

  status(): BrowserCaptureStatus {
    return BrowserCaptureStatusSchema.parse({
      protocolVersion: BROWSER_BRIDGE_PROTOCOL_VERSION,
      activeSessionId: this.active?.id ?? null,
      receivedEvents: this.receivedEvents,
      gaps: this.gaps,
      chrome: this.platformStatus("chrome"),
      edge: this.platformStatus("edge"),
    });
  }

  async startSession(
    sessionId: string,
    sessionDir: string,
    startedAt: number,
  ): Promise<void> {
    if (!this.initialized || this.disposed) {
      throw new Error("Browser capture bridge is unavailable.");
    }
    if (this.active)
      throw new Error("A browser capture session is already active.");
    const store = await BrowserSessionStore.create(
      sessionId,
      startedAt,
      sessionDir,
    );
    const active: ActiveBrowserSession = {
      id: sessionId,
      startedAt,
      phase: "recording",
      store,
      expectedSources: new Map(),
      flushedSources: new Set(),
      terminalSources: new Set(),
      droppedBaselines: new Map(),
      droppedReported: new Set(),
      resolveFlush: null,
      flushDeadlineEpochMs: null,
    };
    this.active = active;
    for (const client of this.clients.values()) {
      if (!client.sourceId) continue;
      this.addExpectedSource(active, client);
      this.sendStart(client, active);
      this.sendClockPings(client, 3);
    }
    this.emitStatus();
  }

  async stopSession(sessionId: string): Promise<BrowserCaptureSummary> {
    const active = this.active;
    if (!active || active.id !== sessionId) {
      throw new Error("The browser capture session is not active.");
    }
    active.phase = "flushing";
    for (const client of this.clients.values()) {
      if (client.sourceId) this.addExpectedSource(active, client);
    }
    const deadlineEpochMs = this.now() + this.flushTimeoutMs;
    active.flushDeadlineEpochMs = deadlineEpochMs;
    const flush = new Promise<void>((resolve) => {
      active.resolveFlush = resolve;
    });
    for (const [sourceId, browser] of active.expectedSources) {
      const client = this.clientForSource(sourceId);
      if (!client) {
        await this.recordGap(active, {
          browser,
          sourceId,
          reason: "source-disconnected",
          droppedEvents: this.droppedDelta(active, sourceId, null),
          detail: "The browser source disconnected before recording stopped.",
        });
        active.terminalSources.add(sourceId);
        continue;
      }
      const sent = this.transport.send(client.connection.id, {
        kind: "record.stop",
        protocolVersion: BROWSER_BRIDGE_PROTOCOL_VERSION,
        sessionId,
        deadlineEpochMs,
      });
      if (!sent) {
        await this.recordGap(active, {
          browser,
          sourceId,
          reason: "source-disconnected",
          droppedEvents: this.droppedDelta(active, sourceId, client),
          detail: "FlowCode could not send the stop request to this source.",
        });
        active.terminalSources.add(sourceId);
      }
    }
    this.resolveFlushIfComplete(active);
    let timer: ReturnType<typeof setTimeout> | null = null;
    await Promise.race([
      flush,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, this.flushTimeoutMs);
      }),
    ]);
    if (timer) clearTimeout(timer);

    for (const [sourceId, browser] of active.expectedSources) {
      if (
        active.flushedSources.has(sourceId) ||
        active.terminalSources.has(sourceId)
      ) {
        continue;
      }
      await this.recordGap(active, {
        browser,
        sourceId,
        reason: "flush-timeout",
        droppedEvents: this.droppedDelta(
          active,
          sourceId,
          this.clientForSource(sourceId),
        ),
        detail:
          "The browser did not confirm that its event buffer was flushed.",
      });
      active.terminalSources.add(sourceId);
    }
    for (const [sourceId, browser] of active.expectedSources) {
      if (active.droppedReported.has(sourceId)) continue;
      const droppedEvents = this.droppedDelta(
        active,
        sourceId,
        this.clientForSource(sourceId),
      );
      if (droppedEvents > 0) {
        await this.recordGap(active, {
          browser,
          sourceId,
          reason: "buffer-overflow",
          droppedEvents,
          detail: "The extension's bounded local buffer dropped events.",
        });
      }
      active.droppedReported.add(sourceId);
    }

    const summary = await active.store.finalize(this.now());
    this.active = null;
    this.pendingClockPings.clear();
    for (const client of this.clients.values()) {
      this.transport.send(client.connection.id, {
        kind: "record.state",
        protocolVersion: BROWSER_BRIDGE_PROTOCOL_VERSION,
        state: "idle",
      });
    }
    this.emitStatus();
    return summary;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    if (this.active) {
      try {
        await this.stopSession(this.active.id);
      } catch {
        // Recorder shutdown already preserves its own session; bridge errors are isolated.
      }
    }
    await this.transport.dispose();
    this.clients.clear();
    this.pendingClockPings.clear();
  }

  private connected(connection: NativeBrowserConnection): void {
    this.clients.set(connection.id, {
      connection,
      sourceId: null,
      extensionVersion: null,
      captureState: "idle",
      sessionId: null,
      grantedOriginCount: 0,
      droppedEvents: 0,
      lastSequence: -1,
      lastSeenAt: this.now(),
      error: null,
    });
    this.sendRecordState(connection.id);
    this.emitStatus();
  }

  private disconnected(connection: NativeBrowserConnection): void {
    this.clients.delete(connection.id);
    for (const [nonce, pending] of this.pendingClockPings) {
      if (pending.connectionId === connection.id) this.pendingClockPings.delete(nonce);
    }
    this.emitStatus();
  }

  private handleMessageSafely(
    connection: NativeBrowserConnection,
    message: BrowserToDesktopMessage,
  ): void {
    void this.handleMessage(connection, message).catch((error) => {
      const client = this.clients.get(connection.id);
      if (client)
        client.error = error instanceof Error ? error.message : String(error);
      this.transport.send(connection.id, {
        kind: "bridge.error",
        protocolVersion: BROWSER_BRIDGE_PROTOCOL_VERSION,
        code: "write-failed",
        message: "FlowCode could not persist a browser event.",
      });
      this.emitStatus();
    });
  }

  private async handleMessage(
    connection: NativeBrowserConnection,
    message: BrowserToDesktopMessage,
  ): Promise<void> {
    const client = this.clients.get(connection.id);
    if (!client) return;
    client.lastSeenAt = this.now();
    if (message.kind === "state.get") {
      this.sendRecordState(connection.id);
      return;
    }
    if (message.kind === "browser.pong") {
      const pending = this.pendingClockPings.get(message.nonce);
      this.pendingClockPings.delete(message.nonce);
      const active = this.active;
      if (
        pending?.connectionId === connection.id &&
        active &&
        client.sourceId
      ) {
        await active.store.appendClockSample({
          schemaVersion: 1,
          sampleId: `clock-${randomUUID()}`,
          sessionId: active.id,
          browser: connection.browser,
          sourceId: client.sourceId,
          nonce: message.nonce,
          desktopSentEpochMs: pending.sentAt,
          desktopReceivedEpochMs: this.now(),
          sourceEpochMs: message.epochMs,
          sourceMonotonicMs: message.monotonicMs,
        });
      }
      this.emitStatus();
      return;
    }
    if (
      message.kind === "browser.hello" ||
      message.kind === "browser.heartbeat"
    ) {
      if (message.browser !== connection.browser) {
        this.transport.closeConnection(connection.id);
        return;
      }
      if (client.sourceId && client.sourceId !== message.sourceId) {
        this.transport.closeConnection(connection.id);
        return;
      }
      if (message.kind === "browser.hello") {
        const capabilities = new Set(message.capabilities);
        if (
          [...SUPPORTED_CAPABILITIES].some(
            (capability) => !capabilities.has(capability),
          )
        ) {
          client.error =
            "The browser extension is missing Stage 3 capabilities.";
        }
      }
      const previous = this.clientForSource(message.sourceId);
      if (previous && previous.connection.id !== connection.id) {
        this.transport.closeConnection(previous.connection.id);
      }
      client.sourceId = message.sourceId;
      client.extensionVersion = message.extensionVersion;
      client.captureState = message.captureState;
      client.sessionId = message.sessionId;
      client.grantedOriginCount = message.grantedOriginCount;
      client.droppedEvents = message.droppedEvents;
      client.lastSequence = message.lastSequence;
      const active = this.active;
      if (active?.phase === "recording") {
        this.addExpectedSource(active, client);
        active.store.noteDropped(
          connection.browser,
          message.sourceId,
          this.droppedDelta(active, message.sourceId, client),
        );
        if (
          message.kind === "browser.hello" ||
          message.captureState !== "recording" ||
          message.sessionId !== active.id
        ) {
          this.sendStart(client, active);
        }
        if (message.kind === "browser.hello") this.sendClockPings(client, 3);
      } else if (
        active?.phase === "flushing" &&
        active.expectedSources.has(message.sourceId) &&
        active.flushDeadlineEpochMs !== null
      ) {
        this.transport.send(connection.id, {
          kind: "record.stop",
          protocolVersion: BROWSER_BRIDGE_PROTOCOL_VERSION,
          sessionId: active.id,
          deadlineEpochMs: active.flushDeadlineEpochMs,
        });
      }
      this.emitStatus();
      return;
    }
    if (!client.sourceId) {
      this.transport.closeConnection(connection.id);
      return;
    }
    if (message.kind === "browser.event") {
      if (message.event.sourceId !== client.sourceId) {
        this.transport.closeConnection(connection.id);
        return;
      }
      const active = this.active;
      if (!active || active.id !== message.event.sessionId) {
        this.transport.send(connection.id, {
          kind: "bridge.error",
          protocolVersion: BROWSER_BRIDGE_PROTOCOL_VERSION,
          code: "invalid-session",
          message: "That browser recording session is no longer active.",
        });
        return;
      }
      this.addExpectedSource(active, client);
      const result = await active.store.appendEvent(
        connection.browser,
        message.event,
      );
      if (result === "written") this.receivedEvents += 1;
      this.transport.send(connection.id, {
        kind: "browser.ack",
        protocolVersion: BROWSER_BRIDGE_PROTOCOL_VERSION,
        sessionId: active.id,
        sourceId: client.sourceId,
        seq: message.event.seq,
      });
      this.emitStatus();
      return;
    }
    if (message.kind === "browser.flushed") {
      if (
        message.browser !== connection.browser ||
        message.sourceId !== client.sourceId
      ) {
        this.transport.closeConnection(connection.id);
        return;
      }
      const active = this.active;
      if (
        !active ||
        active.id !== message.sessionId ||
        active.phase !== "flushing"
      ) {
        return;
      }
      if (!active.expectedSources.has(client.sourceId)) return;
      client.droppedEvents = Math.max(
        client.droppedEvents,
        message.droppedEvents,
      );
      active.store.markFlushed(
        connection.browser,
        client.sourceId,
        this.droppedDelta(active, client.sourceId, client),
      );
      active.flushedSources.add(client.sourceId);
      this.resolveFlushIfComplete(active);
      this.emitStatus();
    }
  }

  private sendRecordState(connectionId: string): void {
    const active = this.active;
    if (active && active.phase === "recording") {
      this.transport.send(connectionId, {
        kind: "record.state",
        protocolVersion: BROWSER_BRIDGE_PROTOCOL_VERSION,
        state: "recording",
        sessionId: active.id,
        startedAtEpochMs: active.startedAt,
      });
    } else if (
      active?.phase === "flushing" &&
      active.flushDeadlineEpochMs !== null
    ) {
      this.transport.send(connectionId, {
        kind: "record.stop",
        protocolVersion: BROWSER_BRIDGE_PROTOCOL_VERSION,
        sessionId: active.id,
        deadlineEpochMs: active.flushDeadlineEpochMs,
      });
    } else {
      this.transport.send(connectionId, {
        kind: "record.state",
        protocolVersion: BROWSER_BRIDGE_PROTOCOL_VERSION,
        state: "idle",
      });
    }
  }

  private sendStart(client: BrowserClient, active: ActiveBrowserSession): void {
    this.transport.send(client.connection.id, {
      kind: "record.start",
      protocolVersion: BROWSER_BRIDGE_PROTOCOL_VERSION,
      sessionId: active.id,
      startedAtEpochMs: active.startedAt,
    });
  }

  private sendClockPings(client: BrowserClient, count: number): void {
    for (let index = 0; index < count; index += 1) {
      const nonce = `ping-${randomUUID()}`;
      const sentAt = this.now();
      if (
        this.transport.send(client.connection.id, {
          kind: "browser.ping",
          protocolVersion: BROWSER_BRIDGE_PROTOCOL_VERSION,
          nonce,
          epochMs: sentAt,
        })
      ) {
        this.pendingClockPings.set(nonce, {
          connectionId: client.connection.id,
          sentAt,
        });
      }
    }
  }

  private addExpectedSource(
    active: ActiveBrowserSession,
    client: BrowserClient,
  ): void {
    if (!client.sourceId) return;
    active.expectedSources.set(client.sourceId, client.connection.browser);
    if (!active.droppedBaselines.has(client.sourceId)) {
      active.droppedBaselines.set(client.sourceId, client.droppedEvents);
    }
    active.store.source(client.connection.browser, client.sourceId);
  }

  private clientForSource(sourceId: string): BrowserClient | null {
    for (const client of this.clients.values()) {
      if (client.sourceId === sourceId) return client;
    }
    return null;
  }

  private droppedDelta(
    active: ActiveBrowserSession,
    sourceId: string,
    client: BrowserClient | null,
  ): number {
    const baseline = active.droppedBaselines.get(sourceId) ?? 0;
    return Math.max(0, (client?.droppedEvents ?? baseline) - baseline);
  }

  private async recordGap(
    active: ActiveBrowserSession,
    input: Pick<
      BrowserGap,
      "browser" | "sourceId" | "reason" | "droppedEvents" | "detail"
    >,
  ): Promise<void> {
    await active.store.recordGap({
      schemaVersion: 1,
      gapId: `gap-${randomUUID()}`,
      sessionId: active.id,
      epochMs: this.now(),
      ...input,
    });
    this.gaps += 1;
  }

  private resolveFlushIfComplete(active: ActiveBrowserSession): void {
    const complete = [...active.expectedSources.keys()].every(
      (sourceId) =>
        active.flushedSources.has(sourceId) ||
        active.terminalSources.has(sourceId),
    );
    if (!complete) return;
    active.resolveFlush?.();
    active.resolveFlush = null;
  }

  private heartbeatSweep(): void {
    const now = this.now();
    for (const [nonce, pending] of this.pendingClockPings) {
      if (now - pending.sentAt > this.staleConnectionMs) {
        this.pendingClockPings.delete(nonce);
      }
    }
    for (const client of this.clients.values()) {
      if (now - client.lastSeenAt > this.staleConnectionMs) {
        this.transport.closeConnection(client.connection.id);
        continue;
      }
      this.sendClockPings(client, 1);
    }
  }

  private platformStatus(browser: BrowserKind) {
    const clients = [...this.clients.values()].filter(
      (client) => client.connection.browser === browser && client.sourceId,
    );
    return {
      browser,
      hostRegistered: this.transport.registrationFor(browser),
      connectedSources: clients.length,
      grantedOriginCount: clients.reduce(
        (total, client) => total + client.grantedOriginCount,
        0,
      ),
      droppedEvents: clients.reduce(
        (total, client) => total + client.droppedEvents,
        0,
      ),
      lastSeenAt: clients.length
        ? Math.max(...clients.map((client) => client.lastSeenAt))
        : null,
      state: this.active?.phase ?? "idle",
      error:
        this.transport.registrationError ??
        clients.find((client) => client.error)?.error ??
        null,
    };
  }

  private emitStatus(): void {
    try {
      this.onStatus(this.status());
    } catch {
      // Status UI delivery cannot interrupt capture or persistence.
    }
  }
}
