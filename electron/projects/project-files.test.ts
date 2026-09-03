import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import type { FlowProject } from "../../common/project";
import { ProjectFileService } from "./project-files";

function projectAt(rootPath: string): FlowProject {
  return {
    schemaVersion: 1,
    id: "project-files",
    name: "Files",
    kind: "web-test",
    rootPath,
    templateId: "playwright-test-pom",
    templateVersion: "1.0.0",
    createdAt: 1,
    updatedAt: 1,
  };
}

test("project files stay inside the root and omit private or generated trees", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "flowcode-files-"));
  const outside = await mkdtemp(path.join(tmpdir(), "flowcode-files-outside-"));
  try {
    await mkdir(path.join(root, "src", "pages"), { recursive: true });
    await mkdir(path.join(root, "node_modules", "package"), {
      recursive: true,
    });
    await mkdir(path.join(root, ".flowcode", "runs", "run-one"), {
      recursive: true,
    });
    await writeFile(
      path.join(root, "src", "pages", "example.ts"),
      "export {};\n",
    );
    await writeFile(path.join(root, ".env"), "TOKEN=secret\n");
    await writeFile(path.join(root, ".env.example"), "TOKEN=\n");
    await writeFile(
      path.join(root, ".npmrc"),
      "//registry/:_authToken=secret\n",
    );
    await writeFile(path.join(root, "private.key"), "secret\n");
    await writeFile(
      path.join(root, "node_modules", "package", "index.js"),
      "bad",
    );
    await writeFile(
      path.join(root, ".flowcode", "runs", "run-one", "output.log"),
      "log",
    );
    await writeFile(path.join(outside, "secret.txt"), "secret");
    await symlink(outside, path.join(root, "linked-outside"), "junction");

    const service = new ProjectFileService(async () => projectAt(root));
    const tree = await service.list("project-files");
    assert.equal(tree.truncated, false);
    assert.ok(
      tree.entries.some((entry) => entry.path === "src/pages/example.ts"),
    );
    assert.ok(tree.entries.some((entry) => entry.path === ".env.example"));
    assert.ok(
      !tree.entries.some((entry) => entry.path.startsWith("node_modules")),
    );
    assert.ok(!tree.entries.some((entry) => entry.path === ".env"));
    assert.ok(!tree.entries.some((entry) => entry.path === ".npmrc"));
    assert.ok(!tree.entries.some((entry) => entry.path === "private.key"));
    assert.ok(
      !tree.entries.some((entry) => entry.path.startsWith(".flowcode/runs")),
    );
    assert.ok(
      !tree.entries.some((entry) => entry.path.startsWith("linked-outside")),
    );

    assert.equal(
      (await service.read("project-files", "src/pages/example.ts")).content,
      "export {};\n",
    );
    await assert.rejects(
      service.read("project-files", "../secret.txt"),
      /path/i,
    );
    await assert.rejects(service.read("project-files", ".env"), /sensitive/i);
    await assert.rejects(service.read("project-files", ".npmrc"), /sensitive/i);
    await assert.rejects(
      service.read("project-files", "linked-outside/secret.txt"),
      /symbolic link/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("binary and oversized files are not opened as source", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "flowcode-files-limits-"));
  try {
    await writeFile(path.join(root, "binary.bin"), Buffer.from([0, 1, 2]));
    await writeFile(path.join(root, "large.txt"), "x".repeat(2_048));
    const service = new ProjectFileService(async () => projectAt(root), {
      maxFileBytes: 1_024,
    });
    await assert.rejects(
      service.read("project-files", "binary.bin"),
      /binary/i,
    );
    await assert.rejects(
      service.read("project-files", "large.txt"),
      /too large/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
