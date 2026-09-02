import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import type { FlowProject } from "../../common/project";
import type { ProjectRunAction } from "../../common/project-run";
import { ControlledProcessRunner } from "./controlled-runner";
import {
  ProjectRunManager,
  projectRunnerEnvironment,
  resolveProjectCommand,
} from "./project-runner";

async function projectAt(rootPath: string): Promise<FlowProject> {
  await mkdir(path.join(rootPath, ".flowcode", "runs"), { recursive: true });
  await writeFile(
    path.join(rootPath, "package.json"),
    `${JSON.stringify({
      private: true,
      scripts: {
        test: "node -e \"console.log('template test')\"",
        typecheck: 'node -e "setInterval(() => {}, 1000)"',
      },
    })}\n`,
  );
  return {
    schemaVersion: 1,
    id: "project-runs",
    name: "Runs",
    kind: "web-test",
    rootPath,
    templateId: "playwright-test-pom",
    templateVersion: "1.0.0",
    createdAt: 1,
    updatedAt: 1,
  };
}

test("project command catalog is fixed by project kind and action", () => {
  assert.deepEqual(resolveProjectCommand("web-test", "test", "npm-test"), {
    executable: "npm-test",
    args: ["run", "test"],
  });
  assert.deepEqual(
    resolveProjectCommand("browser-automation", "smoke", "npm-test"),
    { executable: "npm-test", args: ["run", "smoke"] },
  );
  assert.throws(
    () => resolveProjectCommand("browser-automation", "report", "npm-test"),
    /not available/i,
  );
  if (process.platform === "win32") {
    const command = resolveProjectCommand("web-test", "test");
    assert.equal(path.basename(command.executable).toLowerCase(), "node.exe");
    assert.match(command.args[0] ?? "", /npm-cli\.js$/i);
    assert.deepEqual(command.args.slice(-2), ["run", "test"]);
  }
});

test("Windows npm resolution prefers the matched runtime supplied by npm", async () => {
  if (process.platform !== "win32") return;
  const root = await mkdtemp(path.join(tmpdir(), "flowcode-npm-runtime-"));
  const node = path.join(root, "node.exe");
  const cli = path.join(root, "node_modules", "npm", "bin", "npm-cli.js");
  await mkdir(path.dirname(cli), { recursive: true });
  await writeFile(node, "placeholder");
  await writeFile(cli, "placeholder");
  try {
    assert.deepEqual(
      resolveProjectCommand("web-test", "test", undefined, {
        Path: "C:\\unrelated",
        npm_node_execpath: node,
        npm_execpath: cli,
      }),
      { executable: node, args: [cli, "run", "test"] },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("project command environment withholds ambient credentials", () => {
  const environment = projectRunnerEnvironment({
    Path: "C:\\Tools",
    LOCALAPPDATA: "C:\\Local",
    GITHUB_TOKEN: "secret",
    API_KEY: "secret",
    CUSTOM_PASSWORD: "secret",
  });
  assert.equal(environment.Path, "C:\\Tools");
  assert.equal(environment.LOCALAPPDATA, "C:\\Local");
  assert.equal(environment.GITHUB_TOKEN, undefined);
  assert.equal(environment.API_KEY, undefined);
  assert.equal(environment.CUSTOM_PASSWORD, undefined);
  assert.equal(environment.NO_COLOR, "1");
  assert.equal(environment.FORCE_COLOR, undefined);
});

test("project runs persist status, bounded logs, recent history, and cancellation", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "flowcode-project-runs-"));
  const projectRoot = path.join(root, "project");
  await mkdir(projectRoot);
  const project = await projectAt(projectRoot);
  const events: string[] = [];
  const commands: Record<
    ProjectRunAction,
    { executable: string; args: string[] }
  > = {
    test: {
      executable: process.execPath,
      args: ["-e", "console.log('template test')"],
    },
    typecheck: {
      executable: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
    },
    lint: { executable: process.execPath, args: ["-e", ""] },
    report: { executable: process.execPath, args: ["-e", ""] },
    workflow: { executable: process.execPath, args: ["-e", ""] },
    smoke: { executable: process.execPath, args: ["-e", ""] },
  };
  const manager = new ProjectRunManager({
    resolveProject: async () => project,
    runner: new ControlledProcessRunner({ killGraceMs: 100 }),
    resolveCommand: (_kind, action) => commands[action],
    createId: (() => {
      const ids = ["run-success", "run-cancel"];
      return () => ids.shift() ?? "run-extra";
    })(),
    timeoutFor: () => 10_000,
    onLog: (event) => events.push(event.text),
  });
  try {
    const started = await manager.start(project.id, "test");
    assert.equal(started.status, "running");
    const succeeded = await manager.waitFor(started.id);
    assert.equal(succeeded.status, "succeeded");
    assert.equal(succeeded.action, "test");
    assert.equal(succeeded.command?.[0], process.execPath);
    assert.match(
      (await manager.readLog(project.id, started.id)).content,
      /template test/,
    );
    assert.ok(events.some((text) => text.includes("template test")));

    const recent = await manager.list(project.id);
    assert.equal(recent[0]?.id, "run-success");
    const stored = JSON.parse(
      await readFile(
        path.join(projectRoot, ".flowcode", "runs", started.id, "run.json"),
        "utf8",
      ),
    ) as { status: string };
    assert.equal(stored.status, "succeeded");

    const canceling = await manager.start(project.id, "typecheck");
    await assert.rejects(
      manager.start(project.id, "test"),
      /already has a running command/i,
    );
    assert.equal(await manager.cancel(project.id, canceling.id), true);
    assert.equal((await manager.waitFor(canceling.id)).status, "canceled");
  } finally {
    await manager.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("the default catalog launches npm through an executable command array", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "flowcode-project-npm-"));
  const projectRoot = path.join(root, "project");
  await mkdir(projectRoot);
  const project = await projectAt(projectRoot);
  const manager = new ProjectRunManager({
    resolveProject: async () => project,
    createId: () => "run-default-npm",
  });
  try {
    const started = await manager.start(project.id, "test");
    const completed = await manager.waitFor(started.id);
    const output = (await manager.readLog(project.id, started.id)).content;
    assert.equal(
      completed.status,
      "succeeded",
      `${completed.error ?? ""}\n${output}`,
    );
    assert.match(output, /template test/);
  } finally {
    await manager.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
