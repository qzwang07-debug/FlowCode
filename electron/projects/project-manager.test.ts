import assert from "node:assert/strict";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import type { FlowProject } from "../../common/project";
import { ProjectManager } from "./project-manager";
import { ProjectRegistry } from "./registry";
import { TemplateStore } from "../templates/template-store";

const templatesRoot = path.resolve(
  import.meta.dirname,
  "..",
  "..",
  "templates",
);

function managerFor(
  root: string,
  initializeGit?: (directory: string) => Promise<void>,
) {
  return new ProjectManager({
    registry: new ProjectRegistry(
      path.join(root, "data", "project-registry.json"),
    ),
    templates: new TemplateStore(templatesRoot),
    initializeGit,
  });
}

test("both project kinds are created completely and initialized as local-only Git repos", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "flowcode-project-create-"));
  try {
    const manager = managerFor(root);
    for (const [id, kind] of [
      ["project-web", "web-test"],
      ["project-automation", "browser-automation"],
    ] as const) {
      const targetPath = path.join(root, id);
      const project = await manager.create({ id, name: id, kind, targetPath });

      assert.equal(project.rootPath, targetPath);
      assert.equal(project.kind, kind);
      assert.equal(
        JSON.parse(
          await readFile(
            path.join(targetPath, ".flowcode", "project.json"),
            "utf8",
          ),
        ).id,
        id,
      );
      await access(path.join(targetPath, ".gitignore"));
      await access(path.join(targetPath, ".git"));
      const gitConfig = await readFile(
        path.join(targetPath, ".git", "config"),
        "utf8",
      );
      assert.doesNotMatch(gitConfig, /\[remote\s+/i);
    }

    assert.equal((await manager.list()).length, 2);
    assert.equal((await manager.open("project-web")).id, "project-web");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an existing target is never overwritten", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "flowcode-project-existing-"));
  try {
    const targetPath = path.join(root, "existing");
    await mkdir(targetPath);
    await writeFile(path.join(targetPath, "keep.txt"), "keep", "utf8");

    await assert.rejects(
      managerFor(root).create({
        id: "project-existing",
        name: "Existing",
        kind: "web-test",
        targetPath,
      }),
      /already exists/i,
    );
    assert.equal(
      await readFile(path.join(targetPath, "keep.txt"), "utf8"),
      "keep",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a failed creation removes its temporary directory and leaves no target", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "flowcode-project-failure-"));
  try {
    const targetPath = path.join(root, "failed-project");
    const manager = managerFor(root, async () => {
      throw new Error("simulated git failure");
    });

    await assert.rejects(
      manager.create({
        id: "project-failed",
        name: "Failed project",
        kind: "web-test",
        targetPath,
      }),
      /simulated git failure/,
    );
    await assert.rejects(access(targetPath), { code: "ENOENT" });
    assert.deepEqual(
      (await readdir(root)).filter((name) => name.includes("flowcode-tmp")),
      [],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a registry failure after the atomic move rolls the new target back", async () => {
  const root = await mkdtemp(
    path.join(tmpdir(), "flowcode-project-registry-failure-"),
  );
  try {
    class FailingRegistry extends ProjectRegistry {
      override async add(_candidate: FlowProject): Promise<FlowProject> {
        throw new Error("simulated registry write failure");
      }
    }

    const targetPath = path.join(root, "rolled-back-project");
    const manager = new ProjectManager({
      registry: new FailingRegistry(
        path.join(root, "data", "project-registry.json"),
      ),
      templates: new TemplateStore(templatesRoot),
    });
    await assert.rejects(
      manager.create({
        id: "project-rolled-back",
        name: "Rolled back",
        kind: "web-test",
        targetPath,
      }),
      /simulated registry write failure/,
    );
    await assert.rejects(access(targetPath), { code: "ENOENT" });
    assert.deepEqual(
      (await readdir(root)).filter((name) => name.includes("flowcode-tmp")),
      [],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
