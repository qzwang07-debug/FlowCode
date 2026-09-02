import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import net, { type Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  BrowserBridgeRuntimeSchema,
  type BrowserBridgeRegistration,
  type BrowserToDesktopMessage,
} from "../../common/browser";
import { encodeLengthPrefixedJson, LengthPrefixedJsonDecoder } from "./framing";
import {
  BROWSER_BRIDGE_RUNTIME_FILE,
  NativeBridgeServer,
  type NativeBrowserConnection,
} from "./server";

const registration: BrowserBridgeRegistration = {
  schemaVersion: 1,
  desktopExecutable: "C:\\FlowCode\\FlowCode.exe",
  clients: [
    {
      browser: "chrome",
      nativeHost: "com.flowcode.browser.chrome",
      origin: "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/",
    },
    {
      browser: "edge",
      nativeHost: "com.flowcode.browser.edge",
      origin: "chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/",
    },
  ],
};

async function connect(endpoint: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(endpoint);
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

async function nextMessage(socket: Socket): Promise<unknown> {
  const decoder = new LengthPrefixedJsonDecoder();
  return new Promise((resolve, reject) => {
    const onData = (chunk: Buffer) => {
      try {
        const [message] = decoder.push(chunk);
        if (message === undefined) return;
        socket.off("data", onData);
        resolve(message);
      } catch (error) {
        reject(error);
      }
    };
    socket.on("data", onData);
    socket.once("error", reject);
  });
}

test("native bridge authenticates the runtime token and exact extension origin", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "flowcode-native-bridge-"));
  const connected: NativeBrowserConnection[] = [];
  const messages: BrowserToDesktopMessage[] = [];
  const rejected: string[] = [];
  const server = new NativeBridgeServer({ dataDir: root, registration });
  server.setListener({
    connected: (connection) => connected.push(connection),
    message: (_connection, message) => {
      messages.push(message);
    },
    disconnected: () => undefined,
    rejected: (reason) => rejected.push(reason),
  });
  try {
    const runtime = await server.start();
    assert.deepEqual(
      BrowserBridgeRuntimeSchema.parse(
        JSON.parse(
          await readFile(path.join(root, BROWSER_BRIDGE_RUNTIME_FILE), "utf8"),
        ) as unknown,
      ),
      runtime,
    );

    const bad = await connect(runtime.endpoint);
    bad.write(
      encodeLengthPrefixedJson({
        kind: "bridge.connect",
        protocolVersion: 1,
        token: "0".repeat(64),
        origin: registration.clients[0].origin,
      }),
    );
    await new Promise<void>((resolve) => bad.once("close", () => resolve()));
    assert.match(rejected.at(-1) ?? "", /authentication/i);

    const socket = await connect(runtime.endpoint);
    socket.write(
      encodeLengthPrefixedJson({
        kind: "bridge.connect",
        protocolVersion: 1,
        token: runtime.token,
        origin: registration.clients[0].origin,
      }),
    );
    assert.deepEqual(await nextMessage(socket), {
      kind: "desktop.hello",
      protocolVersion: 1,
    });
    assert.equal(connected.length, 1);
    assert.equal(connected[0].browser, "chrome");
    socket.write(
      encodeLengthPrefixedJson({
        kind: "state.get",
        protocolVersion: 1,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(messages[0]?.kind, "state.get");
    socket.destroy();
  } finally {
    await server.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("native bridge rejects an unregistered origin and oversized frame", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "flowcode-native-reject-"));
  const rejected: string[] = [];
  const server = new NativeBridgeServer({ dataDir: root, registration });
  server.setListener({
    connected: () => undefined,
    message: () => undefined,
    disconnected: () => undefined,
    rejected: (reason) => rejected.push(reason),
  });
  try {
    const runtime = await server.start();
    const wrongOrigin = await connect(runtime.endpoint);
    wrongOrigin.write(
      encodeLengthPrefixedJson({
        kind: "bridge.connect",
        protocolVersion: 1,
        token: runtime.token,
        origin: "chrome-extension://cccccccccccccccccccccccccccccccc/",
      }),
    );
    await new Promise<void>((resolve) =>
      wrongOrigin.once("close", () => resolve()),
    );
    assert.match(rejected.at(-1) ?? "", /not registered/i);

    const oversized = await connect(runtime.endpoint);
    const prefix = Buffer.alloc(4);
    prefix.writeUInt32LE(runtime.maxMessageBytes + 1, 0);
    oversized.write(prefix);
    await new Promise<void>((resolve) =>
      oversized.once("close", () => resolve()),
    );
    assert.match(rejected.at(-1) ?? "", /outside the allowed range/i);
  } finally {
    await server.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
