import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  IPC,
  ProjectCreateRequestSchema,
  ProjectOpenRequestSchema,
} from "./ipc";
import {
  ProjectFileReadRequestSchema,
  ProjectRunControlRequestSchema,
  ProjectRunStartRequestSchema,
  WorktreeControlRequestSchema,
  WorktreeCreateRequestSchema,
} from "./project-runtime";
import {
  FlowProjectSchema,
  ProjectRegistrySchema,
  TemplateManifestSchema,
} from "./project";

const repositoryRoot = path.resolve(import.meta.dirname, "..");

function read(relativePath: string): string {
  return readFileSync(path.join(repositoryRoot, relativePath), "utf8");
}

const project = {
  schemaVersion: 1 as const,
  id: "project-checkout",
  name: "Checkout tests",
  kind: "web-test" as const,
  rootPath: "C:\\work\\checkout-tests",
  templateId: "playwright-test-pom",
  templateVersion: "1.0.0",
  createdAt: 1_788_192_000_000,
  updatedAt: 1_788_192_000_000,
};

test("FlowProject and template manifests survive a JSON round-trip", () => {
  const parsedProject = FlowProjectSchema.parse(
    JSON.parse(JSON.stringify(project)) as unknown,
  );
  assert.deepEqual(parsedProject, project);

  const manifest = {
    schemaVersion: 1,
    id: "playwright-test-pom",
    version: "1.0.0",
    kind: "web-test",
    name: "Playwright Test POM",
    description:
      "A TypeScript Playwright Test project organized around page objects.",
    files: [
      {
        path: "package.json",
        sha256: "a".repeat(64),
        required: true,
      },
    ],
    integrity: {
      algorithm: "sha256",
      value: "b".repeat(64),
    },
  };
  assert.deepEqual(
    TemplateManifestSchema.parse(
      JSON.parse(JSON.stringify(manifest)) as unknown,
    ),
    manifest,
  );
});

test("project schemas reject unsupported versions and invalid timestamps", () => {
  assert.equal(
    FlowProjectSchema.safeParse({ ...project, schemaVersion: 2 }).success,
    false,
  );
  assert.equal(
    FlowProjectSchema.safeParse({
      ...project,
      updatedAt: project.createdAt - 1,
    }).success,
    false,
  );
});

test("template manifests reject traversal, duplicate paths, and malformed hashes", () => {
  const file = { path: "package.json", sha256: "a".repeat(64), required: true };
  const base = {
    schemaVersion: 1,
    id: "playwright-test-pom",
    version: "1.0.0",
    kind: "web-test",
    name: "Playwright Test POM",
    description: "Template",
    files: [file],
    integrity: { algorithm: "sha256", value: "b".repeat(64) },
  };

  assert.equal(
    TemplateManifestSchema.safeParse({
      ...base,
      files: [{ ...file, path: "../outside.txt" }],
    }).success,
    false,
  );
  assert.equal(
    TemplateManifestSchema.safeParse({ ...base, files: [file, file] }).success,
    false,
  );
  assert.equal(
    TemplateManifestSchema.safeParse({
      ...base,
      files: [{ ...file, sha256: "not-a-hash" }],
    }).success,
    false,
  );
});

test("the registry schema rejects duplicate project ids", () => {
  const result = ProjectRegistrySchema.safeParse({
    schemaVersion: 1,
    projects: [project, { ...project, rootPath: "C:\\work\\other" }],
  });
  assert.equal(result.success, false);
});

test("project IPC accepts ids and location capabilities, never renderer paths", () => {
  assert.deepEqual(
    ProjectCreateRequestSchema.parse({
      name: "Checkout tests",
      kind: "web-test",
      locationToken: "f52e7ad7-941c-43f0-8b2f-a78a6d98fe13",
    }),
    {
      name: "Checkout tests",
      kind: "web-test",
      locationToken: "f52e7ad7-941c-43f0-8b2f-a78a6d98fe13",
    },
  );
  assert.equal(
    ProjectCreateRequestSchema.safeParse({
      name: "Checkout tests",
      kind: "web-test",
      locationToken: "f52e7ad7-941c-43f0-8b2f-a78a6d98fe13",
      targetPath: "C:\\outside\\renderer-controlled",
    }).success,
    false,
  );
  assert.equal(
    ProjectOpenRequestSchema.safeParse({ projectId: "../outside" }).success,
    false,
  );
  assert.equal(
    ProjectFileReadRequestSchema.safeParse({
      projectId: "project-checkout",
      path: "C:\\outside\\secret.txt",
    }).success,
    false,
  );
  assert.equal(
    ProjectRunStartRequestSchema.safeParse({
      projectId: "project-checkout",
      action: "test",
      command: "Remove-Item C:\\work",
    }).success,
    false,
  );
  assert.equal(
    ProjectRunControlRequestSchema.safeParse({
      projectId: "project-checkout",
      runId: "../run",
    }).success,
    false,
  );
  assert.equal(
    WorktreeCreateRequestSchema.safeParse({
      projectId: "project-checkout",
      reason: "Manual review",
      rootPath: "C:\\outside",
    }).success,
    false,
  );
  assert.equal(
    WorktreeControlRequestSchema.safeParse({
      projectId: "project-checkout",
      worktreeId: "../worktree",
    }).success,
    false,
  );
});

test("project IPC, preload, renderer route, and packaged templates stay wired together", () => {
  const preload = read("electron/preload.cjs");
  for (const channel of [
    IPC.listProjects,
    IPC.selectProjectLocation,
    IPC.createProject,
    IPC.openProject,
    IPC.projectRuntime,
    IPC.readProjectFile,
    IPC.startProjectRun,
    IPC.cancelProjectRun,
    IPC.readProjectRunLog,
    IPC.projectRunLog,
    IPC.createProjectWorktree,
    IPC.acceptProjectWorktree,
    IPC.rollbackProjectWorktree,
    IPC.cleanupProjectWorktree,
    IPC.openProjectStudio,
    IPC.closeProjectStudio,
  ]) {
    assert.ok(
      preload.includes(JSON.stringify(channel)),
      `Preload is missing ${channel}`,
    );
  }

  assert.match(read("electron/main.ts"), /registerProjectIpc/);
  assert.match(read("src/main.tsx"), /<ProjectStudio \/>/);
  assert.match(read("src/Recorder.tsx"), /openProjectStudio/);

  const packageJson = JSON.parse(read("package.json")) as {
    build?: { extraResources?: { from?: string; to?: string }[] };
  };
  assert.ok(
    packageJson.build?.extraResources?.some(
      (resource) =>
        resource.from === "templates" && resource.to === "templates",
    ),
    "Packaged builds must include the versioned templates.",
  );
});
