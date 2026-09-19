import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  BrowserGapSchema,
  BrowserSemanticEventSchema,
  type BrowserCaptureSummary,
} from "../../common/browser";
import { BrowserSourceIdentitySchema } from "../../common/browser-environment";
import { RecordingSourceStateSchema } from "../../common/project-execution";
import type { RecordingBrowserSelection } from "../../common/ziniao-recording";
import { BrowserSessionStore } from "../browser-bridge/session-store";
import {
  ZiniaoCdpRecordingAdapter,
  type ZiniaoAdapterEvent,
  type ZiniaoAdapterGapReason,
  type ZiniaoCdpRecordingAdapterOptions,
} from "./cdp-recording-adapter";
import type {
  ResolvedZiniaoSelection,
  ZiniaoEnvironmentService,
} from "./environment-service";
import type { ZiniaoLeaseStore } from "./profile-store";

interface ActiveCapture {
  sessionId: string;
  sessionDir: string;
  sourceId: string;
  selection: Extract<RecordingBrowserSelection, { provider: "ziniao" }>;
  resolved: ResolvedZiniaoSelection;
  leaseId: string;
  store: BrowserSessionStore;
  adapter: RecordingAdapter | null;
  sequence: number;
  eventCount: number;
  gapCount: number;
  gapIds: string[];
  pending: number;
  queue: Promise<void>;
  clockWritten: boolean;
  stopping: boolean;
  reconnecting: Promise<void> | null;
}

export interface RecordingAdapter {
  start(signal?: AbortSignal): Promise<void>;
  stop(timeoutMs?: number): Promise<{ missingFlushes: number }>;
}

