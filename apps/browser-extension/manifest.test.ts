import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { BrowserExtensionConfigSchema } from "../../common/browser";

function extensionId(key: string): string {
  const digest = createHash("sha256")
    .update(Buffer.from(key, "base64"))
    .digest()
    .subarray(0, 16);
  return [...digest]
    .map((byte) => String.fromCharCode(97 + (byte >> 4), 97 + (byte & 0x0f)))
    .join("");
}

test("Chrome and Edge MV3 manifests keep all site access optional", async () => {
  const packageVersion = (
    JSON.parse(await readFile("package.json", "utf8")) as { version: string }
  ).version;
  const ids = new Set<string>();
  const hosts = new Set<string>();
  for (const browser of ["chrome", "edge"] as const) {
    const manifest = JSON.parse(
      await readFile(
        path.join("apps", "browser-extension", "manifests", `${browser}.json`),
        "utf8",
      ),
    ) as Record<string, unknown>;
    const config = BrowserExtensionConfigSchema.parse(
      JSON.parse(
        await readFile(
          path.join("apps", "browser-extension", "config", `${browser}.json`),
          "utf8",
        ),
      ),
    );
    assert.equal(manifest.manifest_version, 3);
    assert.equal(manifest.version, packageVersion);
    assert.equal(manifest.host_permissions, undefined);
    assert.equal(manifest.content_scripts, undefined);
    assert.equal(manifest.externally_connectable, undefined);
    assert.deepEqual(manifest.optional_host_permissions, [
      "http://*/*",
      "https://*/*",
    ]);
    assert.equal(
      (manifest.permissions as string[]).includes("debugger"),
      false,
    );
    assert.equal(
      (manifest.permissions as string[]).includes("nativeMessaging"),
      true,
    );
    assert.equal(extensionId(String(manifest.key)), config.extensionId);
    assert.equal(config.browser, browser);
    ids.add(config.extensionId);
    hosts.add(config.nativeHost);
  }
  assert.equal(ids.size, 2);
  assert.equal(hosts.size, 2);
});

test("content events are trusted-only and cross the validated extension channel", async () => {
  const [content, worker] = await Promise.all([
    readFile("apps/browser-extension/src/content/content-script.ts", "utf8"),
    readFile(
      "apps/browser-extension/src/service-worker/service-worker.ts",
      "utf8",
    ),
  ]);
  assert.match(content, /event\.isTrusted/);
  assert.doesNotMatch(content, /addEventListener\(["']message["']/);
  assert.match(content, /chrome\.runtime\.connect/);
  assert.match(worker, /ContentToServiceWorkerMessageSchema\.safeParse/);
  assert.match(worker, /sender\?\.id !== chrome\.runtime\.id/);
  assert.match(worker, /chrome\.permissions\.contains/);
  assert.match(worker, /target: \{ tabId, allFrames: true \}/);
});
