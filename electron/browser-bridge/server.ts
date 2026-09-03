import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import net, { type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  BROWSER_BRIDGE_PROTOCOL_VERSION,
  BrowserBridgeRegistrationSchema,
  BrowserBridgeRuntimeSchema,
  BrowserToDesktopMessageSchema,
  DesktopToBrowserMessageSchema,
  MAX_BROWSER_MESSAGE_BYTES,
  NativeBridgeConnectSchema,
  type BrowserBridgeRegistration,
  type BrowserBridgeRuntime,
  type BrowserKind,
  type BrowserToDesktopMessage,
  type DesktopToBrowserMessage,
} from "../../common/browser";
import { encodeLengthPrefixedJson, LengthPrefixedJsonDecoder } from "./framing";

export const BROWSER_BRIDGE_REGISTRATION_FILE =
  "browser-bridge-registration.json";
export const BROWSER_BRIDGE_RUNTIME_FILE = "browser-bridge-runtime.json";

export interface NativeBrowserConnection {
  id: string;
  browser: BrowserKind;
  origin: string;
}

export interface NativeBridgeServerListener {
  connected(connection: NativeBrowserConnection): void;
  message(
    connection: NativeBrowserConnection,
    message: BrowserToDesktopMessage,
  ): void | Promise<void>;
  disconnected(connection: NativeBrowserConnection): void;
  rejected?(reason: string): void;
}

export interface NativeBridgeServerOptions {
  dataDir: string;
  registration?: BrowserBridgeRegistration;
  authenticationTimeoutMs?: number;
}

interface LiveConnection extends NativeBrowserConnection {
  socket: Socket;
}

