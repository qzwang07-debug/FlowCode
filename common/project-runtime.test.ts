import assert from "node:assert/strict";
import test from "node:test";

import {
  GitRepositoryStatusSchema,
  ProjectFileReadRequestSchema,
  ProjectRunStartRequestSchema,
  WorktreeRecordSchema,
} from "./project-runtime";

test("Stage 2 runtime schemas round-trip safe project data", () => {
  const status = {
    schemaVersion: 1,
    projectId: "project-one",
    repositoryRoot: "C:\\work\\project-one",
    hasCommits: true,
    headSha: "a".repeat(40),
    branch: "main",
    detached: false,
    dirty: true,
    changedFileCount: 2,
  };
  assert.deepEqual(GitRepositoryStatusSchema.parse(status), status);

  const worktree = {
    schemaVersion: 1,
    id: "worktree-one",
    projectId: "project-one",
    reason: "Manual isolated change",
    branch: "flowcode/run/worktree-one",
    rootPath: "C:\\FlowCode\\worktrees\\items\\worktree-one",
    repositoryRoot: "C:\\work\\project-one",
    baseHead: "a".repeat(40),
    baseBranch: "main",
    baseDirty: true,
    state: "active",
    createdAt: 100,
    updatedAt: 100,
  };
  assert.deepEqual(WorktreeRecordSchema.parse(worktree), worktree);
});

test("renderer runtime inputs accept ids and safe relative paths only", () => {
  assert.deepEqual(
    ProjectFileReadRequestSchema.parse({
      projectId: "project-one",
      path: "src/pages/example.page.ts",
    }),
    { projectId: "project-one", path: "src/pages/example.page.ts" },
  );
  for (const unsafe of [
    "../secret.txt",
    "/absolute.txt",
    "C:\\outside.txt",
    "src\\..\\secret.txt",
    ".git/config",
    ".flowcode/runs/run-one/output.log",
  ]) {
    assert.equal(
      ProjectFileReadRequestSchema.safeParse({
        projectId: "project-one",
        path: unsafe,
      }).success,
      false,
      unsafe,
    );
  }

  assert.equal(
    ProjectRunStartRequestSchema.safeParse({
      projectId: "project-one",
      action: "test; Remove-Item C:\\work",
    }).success,
    false,
  );
});
