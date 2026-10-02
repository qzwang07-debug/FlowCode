import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { BrowserEnvironmentProfileSchema, BrowserSourceIdentitySchema } from "../../common/browser-environment";
import { ZiniaoLeaseStore } from "../ziniao/profile-store";
import { validatedZiniaoCapabilities } from "../ziniao/capabilities";
import { RecordedBrowserAccess } from "./browser-binding";

test("recorded store values remain private and changed profile invalidates capabilities/scope", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "flowcode-analyzer-binding-"));
  const profile = BrowserEnvironmentProfileSchema.parse({ schemaVersion: 1, id: "fixture-profile", revision: 1, provider: "ziniao",
    binding: { accountRef: "a".repeat(64), storeId: "fixture-store", expectedName: "Fixture store" },
    siteScopes: ["https://fixture.test"], displayMode: "visible", loginMode: "existing-context", capabilities: validatedZiniaoCapabilities(1000) });
  try {
    const lease = await new ZiniaoLeaseStore(root, () => 1000).acquire({ profile, sessionId: "fixture-session", pageId: "fixture-page",
      allowAssociatedPopups: false, launchOwnership: "borrowed" });
    const source = BrowserSourceIdentitySchema.parse({ schemaVersion: 2, sourceId: "ziniao:fixture-source", sessionId: "fixture-session",
      provider: "ziniao", environmentProfileId: profile.id, leaseId: lease.id, actor: "human", transport: "cdp-adapter" });
    await writeFile(path.join(root, "browser-source.json"), JSON.stringify(source));
    await writeFile(path.join(root, "browser-lease.json"), JSON.stringify(lease));
    const access = new RecordedBrowserAccess(() => root, async () => profile);
    const before = await access.scopeHash("fixture-session");
    assert.deepEqual(await access.privateValues("fixture-session"), ["fixture-store", "Fixture store"]);
    assert.equal((await access.capabilities(source))?.provider, "ziniao");
    profile.revision++; assert.equal(profile.provider, "ziniao");
    if (profile.provider === "ziniao") profile.binding.storeId = "different-fixture-store";
    assert.notEqual(await access.scopeHash("fixture-session"), before);
    assert.equal(await access.capabilities(source), null);
    assert.deepEqual(await access.privateValues("fixture-session"), ["fixture-store", "Fixture store"]);
    assert.equal(await access.capabilities({ ...source, sourceId: "ziniao:foreign-source" }), null);
    await writeFile(path.join(root, "browser-lease.json"), JSON.stringify({ ...lease, owner: { kind: "recording", sessionId: "other-session" } }));
    await assert.rejects(access.privateValues("fixture-session"), /identity mismatch/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
