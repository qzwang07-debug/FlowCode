import assert from "node:assert/strict";
import {
  execFile,
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  BrowserBridgeRegistrationSchema,
  NativeHostManifestSchema,
  type BrowserToDesktopMessage,
} from "../../common/browser";
import { encodeLengthPrefixedJson, LengthPrefixedJsonDecoder } from "./framing";
import { NativeBridgeServer, type NativeBrowserConnection } from "./server";

const execFileAsync = promisify(execFile);

async function removeTestRoot(root: string): Promise<void> {
  await rm(root, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  });
}

test("Windows registration builds separate exact-origin native hosts in a temporary directory", async (context) => {
  if (process.platform !== "win32") {
    context.skip("Windows-only native host compilation");
    return;
  }
  const root = await mkdtemp(path.join(tmpdir(), "flowcode-browser-register-"));
  try {
    const arguments_ = [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      path.resolve("scripts/register-browser-bridge.ps1"),
      "-DesktopExecutable",
      process.execPath,
      "-InstallDirectory",
      root,
      "-SkipRegistry",
    ];
    await execFileAsync("powershell.exe", arguments_, {
      windowsHide: true,
      // Hosted Windows runners compile the C# host concurrently with the native
      // packaging jobs. A cold compiler can exceed 30 seconds without hanging.
      timeout: 90_000,
    });
    await execFileAsync("powershell.exe", arguments_, {
      windowsHide: true,
      timeout: 90_000,
    });
    assert.ok(
      (await stat(path.join(root, "flowcode-browser-host.exe"))).size > 0,
    );
    const registration = BrowserBridgeRegistrationSchema.parse(
      JSON.parse(
        await readFile(
          path.join(root, "browser-bridge-registration.json"),
          "utf8",
        ),
      ) as unknown,
    );
    assert.equal(registration.clients.length, 2);
    const origins = new Set(
      registration.clients.map((client) => client.origin),
    );
    assert.equal(origins.size, 2);
    for (const client of registration.clients) {
      const manifest = NativeHostManifestSchema.parse(
        JSON.parse(
          await readFile(path.join(root, `${client.nativeHost}.json`), "utf8"),
        ) as unknown,
      );
      assert.deepEqual(manifest.allowed_origins, [client.origin]);
      const [manifestExecutable, expectedExecutable] = await Promise.all([
        realpath(manifest.path),
        realpath(path.join(root, "flowcode-browser-host.exe")),
      ]);
      assert.equal(
        path.normalize(manifestExecutable).toLowerCase(),
        path.normalize(expectedExecutable).toLowerCase(),
      );
    }
  } finally {
    await removeTestRoot(root);
  }
});

test("registration scripts use per-user Chrome and Edge keys and parse cleanly", async () => {
  const [register, unregister] = await Promise.all([
    readFile("scripts/register-browser-bridge.ps1", "utf8"),
    readFile("scripts/unregister-browser-bridge.ps1", "utf8"),
  ]);
  assert.match(register, /Google\\Chrome\\NativeMessagingHosts/);
  assert.match(register, /Microsoft\\Edge\\NativeMessagingHosts/);
  assert.doesNotMatch(register, /allowed_origins\s*=\s*@\([^)]*\*/s);
  assert.match(unregister, /GetValue\(""\)/);
  assert.match(unregister, /\$ownedFiles/);
  assert.doesNotMatch(unregister, /Remove-Item[^\r\n]*-Recurse/);
  if (process.platform === "win32") {
    for (const script of [register, unregister]) {
      const escaped = script.replaceAll("'", "''");
      await execFileAsync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `$errors=$null; [System.Management.Automation.Language.Parser]::ParseInput('${escaped}',[ref]$null,[ref]$errors) > $null; if($errors.Count){exit 1}`,
        ],
        { windowsHide: true, timeout: 10_000 },
      );
    }
  }
});

test("the compiled Windows host relays framed messages to and from Desktop", async (context) => {
  if (process.platform !== "win32") {
    context.skip("Windows-only native host integration");
    return;
  }
  const root = await mkdtemp(path.join(tmpdir(), "flowcode-browser-host-"));
  let server: NativeBridgeServer | null = null;
  let child: ChildProcessWithoutNullStreams | null = null;
  let childClosed: Promise<void> | null = null;
  try {
    await execFileAsync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        path.resolve("scripts/register-browser-bridge.ps1"),
        "-DesktopExecutable",
        process.execPath,
        "-InstallDirectory",
        root,
        "-SkipRegistry",
      ],
      { windowsHide: true, timeout: 30_000 },
    );
    let connection: NativeBrowserConnection | null = null;
    let received: BrowserToDesktopMessage | null = null;
    server = new NativeBridgeServer({ dataDir: root });
    server.setListener({
      connected: (value) => {
        connection = value;
      },
      message: (_connection, message) => {
        received = message;
      },
      disconnected: () => undefined,
    });
    await server.start();
    const registration = BrowserBridgeRegistrationSchema.parse(
      JSON.parse(
        await readFile(
          path.join(root, "browser-bridge-registration.json"),
          "utf8",
        ),
      ) as unknown,
    );
    const nativeHost = spawn(
      path.join(root, "flowcode-browser-host.exe"),
      [registration.clients[0].origin],
      { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
    );
    child = nativeHost;
    childClosed = new Promise((resolve) =>
      nativeHost.once("close", () => resolve()),
    );
    const decoder = new LengthPrefixedJsonDecoder();
    const outputMessages: unknown[] = [];
    nativeHost.stdout.on("data", (chunk: Buffer) => {
      outputMessages.push(...decoder.push(chunk));
    });
    let deadline = Date.now() + 20_000;
    while (!connection || outputMessages.length === 0) {
      if (Date.now() >= deadline)
        throw new Error("Native host did not connect.");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.deepEqual(outputMessages.shift(), {
      kind: "desktop.hello",
      protocolVersion: 1,
    });
    nativeHost.stdin.write(
      encodeLengthPrefixedJson({
        kind: "state.get",
        protocolVersion: 1,
      }),
    );
    deadline = Date.now() + 20_000;
    while (!received) {
      if (Date.now() >= deadline)
        throw new Error("Native host did not relay input.");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const relayed = received as BrowserToDesktopMessage;
    assert.equal(relayed.kind, "state.get");
    const connected = connection as NativeBrowserConnection;
    server.send(connected.id, {
      kind: "record.state",
      protocolVersion: 1,
      state: "idle",
    });
    deadline = Date.now() + 20_000;
    while (outputMessages.length === 0) {
      if (Date.now() >= deadline)
        throw new Error("Native host did not relay output.");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.deepEqual(outputMessages.shift(), {
      kind: "record.state",
      protocolVersion: 1,
      state: "idle",
    });
    nativeHost.stdin.end();
    await childClosed;
    child = null;
    childClosed = null;
  } finally {
    if (child) {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      if (childClosed) await childClosed;
    }
    await server?.dispose();
    await removeTestRoot(root);
  }
});
