import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import type { FlowProject, ProjectKind } from "../../common/project";
import {
  ProjectRunActionSchema,
  ProjectRunSchema,
  RunIdSchema,
  type ProjectRun,
  type ProjectRunAction,
} from "../../common/project-run";
import {
  ProjectRunLogEventSchema,
  ProjectRunLogSchema,
  type ProjectRunLog,
  type ProjectRunLogEvent,
} from "../../common/project-runtime";
import {
  ControlledProcessRunner,
  type ControlledCommand,
} from "./controlled-runner";
import { readGitRepositoryStatus } from "./git";
import { assertProjectPathSafe, canonicalizeProjectRoot } from "./path-safety";

const DEFAULT_MAX_LOG_BYTES = 10 * 1024 * 1024;
const DEFAULT_LOG_TAIL_BYTES = 256 * 1024;
const MAX_RECENT_RUNS = 100;

const PROJECT_ACTIONS: Record<ProjectKind, readonly ProjectRunAction[]> = {
  "web-test": ["test", "typecheck", "lint", "report"],
  "browser-automation": ["workflow", "smoke", "typecheck", "lint"],
};

export interface ProjectCommand {
  executable: string;
  args: string[];
}

export function availableProjectActions(
  kind: ProjectKind,
): readonly ProjectRunAction[] {
  return PROJECT_ACTIONS[kind];
}

export function resolveProjectCommand(
  kind: ProjectKind,
  action: ProjectRunAction,
  npmExecutable?: string,
): ProjectCommand {
  if (!PROJECT_ACTIONS[kind].includes(action)) {
    throw new Error(
      `Run action "${action}" is not available for ${kind} projects.`,
    );
  }
  if (npmExecutable) {
    return { executable: npmExecutable, args: ["run", action] };
  }
  if (process.platform !== "win32") {
    return { executable: "npm", args: ["run", action] };
  }

  const pathEntries = (process.env.Path ?? process.env.PATH ?? "")
    .split(path.delimiter)
    .filter(Boolean);
  for (const entry of pathEntries) {
    const node = path.join(entry, "node.exe");
    const cli = path.join(entry, "node_modules", "npm", "bin", "npm-cli.js");
    if (existsSync(node) && existsSync(cli)) {
      return { executable: node, args: [cli, "run", action] };
    }
  }
  throw new Error(
    "FlowCode could not find a Node.js installation with npm on PATH.",
  );
}

function timeoutForAction(action: ProjectRunAction): number {
  if (action === "report") return 30 * 60_000;
  if (action === "test" || action === "smoke" || action === "workflow") {
    return 10 * 60_000;
  }
  return 5 * 60_000;
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  const temporary = `${file}.tmp.${process.pid}.${randomUUID()}`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

/** Keep project commands usable while withholding ambient API keys and tokens. */
export function projectRunnerEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const allowed = new Set([
    "APPDATA",
    "CI",
    "ComSpec",
    "HOME",
    "LOCALAPPDATA",
    "NUMBER_OF_PROCESSORS",
    "OS",
    "Path",
    "PATH",
    "PATHEXT",
    "PROCESSOR_ARCHITECTURE",
    "ProgramData",
    "ProgramFiles",
    "ProgramFiles(x86)",
    "SystemDrive",
    "SystemRoot",
    "TEMP",
    "TMP",
    "USERPROFILE",
    "WINDIR",
  ]);
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (allowed.has(key) && value !== undefined) environment[key] = value;
  }
  environment.NO_COLOR = "1";
  environment.NPM_CONFIG_AUDIT = "false";
  environment.NPM_CONFIG_FUND = "false";
  environment.NPM_CONFIG_UPDATE_NOTIFIER = "false";
  return environment;
}

export interface ProjectRunManagerOptions {
  resolveProject: (projectId: string) => Promise<FlowProject>;
  runner?: ControlledProcessRunner;
  resolveCommand?: (
    kind: ProjectKind,
    action: ProjectRunAction,
  ) => ProjectCommand;
  timeoutFor?: (action: ProjectRunAction) => number;
  createId?: () => string;
  now?: () => number;
  maxLogBytes?: number;
  onLog?: (event: ProjectRunLogEvent) => void;
}

interface ActiveProjectRun {
  projectId: string;
  completion: Promise<ProjectRun>;
}