async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  const temporary = `${file}.tmp.${process.pid}.${randomUUID()}`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function loadRegistration(dataDir: string): Promise<{
  registration: BrowserBridgeRegistration | null;
  error: string | null;
}> {
  try {
    const raw = JSON.parse(
      await readFile(
        path.join(dataDir, BROWSER_BRIDGE_REGISTRATION_FILE),
        "utf8",
      ),
    ) as unknown;
    return {
      registration: BrowserBridgeRegistrationSchema.parse(raw),
      error: null,
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") return { registration: null, error: null };
    return {
      registration: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

const MAX_SAFE_UNIX_ENDPOINT_BYTES = 96;

function bridgeEndpoint(): string {
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\flowcode-browser-${process.pid}-${randomUUID()}`;
  }
  const fileName = `fc-${process.pid}-${randomBytes(12).toString("hex")}.sock`;
  const preferred = path.join(tmpdir(), fileName);
  return Buffer.byteLength(preferred, "utf8") <= MAX_SAFE_UNIX_ENDPOINT_BYTES
    ? preferred
    : path.join("/tmp", fileName);
}

function tokensMatch(expected: string, actual: string): boolean {
  const expectedBytes = Buffer.from(expected, "hex");
  const actualBytes = Buffer.from(actual, "hex");
  return (
    expectedBytes.length === actualBytes.length &&
    timingSafeEqual(expectedBytes, actualBytes)
  );
}

export class NativeBridgeServer {
  private listener: NativeBridgeServerListener | null = null;
  private server: Server | null = null;
  private runtime: BrowserBridgeRuntime | null = null;
  private registration: BrowserBridgeRegistration | null = null;
  private readonly connections = new Map<string, LiveConnection>();
  private disposed = false;
  registrationError: string | null = null;

  constructor(private readonly options: NativeBridgeServerOptions) {}

  setListener(listener: NativeBridgeServerListener): void {
    if (this.server)
      throw new Error("Bridge listener must be set before start.");
    this.listener = listener;
  }

  async start(): Promise<BrowserBridgeRuntime> {
    if (this.server || this.disposed)
      throw new Error("Native bridge cannot be started.");
    if (!this.listener)
      throw new Error("Native bridge listener is not configured.");
    await mkdir(this.options.dataDir, { recursive: true });
    const loaded = this.options.registration
      ? {
          registration: BrowserBridgeRegistrationSchema.parse(
            this.options.registration,
          ),
          error: null,
        }
      : await loadRegistration(this.options.dataDir);
    this.registration = loaded.registration;
    this.registrationError = loaded.error;
    const runtime = BrowserBridgeRuntimeSchema.parse({
      schemaVersion: 1,
      endpoint: bridgeEndpoint(),
      token: randomBytes(32).toString("hex"),
      maxMessageBytes: MAX_BROWSER_MESSAGE_BYTES,
    });
    const server = net.createServer((socket) => this.accept(socket, runtime));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(runtime.endpoint);
    });
    this.runtime = runtime;
    if (process.platform !== "win32") {
      await chmod(runtime.endpoint, 0o600);
    }
    await writeJsonAtomic(
      path.join(this.options.dataDir, BROWSER_BRIDGE_RUNTIME_FILE),
      runtime,
    );
    return runtime;
  }

  registrationFor(browser: BrowserKind): boolean {
    return (
      this.registration?.clients.some((client) => client.browser === browser) ??
      false
    );
  }

  listConnections(): NativeBrowserConnection[] {
    return [...this.connections.values()].map(({ id, browser, origin }) => ({
      id,
      browser,
      origin,
    }));
  }

  send(connectionId: string, input: DesktopToBrowserMessage): boolean {
    const connection = this.connections.get(connectionId);
    if (!connection || connection.socket.destroyed) return false;
    const message = DesktopToBrowserMessageSchema.parse(input);
    try {
      connection.socket.write(encodeLengthPrefixedJson(message));
      return true;
    } catch {
      connection.socket.destroy();
      return false;
    }
  }

  closeConnection(connectionId: string): void {
    this.connections.get(connectionId)?.socket.destroy();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    for (const connection of this.connections.values())
      connection.socket.destroy();
    this.connections.clear();
    const server = this.server;
    this.server = null;
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    const runtimeFile = path.join(
      this.options.dataDir,
      BROWSER_BRIDGE_RUNTIME_FILE,
    );
    if (this.runtime) {
      try {
        const current = BrowserBridgeRuntimeSchema.parse(
          JSON.parse(await readFile(runtimeFile, "utf8")) as unknown,
        );
        if (current.token === this.runtime.token)
          await rm(runtimeFile, { force: true });
      } catch {
        // A newer process or a missing file must never be removed blindly.
      }
      if (process.platform !== "win32") {
        await rm(this.runtime.endpoint, { force: true });
      }
    }
    this.runtime = null;
  }

  private accept(socket: Socket, runtime: BrowserBridgeRuntime): void {
    socket.setNoDelay(true);
    const decoder = new LengthPrefixedJsonDecoder(runtime.maxMessageBytes);
    let connection: LiveConnection | null = null;
    let rejected = false;
    const reject = (reason: string) => {
      if (rejected) return;
      rejected = true;
      this.listener?.rejected?.(reason);
      socket.destroy();
    };
    const authenticationTimer = setTimeout(
      () => reject("Native host did not authenticate in time."),
      this.options.authenticationTimeoutMs ?? 2000,
    );
    authenticationTimer.unref?.();

    socket.on("data", (chunk) => {
      let messages: unknown[];
      try {
        messages = decoder.push(chunk);
      } catch (error) {
        reject(error instanceof Error ? error.message : String(error));
        return;
      }
      for (const raw of messages) {
        if (!connection) {
          const connect = NativeBridgeConnectSchema.safeParse(raw);
          if (
            !connect.success ||
            !tokensMatch(runtime.token, connect.data.token)
          ) {
            reject("Native host authentication failed.");
            return;
          }
          const client = this.registration?.clients.find(
            (candidate) => candidate.origin === connect.data.origin,
          );
          if (!client) {
            reject("Native host origin is not registered.");
            return;
          }
          clearTimeout(authenticationTimer);
          connection = {
            id: `connection-${randomUUID()}`,
            browser: client.browser,
            origin: client.origin,
            socket,
          };
          this.connections.set(connection.id, connection);
          this.listener?.connected(connection);
          this.send(connection.id, {
            kind: "desktop.hello",
            protocolVersion: BROWSER_BRIDGE_PROTOCOL_VERSION,
          });
          continue;
        }
        const message = BrowserToDesktopMessageSchema.safeParse(raw);
        if (!message.success) {
          reject("Native host forwarded an invalid browser message.");
          return;
        }
        void this.listener?.message(connection, message.data);
      }
    });
    socket.on("end", () => {
      try {
        decoder.finish();
      } catch (error) {
        this.listener?.rejected?.(
          error instanceof Error ? error.message : String(error),
        );
      }
    });
    socket.on("error", () => undefined);
    socket.on("close", () => {
      clearTimeout(authenticationTimer);
      if (!connection) return;
      this.connections.delete(connection.id);
      this.listener?.disconnected(connection);
    });
  }
}
