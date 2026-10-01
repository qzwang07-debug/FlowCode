import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { FREE_PROVIDER } from "../../common/analyzer";
import { ProviderStore } from "./provider-store";
import { WindowsCredentialVault } from "./windows-credentials";
import { contractHash } from "../evidence/blueprint-contract";
test("provider keys are vault-only and never returned or persisted with settings", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "flowcode-provider-"));
  const secrets = new Map<string, string>();
  const store = new ProviderStore(root, { read: async id => secrets.get(id), write: async (id, s) => { secrets.set(id, s); }, remove: async id => { secrets.delete(id); } });
  try {
    const value = await store.save({ settings: { ...FREE_PROVIDER, authentication: "credential-manager" }, apiKey: "synthetic-private-key" });
    assert.equal(value.keyPresent, true);
    assert.ok(!JSON.stringify(value).includes("synthetic-private-key"));
    assert.ok(!(await readFile(path.join(root, "provider.json"), "utf8")).includes("synthetic-private-key"));
    await store.setCapabilities({ settingsHash: contractHash(value.settings), checkedAt: Date.now(), toolCalling: "supported", structuredOutput: "supported", vision: "unknown", detail: "Synthetic fixture" });
    await store.save({ settings: value.settings, apiKey: "another-synthetic-key" });
    assert.equal((await store.view()).capabilities, null);
    await assert.rejects(store.save({ settings: { ...FREE_PROVIDER, baseUrl: "https://user:secret@example.test" } }));
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("real Windows Credential Manager roundtrip uses only a synthetic task-owned entry", { skip: process.platform !== "win32" }, async () => {
  const id = `test-${randomUUID()}`; const vault = new WindowsCredentialVault();
  try { assert.equal(await vault.read(id), undefined); await vault.write(id, "synthetic-模型-key"); assert.equal(await vault.read(id), "synthetic-模型-key"); }
  finally { await vault.remove(id); }
  assert.equal(await vault.read(id), undefined);
});
