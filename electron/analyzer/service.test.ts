import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { AnalyzerService } from "./service";
import { ProviderStore } from "./provider-store";
import { FREE_PROVIDER, EMPTY_REVIEW_FLAGS } from "../../common/analyzer";
import type { EvidenceReviewSnapshot } from "../../common/evidence";

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), "flowcode-analyzer-test-"));
  const prior = process.env.SKILL_RECORDER_SESSIONS_DIR;
  process.env.SKILL_RECORDER_SESSIONS_DIR = path.join(root, "sessions");
  const dir = path.join(root, "sessions", "fixture-session"); await mkdir(dir, { recursive: true });
  const meta = { id: "fixture-session", startedAt: 1, stoppedAt: 2, platform: "win32", appVersion: "fixture" };
  await writeFile(path.join(dir, "session.json"), JSON.stringify(meta));
  const bp = JSON.parse(await readFile(new URL("../../fixtures/stage5a/blueprint-v2.json", import.meta.url), "utf8"));
  const snapshot = { session: { ...meta, link: { mode: "analyze-only" } }, blueprintV2: bp,
    index: { events: [], timeline: [], gaps: [] } } as unknown as EvidenceReviewSnapshot;
  const providers = new ProviderStore(path.join(root, "settings"), { read: async () => undefined, write: async () => {}, remove: async () => {} });
  const service = new AnalyzerService({ root, providers, evidence: { get: async () => snapshot }, binary: async () => { throw new Error("Unit tests never launch a model runtime"); } });
  return { root, snapshot, providers, service, cleanup: async () => {
    await service.dispose(); if (prior === undefined) delete process.env.SKILL_RECORDER_SESSIONS_DIR; else process.env.SKILL_RECORDER_SESSIONS_DIR = prior;
    await rm(root, { recursive: true, force: true });
  } };
}
test("review decisions are invalidated by target/provider scope changes", async () => {
  const s = await setup();
  try {
    const first = await s.service.snapshot("fixture-session");
    const saved = await s.service.edit({ sessionId: "fixture-session", expectedHash: first.blueprint.contentHash,
      flags: { ...EMPTY_REVIEW_FLAGS, intentConfirmed: true, privacyReviewed: true } });
    assert.equal(saved.flags.intentConfirmed, true);
    s.snapshot.session.link.targetId = "other-target";
    assert.equal((await s.service.snapshot("fixture-session")).flags.intentConfirmed, false);
    await s.providers.save({ settings: { ...FREE_PROVIDER, modelId: "another-free" } });
    assert.equal((await s.service.snapshot("fixture-session")).flags.privacyReviewed, false);
  } finally { await s.cleanup(); }
});
test("model preview is one-use and capability failure does not start a runtime", async () => {
  const s = await setup();
  try {
    const p = await s.service.preview({ sessionId: "fixture-session", screenshots: true });
    assert.equal(p.screenshots, false); assert.equal(p.visionDegraded, true);
    await assert.rejects(s.service.start({ sessionId: "fixture-session", expectedHash: p.blueprintHash, previewId: p.id }), /connection test/);
    await assert.rejects(s.service.start({ sessionId: "fixture-session", expectedHash: p.blueprintHash, previewId: p.id }), /preview expired/);
    const next = await s.service.preview({ sessionId: "fixture-session", screenshots: false });
    await s.service.revoke("fixture-session");
    await assert.rejects(s.service.start({ sessionId: "fixture-session", expectedHash: next.blueprintHash, previewId: next.id }), /preview expired/);
    const feedbackPreview = await s.service.preview({ sessionId: "fixture-session", screenshots: false, feedback: "Review invoice grouping" });
    assert.ok(feedbackPreview.categories.includes("sanitized human revision feedback"));
    await assert.rejects(s.service.start({ sessionId: "fixture-session", expectedHash: feedbackPreview.blueprintHash,
      previewId: feedbackPreview.id, feedback: "Different feedback after consent" }), /preview expired/);
  } finally { await s.cleanup(); }
});
test("revision comparison reports changed fields without reading arbitrary files", async () => {
  const s = await setup();
  try {
    const first = await s.service.snapshot("fixture-session");
    await s.service.edit({ sessionId: "fixture-session", expectedHash: first.blueprint.contentHash,
      edit: { kind: "manual", stepId: "fill-name", description: "Human enters the fixture name" } });
    const diff = await s.service.compare({ sessionId: "fixture-session", priorHash: first.blueprint.contentHash });
    assert.ok(diff.differences.some(d => d.field === "step:fill-name" && d.after.includes("manual")));
    await assert.rejects(s.service.compare({ sessionId: "fixture-session", priorHash: "f".repeat(64) }));
    await assert.rejects(s.service.compare({ sessionId: "fixture-session", priorHash: first.blueprint.contentHash, path: "../secrets" }));
  } finally { await s.cleanup(); }
});
test("Session directory links cannot become an evidence-reading capability", async () => {
  const s = await setup(); const external = await mkdtemp(path.join(tmpdir(), "flowcode-outside-evidence-"));
  const linked = path.join(s.root, "sessions", "linked-session");
  try {
    await symlink(external, linked, process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(s.service.snapshot("linked-session"), /trusted Session store/);
  } finally { await rm(linked, { force: true, recursive: true }); await rm(external, { recursive: true, force: true }); await s.cleanup(); }
});

test("derived revision directory links cannot read or write outside the Session", async () => {
  const s = await setup(); const external = await mkdtemp(path.join(tmpdir(), "flowcode-outside-revisions-"));
  const linked = path.join(s.root, "sessions", "fixture-session", "blueprint-revisions");
  try {
    await symlink(external, linked, process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(s.service.snapshot("fixture-session"), /trusted Session store/);
  } finally { await rm(linked, { force: true, recursive: true }); await rm(external, { recursive: true, force: true }); await s.cleanup(); }
});

test("new target preview stays scoped and reports not-indexed instead of reading project files", async () => {
  const s = await setup();
  try {
    s.snapshot.session.link = { mode: "analyze-and-build", projectId: "new-fixture-project", browserEnhancement: "semantic" };
    const preview = await s.service.preview({ sessionId: "fixture-session", screenshots: false });
    assert.ok(preview.tools.includes("project_get_context"));
    assert.ok(!preview.tools.some(t => /file|shell|index|webfetch/.test(t)));
    const scoped = await s.service.snapshot("fixture-session");
    assert.equal(scoped.preflight.generationReady, false);
    assert.ok(scoped.preflight.todos.some(t => t.code === "capability-unknown"));
  } finally { await s.cleanup(); }
});
