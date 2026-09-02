import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assertProjectPathSafe,
  normalizeProjectRoot,
  resolveProjectPath,
  resolveProjectTarget,
} from "./path-safety";

test("project paths are normalized and traversal is rejected", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "flowcode-path-"));
  try {
    assert.equal(
      normalizeProjectRoot(path.join(root, ".")),
      path.resolve(root),
    );
    assert.throws(() => normalizeProjectRoot("relative/project"), /absolute/i);
    assert.throws(
      () => resolveProjectPath(root, "../outside.txt"),
      /outside|traversal/i,
    );
    assert.throws(
      () => resolveProjectPath(root, "C:\\outside.txt"),
      /relative/i,
    );
    assert.throws(
      () => resolveProjectTarget(root, "../outside"),
      /single folder|traversal/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an existing symbolic link cannot escape a project root", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "flowcode-path-link-"));
  const projectRoot = path.join(root, "project");
  const outside = path.join(root, "outside");
  try {
    await mkdir(projectRoot);
    await mkdir(outside);
    await writeFile(path.join(outside, "secret.txt"), "secret", "utf8");
    try {
      await symlink(
        outside,
        path.join(projectRoot, "linked"),
        process.platform === "win32" ? "junction" : "dir",
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") {
        t.skip("This Windows environment does not permit creating links.");
        return;
      }
      throw error;
    }

    await assert.rejects(
      assertProjectPathSafe(projectRoot, "linked/secret.txt"),
      /symbolic link|outside/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
