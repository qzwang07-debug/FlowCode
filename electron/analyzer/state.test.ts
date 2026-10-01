import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import test from "node:test";
import { AnalyzerRunStore } from "./run-store";
import { BlueprintRevisionStore, nextReviewVersion } from "./revision-store";
import { EMPTY_REVIEW_FLAGS } from "../../common/analyzer";
import { OwnedProcessJob } from "../opencode/owned-job";
import { probeEnvironment } from "../opencode/probe-host";
import type { AutomationBlueprintV2 } from "../../common/blueprint-v2";
test("append-only run recovery is interrupted, never a phantom successful analysis", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "flowcode-run-audit-"));
  try {
    const store = new AnalyzerRunStore(root); const id = randomUUID();
    await store.status({ schemaVersion: 1, id, sessionId: "fixture", phase: "analysis", startedAt: 1,
      provider: "fixture", model: "synthetic", promptVersion: "5c.2", schemaVersionName: "v2", baseHash: "a".repeat(64), settingsHash: "b".repeat(64) });
    const prior = await readFile(path.join(root, id, "audit.jsonl"), "utf8");
    await store.recover(); assert.equal((await store.read(id))?.phase, "interrupted");
    assert.ok((await readFile(path.join(root, id, "audit.jsonl"), "utf8")).startsWith(prior));
    await assert.rejects(store.read("../another-run"));
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("derived history uses atomic exclusive appends and rejects stale revision writes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "flowcode-revisions-"));
  const base: AutomationBlueprintV2 = JSON.parse(await readFile(new URL("../../fixtures/stage5a/blueprint-v2.json", import.meta.url), "utf8"));
  try {
    const store = new BlueprintRevisionStore(root);
    await store.append(base, { blueprint: nextReviewVersion(base), flags: EMPTY_REVIEW_FLAGS, author: "user", at: 1, feedback: "Explicit review", changedStepIds: [] });
    await assert.rejects(store.append(base, { blueprint: nextReviewVersion(base), flags: EMPTY_REVIEW_FLAGS, author: "user", at: 2, feedback: "Stale", changedStepIds: [] }));
    assert.equal((await store.current(base)).blueprint.revision, 2);
    assert.equal((await store.list(base)).length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("managed environment excludes ambient model credentials and project paths", () => {
  const previous = process.env.FLOWCODE_SYNTHETIC_MODEL_KEY;
  process.env.FLOWCODE_SYNTHETIC_MODEL_KEY = "synthetic-secret-not-propagated";
  try {
    const env = probeEnvironment(path.resolve(".stage5c/test-scope"), {});
    assert.equal(env.FLOWCODE_SYNTHETIC_MODEL_KEY, undefined);
    assert.equal(env.OPENCODE_DISABLE_PROJECT_CONFIG, "true");
    assert.equal(env.OPENCODE_DISABLE_AUTOUPDATE, "true");
    assert.ok(!JSON.stringify(env).includes("synthetic-secret-not-propagated"));
  } finally { if (previous === undefined) delete process.env.FLOWCODE_SYNTHETIC_MODEL_KEY; else process.env.FLOWCODE_SYNTHETIC_MODEL_KEY = previous; }
});
test("actual Windows Job terminates only its owned runtime child on close", { skip: process.platform !== "win32" || process.arch !== "x64" }, async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { windowsHide: true, stdio: "ignore" });
  const closed = new Promise<void>(r => child.once("close", () => r()));
  const job = new OwnedProcessJob();
  try { assert.ok(child.pid); job.attach(child.pid); job.close();
    await Promise.race([closed, new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error("Owned Job close did not terminate the child")), 5000); timer.unref(); })]);
    assert.notEqual(child.exitCode, null);
  } finally { job.close(); if (child.exitCode === null) child.kill(); await closed; }
});
