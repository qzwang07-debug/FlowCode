import { z } from "zod";

import { sanitizeBrowserUrl } from "../../apps/browser-extension/src/privacy/url";

const ErrorSchema = z
  .object({ code: z.number().int(), message: z.string() })
  .passthrough();
const MessageSchema = z
  .object({
    id: z.number().int().positive().optional(),
    method: z.string().optional(),
    params: z.record(z.string(), z.unknown()).optional(),
    sessionId: z.string().optional(),
    result: z.record(z.string(), z.unknown()).optional(),
    error: ErrorSchema.optional(),
  })
  .passthrough();

export interface CdpEvent {
  method: string;
  params: Record<string, unknown>;
  sessionId?: string;
}

interface PendingCall {
  resolve(value: Record<string, unknown>): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

export interface CdpTransport {
  send<T extends Record<string, unknown> = Record<string, unknown>>(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
    timeoutMs?: number,
  ): Promise<T>;
  onEvent(listener: (event: CdpEvent) => void): () => void;
  onClose(listener: (error: Error | null) => void): () => void;
  close(): Promise<void>;
}

export class CdpClient implements CdpTransport {
  private nextId = 1;
  private readonly pending = new Map<number, PendingCall>();
  private readonly listeners = new Set<(event: CdpEvent) => void>();
  private readonly closeListeners = new Set<(error: Error | null) => void>();
  private closed = false;

  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener("message", (event) => this.message(event));
    socket.addEventListener("close", () => this.closedEvent(null));
    socket.addEventListener("error", () =>
      this.closedEvent(new Error("The Ziniao CDP connection failed.")),
    );
  }

  static async connect(
    webSocketDebuggerUrl: string,
    signal?: AbortSignal,
  ): Promise<CdpClient> {
    const url = new URL(webSocketDebuggerUrl);
    if (
      url.protocol !== "ws:" ||
      !["127.0.0.1", "localhost"].includes(url.hostname)
    )
      throw new Error("Only an owned loopback Ziniao endpoint may be used.");
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        socket.removeEventListener("open", opened);
        socket.removeEventListener("error", failed);
        signal?.removeEventListener("abort", aborted);
      };
      const opened = () => {
        cleanup();
        resolve();
      };
      const failed = () => {
        cleanup();
        reject(new Error("Could not connect to the selected Ziniao store."));
      };
      const aborted = () => {
        cleanup();
        socket.close();
        reject(new Error("Ziniao connection was canceled."));
      };
      socket.addEventListener("open", opened, { once: true });
      socket.addEventListener("error", failed, { once: true });
      signal?.addEventListener("abort", aborted, { once: true });
    });
    return new CdpClient(socket);
  }

  send<T extends Record<string, unknown> = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
    timeoutMs = 10000,
  ): Promise<T> {
    if (this.closed || this.socket.readyState !== WebSocket.OPEN)
      return Promise.reject(new Error("The Ziniao CDP connection is closed."));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Ziniao CDP command timed out: ${method}.`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      this.socket.send(
        JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }),
      );
    });
  }

  onEvent(listener: (event: CdpEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onClose(listener: (error: Error | null) => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("The Ziniao CDP connection was closed."));
    }
    this.pending.clear();
    if (this.socket.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 1000);
      this.socket.addEventListener(
        "close",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      this.socket.close();
    });
  }

  private message(event: MessageEvent): void {
    let text: string;
    if (typeof event.data === "string") text = event.data;
    else if (event.data instanceof ArrayBuffer)
      text = Buffer.from(event.data).toString("utf8");
    else return;
    let message: z.infer<typeof MessageSchema>;
    try {
      message = MessageSchema.parse(JSON.parse(text));
    } catch {
      return;
    }
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error)
        pending.reject(
          new Error(`Ziniao CDP error ${message.error.code}: ${message.error.message}`),
        );
      else pending.resolve(message.result ?? {});
      return;
    }
    if (!message.method) return;
    const value: CdpEvent = {
      method: message.method,
      params: message.params ?? {},
      ...(message.sessionId ? { sessionId: message.sessionId } : {}),
    };
    for (const listener of this.listeners) listener(value);
  }

  private closedEvent(error: Error | null): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error ?? new Error("The Ziniao CDP connection ended."));
    }
    this.pending.clear();
    for (const listener of this.closeListeners) listener(error);
  }
}

export interface ZiniaoCdpPage {
  targetId: string;
  title: string;
  url: string;
  origin: string;
  frameOrigins: string[];
}

function frameOrigins(raw: unknown): string[] {
  const origins = new Set<string>();
  const visit = (node: unknown) => {
    const parsed = z
      .object({
        frame: z.object({ url: z.string() }).passthrough(),
        childFrames: z.array(z.unknown()).optional(),
      })
      .passthrough()
      .safeParse(node);
    if (!parsed.success) return;
    const sanitized = sanitizeBrowserUrl(parsed.data.frame.url);
    if (sanitized) origins.add(new URL(sanitized).origin);
    for (const child of parsed.data.childFrames ?? []) visit(child);
  };
  visit(raw);
  return [...origins];
}

export async function listZiniaoPages(
  webSocketDebuggerUrl: string,
  signal?: AbortSignal,
): Promise<ZiniaoCdpPage[]> {
  const client = await CdpClient.connect(webSocketDebuggerUrl, signal);
  try {
    const response = await client.send<{ targetInfos: unknown[] }>(
      "Target.getTargets",
    );
    const targets = z
      .array(
        z
          .object({
            targetId: z.string().min(1),
            type: z.string(),
            title: z.string(),
            url: z.string(),
          })
          .passthrough(),
      )
      .safeParse(response.targetInfos)
      .data?.flatMap((target) => {
        if (target.type !== "page") return [];
        const url = sanitizeBrowserUrl(target.url);
        if (!url) return [];
        return [
          {
            targetId: target.targetId,
            title: target.title.slice(0, 1024),
            url,
            origin: new URL(url).origin,
            frameOrigins: [],
          },
        ];
      }) ?? [];
    const pages: ZiniaoCdpPage[] = [];
    for (const target of targets) {
      let sessionId: string | undefined;
      try {
        const attached = await client.send<{ sessionId: string }>(
          "Target.attachToTarget",
          { targetId: target.targetId, flatten: true },
        );
        sessionId = attached.sessionId;
        const tree = await client.send<{ frameTree: unknown }>(
          "Page.getFrameTree",
          {},
          sessionId,
        );
        pages.push({
          ...target,
          frameOrigins: frameOrigins(tree.frameTree).filter(
            (origin) => origin !== target.origin,
          ),
        });
      } catch {
        pages.push(target);
      } finally {
        if (sessionId)
          await client
            .send("Target.detachFromTarget", { sessionId })
            .catch(() => undefined);
      }
    }
    return pages;
  } finally {
    await client.close();
  }
}