export class ProjectRunManager {
  private readonly resolveProject: (projectId: string) => Promise<FlowProject>;
  private readonly runner: ControlledProcessRunner;
  private readonly resolveCommand: (
    kind: ProjectKind,
    action: ProjectRunAction,
  ) => ProjectCommand;
  private readonly timeoutFor: (action: ProjectRunAction) => number;
  private readonly createId: () => string;
  private readonly now: () => number;
  private readonly maxLogBytes: number;
  private readonly onLog: (event: ProjectRunLogEvent) => void;
  private readonly activeByRun = new Map<string, ActiveProjectRun>();
  private readonly activeByProject = new Map<string, string>();
  private readonly completions = new Map<string, Promise<ProjectRun>>();
  private startQueue: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(options: ProjectRunManagerOptions) {
    this.resolveProject = options.resolveProject;
    this.runner = options.runner ?? new ControlledProcessRunner();
    this.resolveCommand = options.resolveCommand ?? resolveProjectCommand;
    this.timeoutFor = options.timeoutFor ?? timeoutForAction;
    this.createId = options.createId ?? (() => `run-${randomUUID()}`);
    this.now = options.now ?? Date.now;
    this.maxLogBytes = options.maxLogBytes ?? DEFAULT_MAX_LOG_BYTES;
    this.onLog = options.onLog ?? (() => undefined);
  }

  start(
    projectId: string,
    requestedAction: ProjectRunAction,
  ): Promise<ProjectRun> {
    return this.enqueueStart(() =>
      this.startUnlocked(projectId, requestedAction),
    );
  }

  private async startUnlocked(
    projectId: string,
    requestedAction: ProjectRunAction,
  ): Promise<ProjectRun> {
    if (this.disposed) throw new Error("The project runner is shutting down.");
    const action = ProjectRunActionSchema.parse(requestedAction);
    const project = await this.resolveProject(projectId);
    if (!PROJECT_ACTIONS[project.kind].includes(action)) {
      throw new Error(
        `Run action "${action}" is not available for this project.`,
      );
    }
    if (this.activeByProject.has(project.id)) {
      throw new Error("This project already has a running command.");
    }
    const root = await canonicalizeProjectRoot(project.rootPath);
    await this.assertPackageScript(root, action);
    const id = RunIdSchema.parse(this.createId());
    const runDirectory = await assertProjectPathSafe(
      root,
      `.flowcode/runs/${id}`,
    );
    if (await pathExists(runDirectory)) {
      throw new Error(`Project run "${id}" already exists.`);
    }
    await mkdir(runDirectory, { recursive: true });
    const command = this.resolveCommand(project.kind, action);
    const logPath = path.join(runDirectory, "output.log");
    const metadataPath = path.join(runDirectory, "run.json");
    let gitCommit: string | undefined;
    try {
      gitCommit =
        (await readGitRepositoryStatus(project.id, root)).headSha ?? undefined;
    } catch {
      // Running remains useful when Git status is temporarily unavailable.
    }
    const startedAt = this.now();
    const run = ProjectRunSchema.parse({
      schemaVersion: 1,
      id,
      projectId: project.id,
      gitCommit,
      kind: project.kind,
      action,
      command: [command.executable, ...command.args],
      status: "running",
      startedAt,
      artifacts: [
        {
          kind: "log",
          path: `.flowcode/runs/${id}/output.log`,
          mediaType: "text/plain; charset=utf-8",
          label: `${action} log`,
        },
      ],
    });
    await writeJsonAtomic(metadataPath, run);

    let lastSequence = -1;
    const controlled: ControlledCommand = {
      id,
      executable: command.executable,
      args: command.args,
      cwd: root,
      logPath,
      timeoutMs: this.timeoutFor(action),
      maxLogBytes: this.maxLogBytes,
      env: projectRunnerEnvironment(),
    };
    const completion = this.runner
      .run(controlled, (event) => {
        lastSequence = event.sequence;
        this.emit({
          projectId: project.id,
          runId: id,
          sequence: event.sequence,
          stream: event.stream,
          text: event.text,
        });
      })
      .then(async (result) => {
        const completed = ProjectRunSchema.parse({
          ...run,
          status: result.status,
          completedAt: result.completedAt,
          exitCode: result.exitCode,
          error: result.error,
          logBytes: result.logBytes,
          logTruncated: result.logTruncated,
        });
        await writeJsonAtomic(metadataPath, completed);
        this.emit({
          projectId: project.id,
          runId: id,
          sequence: lastSequence + 1,
          stream: "system",
          text: `[FlowCode] ${action} ${completed.status}.\n`,
          run: completed,
        });
        return completed;
      })
      .catch(async (error) => {
        const completedAt = this.now();
        const failed = ProjectRunSchema.parse({
          ...run,
          status: "failed",
          completedAt,
          exitCode: null,
          error: errorMessage(error),
          logBytes: 0,
          logTruncated: false,
        });
        await writeJsonAtomic(metadataPath, failed);
        this.emit({
          projectId: project.id,
          runId: id,
          sequence: lastSequence + 1,
          stream: "system",
          text: `[FlowCode] ${errorMessage(error)}\n`,
          run: failed,
        });
        return failed;
      })
      .finally(() => {
        this.activeByRun.delete(id);
        if (this.activeByProject.get(project.id) === id) {
          this.activeByProject.delete(project.id);
        }
      });
    this.activeByRun.set(id, { projectId: project.id, completion });
    this.activeByProject.set(project.id, id);
    this.completions.set(id, completion);
    return run;
  }

