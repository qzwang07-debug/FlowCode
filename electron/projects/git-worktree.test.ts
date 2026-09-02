import assert from "node:assert/strict";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import type { FlowProject } from "../../common/project";
import { GitWorktreeService, runGit } from "./git";

async function expectGit(directory: string, args: readonly string[]) {
  const result = await runGit(directory, args);
  assert.equal(result.exitCode, 0, result.stderr);
  return result.stdout;
}

async function repositoryProject(root: string): Promise<FlowProject> {
  const repository = path.join(root, "project");
  await mkdir(repository);
  await writeFile(path.join(repository, "README.md"), "base\n");
  await expectGit(repository, ["init", "--initial-branch=main"]);
  await expectGit(repository, ["add", "--all"]);
  await expectGit(repository, [
    "-c",
    "user.name=FlowCode tests",
    "-c",
    "user.email=flowcode@localhost",
    "-c",
    "commit.gpgSign=false",
    "commit",
    "-m",
    "initial",
  ]);
  return {
    schemaVersion: 1,
    id: "project-git",
    name: "Git project",
    kind: "web-test",
    rootPath: repository,
    templateId: "playwright-test-pom",
    templateVersion: "1.0.0",
    createdAt: 1,
    updatedAt: 1,
  };
}

function serviceFor(
  root: string,
  project: FlowProject,
  ids: string[],
): GitWorktreeService {
  return new GitWorktreeService({
    storageRoot: path.join(root, "data", "worktrees"),
    resolveProject: async (id) => {
      assert.equal(id, project.id);
      return project;
    },
    listProjects: async () => [project],
    createId: () => {
      const id = ids.shift();
      if (!id) throw new Error("No test worktree id remains.");
      return id;
    },
  });
}

test("worktrees preserve a dirty main tree and accept only a clean unchanged base", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "flowcode-worktree-life-"));
  try {
    const project = await repositoryProject(root);
    const service = serviceFor(root, project, [
      "worktree-accept",
      "worktree-revert",
    ]);
    const base = await service.status(project.id);
    assert.equal(base.dirty, false);
    assert.equal(base.branch, "main");
    assert.match(base.headSha ?? "", /^[a-f0-9]{40}$/);

    const dirtyFile = path.join(project.rootPath, "local-only.txt");
    await writeFile(dirtyFile, "do not touch\n");
    const accepted = await service.create(
      project.id,
      "Test isolated acceptance",
    );
    assert.equal(accepted.baseDirty, true);
    await assert.rejects(
      access(path.join(accepted.rootPath, "local-only.txt")),
    );
    assert.equal(await readFile(dirtyFile, "utf8"), "do not touch\n");

    await writeFile(path.join(accepted.rootPath, "README.md"), "accepted\n");
    await expectGit(accepted.rootPath, ["add", "README.md"]);
    await expectGit(accepted.rootPath, [
      "-c",
      "user.name=FlowCode tests",
      "-c",
      "user.email=flowcode@localhost",
      "-c",
      "commit.gpgSign=false",
      "commit",
      "-m",
      "accepted change",
    ]);

    await assert.rejects(service.accept(project.id, accepted.id), /dirty/i);
    await rm(dirtyFile);
    const completed = await service.accept(project.id, accepted.id);
    assert.equal(completed.state, "accepted");
    assert.equal(
      (
        await readFile(path.join(project.rootPath, "README.md"), "utf8")
      ).replace(/\r\n/g, "\n"),
      "accepted\n",
    );
    await assert.rejects(access(accepted.rootPath));

    const reverted = await service.create(project.id, "Test isolated rollback");
    await writeFile(
      path.join(reverted.rootPath, "discarded.txt"),
      "discard me\n",
    );
    const rolledBack = await service.rollback(project.id, reverted.id);
    assert.equal(rolledBack.state, "reverted");
    await assert.rejects(access(reverted.rootPath));
    await assert.rejects(access(path.join(project.rootPath, "discarded.txt")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("recovery finds registered and untracked orphan FlowCode worktrees", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "flowcode-worktree-recover-"));
  try {
    const project = await repositoryProject(root);
    const service = serviceFor(root, project, ["worktree-active"]);
    const active = await service.create(project.id, "Survive restart");

    const restarted = serviceFor(root, project, []);
    let recovered = await restarted.recover();
    assert.equal(
      recovered.find((item) => item.id === active.id)?.state,
      "active",
    );

    const orphanId = "worktree-orphan";
    const orphanPath = path.join(root, "data", "worktrees", "items", orphanId);
    await expectGit(project.rootPath, [
      "worktree",
      "add",
      "-b",
      `flowcode/run/${orphanId}`,
      orphanPath,
      "HEAD",
    ]);
    recovered = await restarted.recover();
    const orphan = recovered.find((item) => item.id === orphanId);
    assert.equal(orphan?.state, "orphaned");
    assert.match(orphan?.lastError ?? "", /recovered/i);
    assert.equal(
      (await restarted.cleanup(project.id, orphanId)).state,
      "cleaned",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("accept refuses a project whose base HEAD advanced", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "flowcode-worktree-head-"));
  try {
    const project = await repositoryProject(root);
    const service = serviceFor(root, project, ["worktree-stale"]);
    const worktree = await service.create(project.id, "Stale base protection");
    await writeFile(
      path.join(project.rootPath, "main-change.txt"),
      "main advanced\n",
    );
    await expectGit(project.rootPath, ["add", "main-change.txt"]);
    await expectGit(project.rootPath, [
      "-c",
      "user.name=FlowCode tests",
      "-c",
      "user.email=flowcode@localhost",
      "-c",
      "commit.gpgSign=false",
      "commit",
      "-m",
      "advance main",
    ]);
    await assert.rejects(
      service.accept(project.id, worktree.id),
      /HEAD changed/i,
    );
    assert.equal(
      (await service.rollback(project.id, worktree.id)).state,
      "reverted",
    );
    assert.equal(
      await readFile(path.join(project.rootPath, "main-change.txt"), "utf8"),
      "main advanced\n",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
