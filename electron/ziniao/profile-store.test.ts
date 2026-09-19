import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { BrowserEnvironmentProfileSchema } from "../../common/browser-environment";
import { validatedZiniaoCapabilities } from "./capabilities";
import { ZiniaoLeaseStore, ZiniaoProfileStore } from "./profile-store";

function profile(id = "env-1") {
  return BrowserEnvironmentProfileSchema.parse({
    schemaVersion: 1,
    id,
    revision: 1,
    provider: "ziniao",
    binding: {
      accountRef: "a".repeat(64),
      storeId: "fixture-store",
      expectedName: "Fixture store",
    },
    siteScopes: ["https://fixture.example"],
    displayMode: "visible",
    loginMode: "existing-context",
    capabilities: validatedZiniaoCapabilities(100),
  });
}

test("Ziniao profiles persist exact bindings without endpoints and reject duplicates", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "flowcode-ziniao-profiles-"));
  try {
    const store = new ZiniaoProfileStore(root);
    const saved = await store.save(profile());
    assert.equal(saved.storeId, "fixture-store");
    assert.equal(saved.storeName, "Fixture store");
    assert.deepEqual((await store.get("env-1")).siteScopes, [
      "https://fixture.example",
    ]);
    await assert.rejects(store.save(profile("env-2")), /already bound/i);
    assert.equal(JSON.stringify(await store.list()).includes("cdp"), true);
    assert.equal(JSON.stringify(await store.list()).includes("ws://"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("single-store recording leases conflict, release, and stale recovery are explicit", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "flowcode-ziniao-leases-"));
  let now = 1000;
  try {
    const leases = new ZiniaoLeaseStore(root, () => now);
    await leases.initialize();
    const first = await leases.acquire({
      profile: profile(),
      sessionId: "session-1",
      pageId: "page-1",
      allowAssociatedPopups: true,
      launchOwnership: "borrowed",
    });
    await assert.rejects(
      leases.acquire({
        profile: profile(),
        sessionId: "session-2",
        pageId: "page-2",
        allowAssociatedPopups: false,
        launchOwnership: "borrowed",
      }),
      /active FlowCode lease/i,
    );
    const released = await leases.release(first.id);
    assert.equal(released.state, "released");
    const second = await leases.acquire({
      profile: profile(),
      sessionId: "session-2",
      pageId: "page-2",
      allowAssociatedPopups: false,
      launchOwnership: "flowcode",
    });
    assert.equal(second.owner.kind, "recording");
    now += 1;
    const restarted = new ZiniaoLeaseStore(root, () => now);
    await restarted.initialize();
    const third = await restarted.acquire({
      profile: profile(),
      sessionId: "session-3",
      pageId: "page-3",
      allowAssociatedPopups: false,
      launchOwnership: "borrowed",
    });
    assert.equal(third.state, "active");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