  async cancel(projectId: string, runId: string): Promise<boolean> {
    const parsed = RunIdSchema.parse(runId);
    const active = this.activeByRun.get(parsed);
    if (!active || active.projectId !== projectId) return false;
    return this.runner.cancel(parsed);
  }

  async waitFor(runId: string): Promise<ProjectRun> {
    const completion = this.completions.get(RunIdSchema.parse(runId));
    if (!completion) throw new Error(`Project run "${runId}" is unknown.`);
    return completion;
  }

  async list(projectId: string): Promise<ProjectRun[]> {
    const project = await this.resolveProject(projectId);
    const root = await canonicalizeProjectRoot(project.rootPath);
    const runsRoot = await assertProjectPathSafe(root, ".flowcode/runs");
    if (!(await pathExists(runsRoot))) return [];
    const entries = await readdir(runsRoot, { withFileTypes: true });
    const runs: ProjectRun[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      try {
        const runId = RunIdSchema.parse(entry.name);
        const metadata = await assertProjectPathSafe(
          root,
          `.flowcode/runs/${runId}/run.json`,
        );
        runs.push(
          ProjectRunSchema.parse(
            JSON.parse(await readFile(metadata, "utf8")) as unknown,
          ),
        );
      } catch {
        // A malformed run is not allowed into the UI and does not block valid history.
      }
    }
    return runs
      .filter((run) => run.projectId === project.id)
      .sort((left, right) => right.startedAt - left.startedAt)
      .slice(0, MAX_RECENT_RUNS);
  }

  async readLog(projectId: string, runId: string): Promise<ProjectRunLog> {
    const project = await this.resolveProject(projectId);
    const root = await canonicalizeProjectRoot(project.rootPath);
    const parsedRunId = RunIdSchema.parse(runId);
    const metadataPath = await assertProjectPathSafe(
      root,
      `.flowcode/runs/${parsedRunId}/run.json`,
    );
    const run = ProjectRunSchema.parse(
      JSON.parse(await readFile(metadataPath, "utf8")) as unknown,
    );
    if (run.projectId !== project.id) {
      throw new Error("Project run metadata does not match this project.");
    }
    const logPath = await assertProjectPathSafe(
      root,
      `.flowcode/runs/${parsedRunId}/output.log`,
    );
    const handle = await open(logPath, "r");
    try {
      const info = await handle.stat();
      const length = Math.min(info.size, DEFAULT_LOG_TAIL_BYTES);
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, Math.max(0, info.size - length));
      return ProjectRunLogSchema.parse({
        content: buffer.toString("utf8"),
        truncated: info.size > length,
      });
    } finally {
      await handle.close();
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.startQueue;
    await this.runner.dispose();
    await Promise.all(
      [...this.activeByRun.values()].map(({ completion }) => completion),
    );
  }

  private async assertPackageScript(
    root: string,
    action: ProjectRunAction,
  ): Promise<void> {
    const packageFile = await assertProjectPathSafe(root, "package.json");
    const packageJson = JSON.parse(await readFile(packageFile, "utf8")) as {
      scripts?: Record<string, unknown>;
    };
    if (typeof packageJson.scripts?.[action] !== "string") {
      throw new Error(`Project package.json has no "${action}" script.`);
    }
  }

  private emit(event: ProjectRunLogEvent): void {
    try {
      this.onLog(ProjectRunLogEventSchema.parse(event));
    } catch {
      // UI delivery and validation cannot retain a finished child process.
    }
  }

  private enqueueStart<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.startQueue.then(operation, operation);
    this.startQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