async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  const temporary = `${file}.tmp.${process.pid}.${randomUUID()}`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class ZiniaoCaptureService {
  private active: ActiveCapture | null = null;
  private sensorSource: string | null = null;

  constructor(
    private readonly environments: ZiniaoEnvironmentService,
    private readonly leases: ZiniaoLeaseStore,
    private readonly sensorPath: string,
    private readonly now: () => number = Date.now,
    private readonly adapterFactory: (
      options: ZiniaoCdpRecordingAdapterOptions,
    ) => RecordingAdapter = (options) => new ZiniaoCdpRecordingAdapter(options),
  ) {}

  async initialize(): Promise<void> {
    await this.leases.initialize();
    const source = await readFile(this.sensorPath, "utf8");
    if (!source.includes("__flowcodeSensorControl") || source.length > 1024 * 1024)
      throw new Error("The reviewed Ziniao semantic sensor is unavailable.");
    this.sensorSource = source;
  }

  async startSession(
    sessionId: string,
    sessionDir: string,
    startedAt: number,
    rawSelection: RecordingBrowserSelection,
  ): Promise<void> {
    if (this.active) throw new Error("A Ziniao recording is already active.");
    if (rawSelection.provider !== "ziniao")
      throw new Error("Expected a Ziniao recording selection.");
    if (!this.sensorSource)
      throw new Error("The Ziniao semantic sensor is not initialized.");
    this.environments.updateCaptureStatus({
      state: "preparing",
      eventCount: 0,
      gapCount: 0,
      error: null,
    });
    const resolved = await this.environments.resolveSelection(rawSelection);
    const lease = await this.leases.acquire({
      profile: resolved.profile,
      sessionId,
      pageId: resolved.logicalPageId,
      allowAssociatedPopups: rawSelection.allowAssociatedPopups,
      launchOwnership: resolved.launchOwnership,
    });
    const store = await BrowserSessionStore.create(sessionId, startedAt, sessionDir);
    const sourceId = `ziniao:${resolved.profile.id}:${randomUUID()}`;
    store.source("ziniao", sourceId);
    const active: ActiveCapture = {
      sessionId,
      sessionDir,
      sourceId,
      selection: rawSelection,
      resolved,
      leaseId: lease.id,
      store,
      adapter: null,
      sequence: 0,
      eventCount: 0,
      gapCount: 0,
      gapIds: [],
      pending: 0,
      queue: Promise.resolve(),
      clockWritten: false,
      stopping: false,
      reconnecting: null,
    };
    this.active = active;
    const identity = BrowserSourceIdentitySchema.parse({
      schemaVersion: 2,
      sourceId,
      sessionId,
      provider: "ziniao",
      environmentProfileId: resolved.profile.id,
      leaseId: lease.id,
      actor: "human",
      transport: "cdp-adapter",
    });
    try {
      await Promise.all([
        writeJsonAtomic(path.join(sessionDir, "browser-source.json"), identity),
        writeJsonAtomic(path.join(sessionDir, "browser-lease.json"), lease),
        this.writeState(active, "preparing"),
      ]);
      active.adapter = this.createAdapter(active);
      await active.adapter.start();
      await this.writeState(active, "recording");
      this.environments.updateCaptureStatus({
        state: "recording",
        selectedProfileId: resolved.profile.id,
        selectedStoreName: resolved.binding.expectedName,
        selectedPageTitle: resolved.target.title,
        clientVersion: resolved.endpoint.clientVersion,
        kernelVersion: resolved.endpoint.kernelVersion,
        error: null,
      });
    } catch (error) {
      await this.recordGap(active, "connection-lost", "Ziniao capture could not start.");
      await active.adapter?.stop().catch(() => undefined);
      await active.queue;
      await store.finalize(this.now()).catch(() => undefined);
      await this.leases.release(lease.id).catch(() => undefined);
      this.environments.releaseSelection(rawSelection.preparationId);
      this.active = null;
      const message = error instanceof Error ? error.message : String(error);
      this.environments.updateCaptureStatus({ state: "error", error: message });
      throw error;
    }
  }

  async stopSession(sessionId: string): Promise<BrowserCaptureSummary> {
    const active = this.active;
    if (!active || active.sessionId !== sessionId)
      throw new Error("That Ziniao recording is not active.");
    active.stopping = true;
    this.environments.updateCaptureStatus({ state: "flushing" });
    await this.writeState(active, "flushing");
    if (active.reconnecting) await active.reconnecting.catch(() => undefined);
    const adapter = active.adapter;
    const flush = await (adapter
      ? adapter.stop()
      : Promise.reject(new Error("Ziniao capture adapter is unavailable."))).catch(async () => {
      await this.recordGap(
        active,
        "flush-timeout",
        "The Ziniao capture connection ended before stop completed.",
      );
      return { missingFlushes: 1 };
    });
    await active.queue;
    if (flush.missingFlushes === 0)
      active.store.markFlushed("ziniao", active.sourceId, 0);
    await this.leases.release(active.leaseId);
    this.environments.releaseSelection(active.selection.preparationId);
    await this.writeState(active, active.gapCount ? "degraded" : "recorded");
    const summary = await active.store.finalize(this.now());
    this.active = null;
    this.environments.updateCaptureStatus({
      state: summary.degraded ? "degraded" : "idle",
      eventCount: summary.eventCount,
      gapCount: summary.gapCount,
      error: summary.degraded
        ? "The Ziniao recording completed with explicit evidence gaps."
        : null,
    });
    return summary;
  }

  async dispose(): Promise<void> {
    if (this.active) await this.stopSession(this.active.sessionId).catch(() => undefined);
  }

  private createAdapter(active: ActiveCapture): RecordingAdapter {
    return this.adapterFactory({
      webSocketDebuggerUrl: active.resolved.endpoint.webSocketDebuggerUrl,
      rootTargetId: active.resolved.target.targetId,
      allowedOrigins: active.resolved.profile.siteScopes,
      allowAssociatedPopups: active.selection.allowAssociatedPopups,
      sensorSource: this.sensorSource!,
      onEvent: (event) => this.acceptEvent(active, event),
      onGap: (reason, detail, dropped) =>
        this.recordGap(active, reason, detail, dropped),
      onDisconnected: () => {
        if (!active.stopping && !active.reconnecting) {
          active.reconnecting = this.reconnect(active).finally(() => {
            active.reconnecting = null;
          });
        }
      },
    });
  }

  private acceptEvent(active: ActiveCapture, input: ZiniaoAdapterEvent): void {
    if (this.active !== active) return;
    if (active.pending >= 1024) {
      void this.recordGap(
        active,
        "buffer-overflow",
        "The bounded Ziniao persistence buffer overflowed.",
        1,
      );
      return;
    }
    const sequence = active.sequence++;
    const event = BrowserSemanticEventSchema.parse({
      schemaVersion: 1,
      eventId: `ziniao-event-${randomUUID()}`,
      sessionId: active.sessionId,
      sourceId: active.sourceId,
      source: "browser",
      seq: sequence,
      epochMs: Math.max(0, Math.floor(input.epochMs)),
      ...(input.monotonicMs !== undefined
        ? { monotonicMs: input.monotonicMs }
        : {}),
      type: input.type,
      payload: input.payload,
      ...(input.privacyTags ? { privacyTags: input.privacyTags } : {}),
    });
    active.pending += 1;
    this.enqueue(active, async () => {
      try {
        if (!active.clockWritten && event.monotonicMs !== undefined) {
          const receivedAt = this.now();
          await active.store.appendClockSample({
            schemaVersion: 1,
            sampleId: `clock-${randomUUID()}`,
            sessionId: active.sessionId,
            browser: "ziniao",
            sourceId: active.sourceId,
            nonce: `packet-${sequence}`,
            desktopSentEpochMs: receivedAt,
            desktopReceivedEpochMs: receivedAt,
            sourceEpochMs: event.epochMs,
            sourceMonotonicMs: event.monotonicMs,
          });
          active.clockWritten = true;
        }
        const result = await active.store.appendEvent("ziniao", event);
        if (result === "written") active.eventCount += 1;
        this.environments.updateCaptureStatus({ eventCount: active.eventCount });
      } finally {
        active.pending -= 1;
      }
    });
  }

  private recordGap(
    active: ActiveCapture,
    reason: ZiniaoAdapterGapReason,
    detail: string,
    droppedEvents = 0,
  ): Promise<void> {
    const gap = BrowserGapSchema.parse({
      schemaVersion: 1,
      gapId: `gap-${randomUUID()}`,
      sessionId: active.sessionId,
      browser: "ziniao",
      sourceId: active.sourceId,
      epochMs: this.now(),
      reason,
      droppedEvents,
      detail: detail.slice(0, 512),
    });
    active.gapCount += 1;
    active.gapIds.push(gap.gapId);
    this.environments.updateCaptureStatus({
      state: active.stopping ? "flushing" : "degraded",
      gapCount: active.gapCount,
    });
    return this.enqueue(active, async () => {
      await active.store.recordGap(gap);
      await this.writeState(
        active,
        active.stopping ? "flushing" : "degraded",
      );
    });
  }

  private async reconnect(active: ActiveCapture): Promise<void> {
    await this.recordGap(
      active,
      "connection-lost",
      "The Ziniao CDP connection ended; FlowCode is revalidating the exact store.",
    );
    for (const delay of [250, 500, 1000]) {
      if (active.stopping) return;
      await wait(delay);
      try {
        const resolved = await this.environments.resolveSelection(active.selection);
        if (
          resolved.binding.accountRef !== active.resolved.binding.accountRef ||
          resolved.binding.storeId !== active.resolved.binding.storeId
        )
          throw new Error("The selected store identity changed during reconnect.");
        active.resolved = resolved;
        const adapter = this.createAdapter(active);
        active.adapter = adapter;
        await adapter.start();
        this.environments.updateCaptureStatus({ state: "recording", error: null });
        return;
      } catch {
        // Retry only after exact account/store/endpoint validation.
      }
    }
    const message = "Ziniao reconnect failed after exact store revalidation.";
    await this.recordGap(active, "connection-lost", message);
    this.environments.updateCaptureStatus({ state: "error", error: message });
  }

  private enqueue(active: ActiveCapture, operation: () => Promise<void>): Promise<void> {
    const result = active.queue.then(operation, operation);
    active.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private writeState(
    active: ActiveCapture,
    phase: "preparing" | "recording" | "flushing" | "recorded" | "degraded",
  ): Promise<void> {
    return writeJsonAtomic(
      path.join(active.sessionDir, "browser-source-state.json"),
      RecordingSourceStateSchema.parse({
        schemaVersion: 1,
        sessionId: active.sessionId,
        sourceId: active.sourceId,
        environmentProfileId: active.resolved.profile.id,
        leaseId: active.leaseId,
        phase,
        updatedAt: this.now(),
        gapRefs: active.gapIds,
      }),
    );
  }
}
