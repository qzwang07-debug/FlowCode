import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import type { FlowProject, ProjectListItem } from "../../common/project";
import { EvidenceService } from "./service";

test("evidence reviews are project-linked, revisioned, and path-safe", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "flowcode-evidence-service-"));
  const previous = process.env.SKILL_RECORDER_SESSIONS_DIR;
  process.env.SKILL_RECORDER_SESSIONS_DIR = root;
  const project: FlowProject = {
    schemaVersion: 1,
    id: "project-one",
    name: "Checkout",
    kind: "web-test",
    rootPath: path.join(root, "project"),
    templateId: "playwright-test-pom",
    templateVersion: "1.0.0",
    createdAt: 1,
    updatedAt: 1,
  };
  const item: ProjectListItem = { project, availability: "available" };
  const service = new EvidenceService({
    projects: {
      list: async () => [item],
      open: async (id: string) => {
        if (id !== project.id) throw new Error("missing project");
        return project;
      },
    },
    now: () => 5_000,
  });

  try {
    const sessionId = "session-service";
    const directory = path.join(root, sessionId);
    await mkdir(directory);
    await writeFile(
      path.join(directory, "session.json"),
      JSON.stringify({
        schemaVersion: 2,
        eventSchemaVersion: 1,
        startedAtMonotonicMs: 1_000,
        id: sessionId,
        startedAt: 1_000,
        stoppedAt: 2_000,
        platform: "win32",
        appVersion: "0.5.0",
        link: {
          projectId: project.id,
          mode: "analyze-and-build",
          browserEnhancement: "semantic",
        },
      }),
    );
    await writeFile(path.join(directory, "events.jsonl"), "");
    await writeFile(path.join(directory, "browser-events.jsonl"), "");
    await writeFile(path.join(directory, "browser-gaps.jsonl"), "");
    await writeFile(path.join(directory, "browser-clock.jsonl"), "");

    const initial = await service.get(sessionId);
    assert.equal(initial.review.revision, 1);
    assert.equal(initial.projectName, "Checkout");
    const recordings = await service.list();
    assert.equal(recordings[0]?.projectId, project.id);
    assert.equal(recordings[0]?.blueprintReady, true);

    const updated = await service.update({
      sessionId,
      expectedRevision: 1,
      review: {
        ...initial.review,
        intent: "Updated deterministic intent.",
        privacyReviewed: true,
      },
    });
    assert.equal(updated.review.revision, 2);
    assert.equal(updated.review.updatedAt, 5_000);
    assert.equal(updated.blueprint.intent, "Updated deterministic intent.");
    await assert.rejects(
      service.update({
        sessionId,
        expectedRevision: 1,
        review: updated.review,
      }),
      /changed in another window/i,
    );
    await assert.rejects(
      service.update({
        sessionId,
        expectedRevision: 2,
        review: {
          ...updated.review,
          variables: [
            {
              id: "fabricated",
              name: "Fabricated",
              type: "string",
              source: "runtime",
              required: true,
              sensitive: false,
            },
          ],
        },
      }),
      /no longer match the recording evidence/i,
    );
    await assert.rejects(
      service.update({
        sessionId,
        expectedRevision: 2,
        review: {
          ...updated.review,
          intent: "Send results to dev@internal.example.com",
        },
      }),
      /contains a sensitive value/i,
    );
    await assert.rejects(service.get("../outside"), /invalid/i);
  } finally {
    if (previous === undefined) delete process.env.SKILL_RECORDER_SESSIONS_DIR;
    else process.env.SKILL_RECORDER_SESSIONS_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});
