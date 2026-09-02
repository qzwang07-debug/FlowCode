import assert from "node:assert/strict";
import {
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
import { ProjectRegistry, ProjectRegistryCorruptError } from "./registry";

function project(id: string, rootPath: string): FlowProject {
  return {
    schemaVersion: 1,
    id,
    name: id,
    kind: "web-test",
    rootPath,
    templateId: "playwright-test-pom",
    templateVersion: "1.0.0",
    createdAt: 100,
    updatedAt: 100,
  };
}

test("registry writes atomically and rejects duplicate project ids", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "flowcode-registry-"));
  try {
    const projectRoot = path.join(root, "project");
    await mkdir(projectRoot);
    const registry = new ProjectRegistry(
      path.join(root, "data", "project-registry.json"),
    );

    await registry.add(project("project-one", projectRoot));
    await assert.rejects(
      registry.add(project("project-one", path.join(root, "other"))),
      /already registered/i,
    );

    const stored = await registry.read();
    assert.equal(stored.projects.length, 1);
    assert.equal(
      stored.projects[0]?.rootPath,
      await registry.canonicalRoot(projectRoot),
    );
    assert.deepEqual(await readdir(path.dirname(registry.filePath)), [
      "project-registry.json",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("registry reports a missing project directory without deleting its entry", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "flowcode-registry-missing-"));
  try {
    const projectRoot = path.join(root, "project");
    await mkdir(projectRoot);
    const registry = new ProjectRegistry(
      path.join(root, "project-registry.json"),
    );
    await registry.add(project("project-missing", projectRoot));
    await rm(projectRoot, { recursive: true });

    const [entry] = await registry.list();
    assert.equal(entry?.project.id, "project-missing");
    assert.equal(entry?.availability, "missing");
    assert.equal((await registry.read()).projects.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a corrupt registry fails closed and is not overwritten", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "flowcode-registry-corrupt-"));
  try {
    const file = path.join(root, "project-registry.json");
    const corruptContents = "{ definitely not valid json";
    await writeFile(file, corruptContents, "utf8");
    const registry = new ProjectRegistry(file);

    await assert.rejects(registry.read(), ProjectRegistryCorruptError);
    await assert.rejects(
      registry.add(project("project-two", path.join(root, "project"))),
      ProjectRegistryCorruptError,
    );
    assert.equal(await readFile(file, "utf8"), corruptContents);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
