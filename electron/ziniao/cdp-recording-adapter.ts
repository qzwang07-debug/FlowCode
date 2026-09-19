import { randomBytes } from "node:crypto";
import { z } from "zod";

import {
  BrowserContentEventSchema,
  BrowserSemanticEventTypeSchema,
  type BrowserCaptureProvider,
  type BrowserLocator,
  type BrowserSemanticEvent,
} from "../../common/browser";
import { sanitizeBrowserUrl } from "../../apps/browser-extension/src/privacy/url";
import { isStableDomId } from "../../apps/browser-extension/src/locator/ranking";
import {
  CdpClient,
  type CdpEvent,
  type CdpTransport,
} from "./cdp-client";

export type ZiniaoAdapterEvent = Pick<
  BrowserSemanticEvent,
  "type" | "payload" | "epochMs" | "monotonicMs" | "privacyTags"
>;
export type ZiniaoAdapterGapReason =
  | "flush-timeout"
  | "source-disconnected"
  | "buffer-overflow"
  | "scope-rejected"
  | "identity-changed"
  | "connection-lost";

interface FrameState {
  id: string;
  parentId?: string;
  url: string;
}

interface TargetState {
  targetId: string;
  sessionId: string;
  tabId: number;
  openerTargetId?: string;
  frames: Map<string, FrameState>;
  frameNumbers: Map<string, number>;
  contexts: Map<number, string>;
  participating: Set<number>;
  flushed: Set<number>;
  scriptId?: string;
  lastMainUrl?: string;
  blocked: boolean;
}

interface TargetInfo {
  targetId: string;
  type: string;
  title: string;
  url: string;
  openerId?: string;
}

const TargetInfoSchema = z
  .object({
    targetId: z.string().min(1),
    type: z.string(),
    title: z.string(),
    url: z.string(),
    openerId: z.string().optional(),
  })
  .passthrough();

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cssEscape(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, (character) => `\\${character}`);
}

function attributes(input: unknown): Map<string, string> {
  if (!Array.isArray(input)) return new Map();
  const values = new Map<string, string>();
  for (let index = 0; index + 1 < input.length; index += 2) {
    const name = input[index];
    const value = input[index + 1];
    if (typeof name === "string" && typeof value === "string")
      values.set(name, value);
  }
  return values;
}

export interface ZiniaoCdpRecordingAdapterOptions {
  webSocketDebuggerUrl: string;
  rootTargetId: string;
  allowedOrigins: readonly string[];
  allowAssociatedPopups: boolean;
  sensorSource: string;
  onEvent: (event: ZiniaoAdapterEvent) => void | Promise<void>;
  onGap: (
    reason: ZiniaoAdapterGapReason,
    detail: string,
    droppedEvents?: number,
  ) => void | Promise<void>;
  onDisconnected?: () => void;
  connect?: (
    webSocketDebuggerUrl: string,
    signal?: AbortSignal,
  ) => Promise<CdpTransport>;
}

export class ZiniaoCdpRecordingAdapter {
  private client: CdpTransport | null = null;
  private readonly targets = new Map<string, TargetState>();
  private readonly sessions = new Map<string, TargetState>();
  private readonly allowedOrigins: Set<string>;
  private readonly bindingName = `flowcodeSensor_${randomBytes(10).toString("hex")}`;
  private readonly worldName = `flowcode-sensor-${randomBytes(10).toString("hex")}`;
  private readonly token = randomBytes(24).toString("hex");
  private readonly packetKeys = new Set<string>();
  private nextTabId = 1;
  private nextDownloadId = 1;
  private stopping = false;

  constructor(private readonly options: ZiniaoCdpRecordingAdapterOptions) {
    this.allowedOrigins = new Set(
      options.allowedOrigins.map((origin) => new URL(origin).origin),
    );
  }

  async start(signal?: AbortSignal): Promise<void> {
    if (this.client) throw new Error("Ziniao capture is already connected.");
    const connect = this.options.connect ?? CdpClient.connect;
    const client = await connect(this.options.webSocketDebuggerUrl, signal);
    this.client = client;
    client.onEvent((event) => {
      void this.handleEvent(event).catch(() =>
        this.options.onGap(
          "identity-changed",
          "A Ziniao semantic packet or CDP event failed contract validation.",
        ),
      );
    });
    client.onClose(() => {
      if (!this.stopping) this.options.onDisconnected?.();
    });
    await client.send("Target.setDiscoverTargets", { discover: true });
    const current = await client.send<{ targetInfos: unknown[] }>(
      "Target.getTargets",
    );
    const targets = z.array(TargetInfoSchema).parse(current.targetInfos);
    const root = targets.find(
      (target) =>
        target.targetId === this.options.rootTargetId && target.type === "page",
    );
    if (!root) throw new Error("The selected Ziniao page no longer exists.");
    const rootUrl = sanitizeBrowserUrl(root.url);
    if (!rootUrl || !this.allowed(new URL(rootUrl).origin))
      throw new Error("The selected page is outside the approved origin.");
    await this.attach(root, false);
    await client.send("Browser.setDownloadBehavior", {
      behavior: "default",
      eventsEnabled: true,
    });
  }

  async stop(timeoutMs = 5000): Promise<{ missingFlushes: number }> {
    if (!this.client) return { missingFlushes: 0 };
    this.stopping = true;
    const client = this.client;
    const evaluations: Promise<unknown>[] = [];
    for (const target of this.targets.values()) {
      for (const contextId of target.participating) {
        if (!target.contexts.has(contextId)) continue;
        evaluations.push(
          client
            .send(
              "Runtime.evaluate",
              {
                expression: "globalThis.__flowcodeSensorControl?.('stop')",
                contextId,
                returnByValue: true,
              },
              target.sessionId,
              Math.min(timeoutMs, 3000),
            )
            .catch(() => undefined),
        );
      }
    }
    await Promise.all(evaluations);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && this.missingFlushes() > 0) await wait(50);
    const missingFlushes = this.missingFlushes();
    if (missingFlushes > 0)
      await this.options.onGap(
        "flush-timeout",
        `${missingFlushes} active Ziniao sensor context(s) did not flush before stop.`,
        missingFlushes,
      );
    for (const target of this.targets.values()) {
      if (target.scriptId)
        await client
          .send(
            "Page.removeScriptToEvaluateOnNewDocument",
            { identifier: target.scriptId },
            target.sessionId,
          )
          .catch(() => undefined);
      await client
        .send(
          "Runtime.removeBinding",
          { name: this.bindingName },
          target.sessionId,
        )
        .catch(() => undefined);
      await client
        .send("Target.detachFromTarget", { sessionId: target.sessionId })
        .catch(() => undefined);
    }
    await client
      .send("Target.setDiscoverTargets", { discover: false })
      .catch(() => undefined);
    await client.close();
    this.client = null;
    this.targets.clear();
    this.sessions.clear();
    return { missingFlushes };
  }

  private async attach(info: TargetInfo, popup: boolean): Promise<void> {
    if (this.targets.has(info.targetId)) return;
    const client = this.requireClient();
    const attached = await client.send<{ sessionId: string }>(
      "Target.attachToTarget",
      { targetId: info.targetId, flatten: true },
    );
    const target: TargetState = {
      targetId: info.targetId,
      sessionId: attached.sessionId,
      tabId: this.nextTabId++,
      ...(info.openerId ? { openerTargetId: info.openerId } : {}),
      frames: new Map(),
      frameNumbers: new Map(),
      contexts: new Map(),
      participating: new Set(),
      flushed: new Set(),
      lastMainUrl: sanitizeBrowserUrl(info.url) ?? undefined,
      blocked: false,
    };
    this.targets.set(info.targetId, target);
    this.sessions.set(target.sessionId, target);
    await client.send("Runtime.enable", {}, target.sessionId);
    await client.send("Page.enable", {}, target.sessionId);
    await client.send("DOM.enable", {}, target.sessionId);
    const tree = await client.send<{ frameTree: unknown }>(
      "Page.getFrameTree",
      {},
      target.sessionId,
    );
    this.rememberFrameTree(target, tree.frameTree);
    await client.send(
      "Runtime.addBinding",
      { name: this.bindingName, executionContextName: this.worldName },
      target.sessionId,
    );
    const script = await client.send<{ identifier: string }>(
      "Page.addScriptToEvaluateOnNewDocument",
      {
        source: `globalThis.__flowcodeSensorConfig=${JSON.stringify({ binding: this.bindingName, token: this.token })};\n${this.options.sensorSource}`,
        worldName: this.worldName,
        runImmediately: true,
      },
      target.sessionId,
    );
    target.scriptId = script.identifier;
    if (popup) {
      const opener = info.openerId ? this.targets.get(info.openerId) : undefined;
      const url = sanitizeBrowserUrl(info.url);
      await this.options.onEvent({
        type: "browser.tab-open",
        epochMs: Date.now(),
        payload: {
          tabId: target.tabId,
          windowId: 0,
          ...(opener ? { openerTabId: opener.tabId } : {}),
          ...(url ? { url } : {}),
        },
      });
      if (opener)
        await this.options.onEvent({
          type: "browser.popup",
          epochMs: Date.now(),
          payload: {
            tabId: target.tabId,
            windowId: 0,
            openerTabId: opener.tabId,
            ...(url ? { url } : {}),
          },
        });
    }
  }

  private async handleEvent(event: CdpEvent): Promise<void> {
    if (event.method === "Target.targetCreated") {
      const info = TargetInfoSchema.parse(event.params.targetInfo);
      if (
        info.type === "page" &&
        info.openerId &&
        this.targets.has(info.openerId) &&
        this.options.allowAssociatedPopups
      ) {
        const url = sanitizeBrowserUrl(info.url);
        if (!url || info.url === "about:blank" || this.allowed(new URL(url).origin))
          await this.attach(info, true);
        else
          await this.options.onGap(
            "scope-rejected",
            "An associated popup opened outside the approved origins.",
          );
      }
      return;
    }
    if (event.method === "Target.targetDestroyed") {
      const targetId = String(event.params.targetId ?? "");
      const target = this.targets.get(targetId);
      if (!target) return;
      await this.options.onEvent({
        type: "browser.tab-close",
        epochMs: Date.now(),
        payload: { tabId: target.tabId, windowId: 0, isWindowClosing: false },
      });
      this.targets.delete(targetId);
      this.sessions.delete(target.sessionId);
      return;
    }
    if (event.method === "Target.targetInfoChanged") {
      const info = TargetInfoSchema.parse(event.params.targetInfo);
      const target = this.targets.get(info.targetId);
      if (!target) return;
      const url = sanitizeBrowserUrl(info.url);
      target.blocked = Boolean(url && !this.allowed(new URL(url).origin));
      if (target.blocked)
        await this.options.onGap(
          "scope-rejected",
          "A selected Ziniao page navigated outside its approved origin.",
        );
      return;
    }
    const target = event.sessionId ? this.sessions.get(event.sessionId) : undefined;
    if (event.method === "Browser.downloadWillBegin") {
      const url =
        typeof event.params.url === "string"
          ? sanitizeBrowserUrl(event.params.url)
          : null;
      if (!url || !this.allowed(new URL(url).origin)) return;
      const frameId = String(event.params.frameId ?? "");
      const owner = [...this.targets.values()].find((item) => item.frames.has(frameId));
      await this.options.onEvent({
        type: "browser.download",
        epochMs: Date.now(),
        payload: {
          downloadId: this.nextDownloadId++,
          tabId: owner?.tabId ?? null,
          url,
          ...(typeof event.params.suggestedFilename === "string"
            ? { suggestedFilename: event.params.suggestedFilename.slice(0, 512) }
            : {}),
        },
      });
      return;
    }
    if (!target) return;
    if (event.method === "Runtime.executionContextCreated") {
      const context = z
        .object({
          id: z.number().int().positive(),
          name: z.string(),
          auxData: z
            .object({ isDefault: z.boolean(), frameId: z.string() })
            .passthrough()
            .optional(),
        })
        .passthrough()
        .parse(event.params.context);
      if (
        context.name === this.worldName &&
        context.auxData?.isDefault === false
      )
        target.contexts.set(context.id, context.auxData.frameId);
      return;
    }
    if (event.method === "Runtime.executionContextDestroyed") {
      const id = Number(event.params.executionContextId);
      const participated = target.participating.has(id);
      target.contexts.delete(id);
      if (participated && !target.flushed.has(id)) {
        await wait(100);
        if (!target.flushed.has(id))
          await this.options.onGap(
            "source-disconnected",
            "A Ziniao document context ended before its semantic buffer flushed.",
          );
      }
      return;
    }
    if (event.method === "Runtime.executionContextsCleared") {
      const missing = [...target.participating].filter(
        (id) => !target.flushed.has(id),
      ).length;
      target.contexts.clear();
      if (missing)
        await this.options.onGap(
          "source-disconnected",
          `${missing} Ziniao context(s) cleared before flush.`,
          missing,
        );
      return;
    }
    if (event.method === "Page.frameNavigated") {
      const frame = z
        .object({
          id: z.string(),
          parentId: z.string().optional(),
          url: z.string(),
        })
        .passthrough()
        .parse(event.params.frame);
      const sanitized = sanitizeBrowserUrl(frame.url);
      target.frames.set(frame.id, {
        id: frame.id,
        ...(frame.parentId ? { parentId: frame.parentId } : {}),
        url: sanitized ?? frame.url,
      });
      this.frameNumber(target, frame.id);
      if (!frame.parentId && sanitized) {
        const previous = target.lastMainUrl;
        target.lastMainUrl = sanitized;
        target.blocked = !this.allowed(new URL(sanitized).origin);
        if (target.blocked) {
          await this.options.onGap(
            "scope-rejected",
            "The selected Ziniao page left its approved origin.",
          );
        } else if (previous && previous !== sanitized) {
          await this.options.onEvent({
            type: "browser.navigate",
            epochMs: Date.now(),
            payload: {
              tabId: target.tabId,
              frameId: 0,
              documentId: `document-${randomBytes(12).toString("hex")}`,
              url: sanitized,
              navigationKind: "document",
            },
          });
        }
      }
      return;
    }
    if (event.method === "Page.frameDetached") {
      const frameId = String(event.params.frameId ?? "");
      target.frames.delete(frameId);
      return;
    }
    if (event.method === "Runtime.bindingCalled")
      await this.bindingCalled(target, event.params);
  }

  private async bindingCalled(
    target: TargetState,
    params: Record<string, unknown>,
  ): Promise<void> {
    if (params.name !== this.bindingName) return;
    const contextId = Number(params.executionContextId);
    const frameId = target.contexts.get(contextId);
    if (!frameId || target.blocked || typeof params.payload !== "string") return;
    const packet = z
      .object({
        token: z.literal(this.token),
        seq: z.number().int().nonnegative(),
        epochMs: z.number().finite().nonnegative(),
        monotonicMs: z.number().finite().nonnegative(),
        type: z.union([BrowserSemanticEventTypeSchema, z.literal("sensor.flushed")]),
        payload: z.unknown(),
      })
      .strict()
      .parse(JSON.parse(params.payload));
    const key = `${target.targetId}:${contextId}:${packet.seq}`;
    if (this.packetKeys.has(key)) return;
    if (this.packetKeys.size >= 8192) {
      await this.options.onGap(
        "buffer-overflow",
        "The Ziniao packet deduplication window overflowed.",
        1,
      );
      return;
    }
    this.packetKeys.add(key);
    if (packet.type === "sensor.flushed") {
      target.flushed.add(contextId);
      return;
    }
    const content = BrowserContentEventSchema.parse({
      type: packet.type,
      payload: packet.payload,
    });
    const url = new URL(content.payload.url);
    const frame = target.frames.get(frameId);
    if (
      !this.allowed(url.origin) ||
      !frame ||
      (sanitizeBrowserUrl(frame.url) && new URL(frame.url).origin !== url.origin)
    ) {
      await this.options.onGap(
        "identity-changed",
        "A semantic packet did not match its approved frame identity.",
      );
      return;
    }
    target.participating.add(contextId);
    const frameNumber = this.frameNumber(target, frameId);
    const frameLocatorChain =
      frameNumber === 0 ? undefined : await this.frameLocatorChain(target, frameId);
    await this.options.onEvent({
      type: content.type,
      epochMs: packet.epochMs,
      monotonicMs: packet.monotonicMs,
      payload: {
        ...content.payload,
        tabId: target.tabId,
        frameId: frameNumber,
        ...(frameLocatorChain?.length ? { frameLocatorChain } : {}),
      },
    } as ZiniaoAdapterEvent);
  }

  private async frameLocatorChain(
    target: TargetState,
    frameId: string,
  ): Promise<BrowserLocator[]> {
    const chain: BrowserLocator[] = [];
    const ids: string[] = [];
    let current: string | undefined = frameId;
    while (current) {
      const frame = target.frames.get(current);
      if (!frame?.parentId) break;
      ids.unshift(current);
      current = frame.parentId;
    }
    for (const id of ids) {
      try {
        const owner = await this.requireClient().send<{ backendNodeId: number }>(
          "DOM.getFrameOwner",
          { frameId: id },
          target.sessionId,
        );
        const described = await this.requireClient().send<{
          node: { localName?: string; attributes?: unknown };
        }>(
          "DOM.describeNode",
          { backendNodeId: owner.backendNodeId, depth: 0, pierce: true },
          target.sessionId,
        );
        const attrs = attributes(described.node.attributes);
        const tag = described.node.localName || "iframe";
        const idValue = attrs.get("id");
        const selector =
          idValue && isStableDomId(idValue)
            ? `#${cssEscape(idValue)}`
            : attrs.get("data-testid")
              ? `[data-testid="${cssEscape(attrs.get("data-testid")!)}"]`
              : attrs.get("title")
                ? `${tag}[title="${cssEscape(attrs.get("title")!)}"]`
                : attrs.get("name")
                  ? `${tag}[name="${cssEscape(attrs.get("name")!)}"]`
                  : tag;
        chain.push({ kind: "css", value: selector.slice(0, 512), unique: false, score: 20 });
      } catch {
        chain.push({ kind: "css", value: "iframe", unique: false, score: 5 });
      }
    }
    return chain;
  }

  private rememberFrameTree(target: TargetState, raw: unknown): void {
    const node = z
      .object({
        frame: z
          .object({ id: z.string(), parentId: z.string().optional(), url: z.string() })
          .passthrough(),
        childFrames: z.array(z.unknown()).optional(),
      })
      .passthrough()
      .parse(raw);
    const sanitized = sanitizeBrowserUrl(node.frame.url);
    target.frames.set(node.frame.id, {
      id: node.frame.id,
      ...(node.frame.parentId ? { parentId: node.frame.parentId } : {}),
      url: sanitized ?? node.frame.url,
    });
    this.frameNumber(target, node.frame.id);
    for (const child of node.childFrames ?? []) this.rememberFrameTree(target, child);
  }

  private frameNumber(target: TargetState, frameId: string): number {
    const existing = target.frameNumbers.get(frameId);
    if (existing !== undefined) return existing;
    const frame = target.frames.get(frameId);
    const value = frame?.parentId ? target.frameNumbers.size : 0;
    target.frameNumbers.set(frameId, value);
    return value;
  }

  private missingFlushes(): number {
    let count = 0;
    for (const target of this.targets.values())
      count += [...target.participating].filter(
        (id) => target.contexts.has(id) && !target.flushed.has(id),
      ).length;
    return count;
  }

  private allowed(origin: string): boolean {
    return this.allowedOrigins.has(origin);
  }

  private requireClient(): CdpTransport {
    if (!this.client) throw new Error("The Ziniao CDP connection is not active.");
    return this.client;
  }
}

export const ZINIAO_CAPTURE_PROVIDER: BrowserCaptureProvider = "ziniao";
