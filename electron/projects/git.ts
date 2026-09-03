import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import type { FlowProject } from "../../common/project";
import {
  GitRepositoryStatusSchema,
  WorktreeRecordSchema,
  WorktreeRegistrySchema,
  type GitRepositoryStatus,
  type WorktreeRecord,
  type WorktreeRegistry,
} from "../../common/project-runtime";
import {
  canonicalizeProjectRoot,
  isPathInside,
  normalizeProjectRoot,
} from "./path-safety";
import { flowCodeDataRoot } from "./registry";

const DEFAULT_GIT_OUTPUT_BYTES = 2 * 1024 * 1024;

export interface GitResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  outputTruncated: boolean;
}

function appendBounded(
  chunks: Buffer[],
  chunk: Buffer,
  state: { bytes: number; truncated: boolean },
  maximum: number,
): void {
  const remaining = Math.max(0, maximum - state.bytes);
  if (remaining > 0) {
    const kept = chunk.subarray(0, remaining);
    chunks.push(kept);
    state.bytes += kept.byteLength;
  }
  if (chunk.byteLength > remaining) state.truncated = true;
}

export function runGit(
  directory: string,
  args: readonly string[],
  maxOutputBytes = DEFAULT_GIT_OUTPUT_BYTES,
): Promise<GitResult> {
  if (!path.isAbsolute(directory)) {
    return Promise.reject(new Error("Git working directory must be absolute."));
  }
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0) {
    return Promise.reject(new Error("Git output limit must be positive."));
  }
  if (args.some((argument) => argument.includes("\0"))) {
    return Promise.reject(
      new Error("Git arguments cannot contain null bytes."),
    );
  }

  return new Promise((resolve, reject) => {
    const child = spawn("git", [...args], {
      cwd: directory,
      shell: false,
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const stdoutState = { bytes: 0, truncated: false };
    const stderrState = { bytes: 0, truncated: false };
    child.stdout.on("data", (chunk: Buffer) =>
      appendBounded(stdout, chunk, stdoutState, maxOutputBytes),
    );
    child.stderr.on("data", (chunk: Buffer) =>
      appendBounded(stderr, chunk, stderrState, maxOutputBytes),
    );
    child.once("error", reject);
    child.once("close", (code) => {
      resolve({
        exitCode: code ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8").trim(),
        stderr: Buffer.concat(stderr).toString("utf8").trim(),
        outputTruncated: stdoutState.truncated || stderrState.truncated,
      });
    });
  });
}

function gitError(action: string, result: GitResult): Error {
  const detail =
    result.stderr || result.stdout || `exit code ${result.exitCode}`;
  return new Error(`Git could not ${action}: ${detail}`);
}

async function expectGit(
  directory: string,
  args: readonly string[],
  action: string,
): Promise<GitResult> {
  const result = await runGit(directory, args);
  if (result.exitCode !== 0) throw gitError(action, result);
  return result;
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
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

function pathKey(value: string): string {
  const normalized = path.resolve(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

async function canonicalPathKey(value: string): Promise<string> {
  try {
    return pathKey(await realpath(value));
  } catch (error) {
    if (isMissing(error)) return pathKey(value);
    throw error;
  }
}

async function samePath(left: string, right: string): Promise<boolean> {
  const [leftKey, rightKey] = await Promise.all([
    canonicalPathKey(left),
    canonicalPathKey(right),
  ]);
  return leftKey === rightKey;
}

function countStatusEntries(output: string): number {
  if (!output) return 0;
  const records = output.split("\0");
  let count = 0;
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record) continue;
    count += 1;
    if (/^[RC][ MTARC?][ ]/.test(record)) index += 1;
  }
  return count;
}

/** Read repository state without modifying the index or working tree. */
export async function readGitRepositoryStatus(
  projectId: string,
  directory: string,
): Promise<GitRepositoryStatus> {
  const root = await canonicalizeProjectRoot(directory);
  const topLevel = await expectGit(
    root,
    ["rev-parse", "--show-toplevel"],
    "locate the repository root",
  );
  const repositoryRoot = path.resolve(await realpath(topLevel.stdout));
  if (pathKey(repositoryRoot) !== pathKey(root)) {
    throw new Error(
      "The FlowCode project must be the root of its own Git repository.",
    );
  }

  const head = await runGit(root, ["rev-parse", "--verify", "HEAD"]);
  const hasCommits = head.exitCode === 0;
  const branchResult = await runGit(root, [
    "symbolic-ref",
    "--quiet",
    "--short",
    "HEAD",
  ]);
  const branch =
    branchResult.exitCode === 0 && branchResult.stdout
      ? branchResult.stdout
      : null;
  const changes = await expectGit(
    root,
    ["status", "--porcelain=v1", "-z", "--untracked-files=normal"],
    "read repository status",
  );
  const changedFileCount = countStatusEntries(changes.stdout);

  return GitRepositoryStatusSchema.parse({
    schemaVersion: 1,
    projectId,
    repositoryRoot,
    hasCommits,
    headSha: hasCommits ? head.stdout : null,
    branch,
    detached: hasCommits && branch === null,
    dirty: changedFileCount > 0,
    changedFileCount,
  });
}

/** Initialize a local-only repository and create the recoverable project baseline. */
export async function initializeLocalGit(directory: string): Promise<void> {
  const root = normalizeProjectRoot(directory);
  const dotGit = path.join(root, ".git");
  if (!(await pathExists(dotGit))) {
    await expectGit(
      root,
      ["init", "--initial-branch=main"],
      "initialize the repository",
    );
  } else {
    const info = await lstat(dotGit);
    if (info.isSymbolicLink()) {
      throw new Error("The project .git entry cannot be a symbolic link.");
    }
  }

  let status = await readGitRepositoryStatus("initializing-project", root);
  if (!status.hasCommits) {
    await expectGit(
      root,
      ["add", "--all"],
      "stage the initial project baseline",
    );
    await expectGit(
      root,
      [
        "-c",
        "user.name=FlowCode",
        "-c",
        "user.email=flowcode@localhost",
        "-c",
        "commit.gpgSign=false",
        "commit",
        "--no-verify",
        "-m",
        "chore: initialize FlowCode project",
      ],
      "commit the initial project baseline",
    );
    status = await readGitRepositoryStatus("initializing-project", root);
  }
  if (!status.hasCommits || status.dirty) {
    throw new Error(
      "The initial FlowCode Git baseline was not created cleanly.",
    );
  }

  const remotes = await expectGit(root, ["remote"], "inspect project remotes");
  if (remotes.stdout) {
    throw new Error(
      "A newly created FlowCode project must not have a Git remote.",
    );
  }
}

interface PorcelainWorktree {
  path: string;
  head: string | null;
  branch: string | null;
}

function parseWorktrees(output: string): PorcelainWorktree[] {
  const worktrees: PorcelainWorktree[] = [];
  let current: PorcelainWorktree | null = null;
  for (const field of output.split("\0")) {
    if (!field) continue;
    if (field.startsWith("worktree ")) {
      if (current) worktrees.push(current);
      current = {
        path: field.slice("worktree ".length),
        head: null,
        branch: null,
      };
    } else if (current && field.startsWith("HEAD ")) {
      current.head = field.slice("HEAD ".length);
    } else if (current && field.startsWith("branch ")) {
      current.branch = field.slice("branch ".length);
    }
  }
  if (current) worktrees.push(current);
  return worktrees;
}

export interface GitWorktreeServiceOptions {
  storageRoot?: string;
  resolveProject: (projectId: string) => Promise<FlowProject>;
  listProjects: () => Promise<FlowProject[]>;
  createId?: () => string;
  now?: () => number;
}

export function defaultWorktreeStorageRoot(): string {
  return path.join(flowCodeDataRoot(), "worktrees");
}

export class WorktreeRegistryCorruptError extends Error {
  constructor(file: string, cause?: unknown) {
    super(`FlowCode worktree registry is corrupt: ${file}`, { cause });
    this.name = "WorktreeRegistryCorruptError";
  }
}

export class GitWorktreeService {
  private readonly storageRoot: string;
  private readonly itemsRoot: string;
  private readonly registryFile: string;
  private readonly resolveProject: (projectId: string) => Promise<FlowProject>;
  private readonly listProjects: () => Promise<FlowProject[]>;
  private readonly createId: () => string;
  private readonly now: () => number;
  private operationQueue: Promise<void> = Promise.resolve();

  constructor(options: GitWorktreeServiceOptions) {
    this.storageRoot = normalizeProjectRoot(
      options.storageRoot ?? defaultWorktreeStorageRoot(),
    );
    this.itemsRoot = path.join(this.storageRoot, "items");
    this.registryFile = path.join(this.storageRoot, "registry.json");
    this.resolveProject = options.resolveProject;
    this.listProjects = options.listProjects;
    this.createId = options.createId ?? (() => `worktree-${randomUUID()}`);
    this.now = options.now ?? Date.now;
  }

  async status(projectId: string): Promise<GitRepositoryStatus> {
    const project = await this.resolveProject(projectId);
    return readGitRepositoryStatus(project.id, project.rootPath);
  }

  list(projectId: string): Promise<WorktreeRecord[]> {
    return this.readRegistry().then((registry) =>
      registry.worktrees
        .filter((record) => record.projectId === projectId)
        .sort((left, right) => right.updatedAt - left.updatedAt),
    );
  }

  create(projectId: string, reason: string): Promise<WorktreeRecord> {
    return this.enqueue(() => this.createUnlocked(projectId, reason));
  }

  accept(projectId: string, worktreeId: string): Promise<WorktreeRecord> {
    return this.enqueue(() => this.acceptUnlocked(projectId, worktreeId));
  }

  rollback(projectId: string, worktreeId: string): Promise<WorktreeRecord> {
    return this.enqueue(() => this.rollbackUnlocked(projectId, worktreeId));
  }

  cleanup(projectId: string, worktreeId: string): Promise<WorktreeRecord> {
    return this.enqueue(async () => {
      const project = await this.resolveProject(projectId);
      const record = await this.getRecord(project.id, worktreeId);
      if (
        record.state === "accepted" ||
        record.state === "reverted" ||
        record.state === "cleaned"
      ) {
        return record;
      }
      return this.discardManagedWorktree(project, record, "cleaned");
    });
  }

  recover(): Promise<WorktreeRecord[]> {
    return this.enqueue(() => this.recoverUnlocked());
  }

  private async createUnlocked(
    projectId: string,
    reason: string,
  ): Promise<WorktreeRecord> {
    const project = await this.resolveProject(projectId);
    const base = await readGitRepositoryStatus(project.id, project.rootPath);
    if (!base.hasCommits || !base.headSha) {
      throw new Error(
        "Create a Git baseline commit before making a FlowCode worktree.",
      );
    }
    if (!base.branch || base.detached) {
      throw new Error(
        "FlowCode worktrees require the project to be on a named branch.",
      );
    }

    const id = this.createId();
    const branch = `flowcode/run/${id}`;
    const rootPath = this.managedPath(id);
    const timestamp = this.now();
    const record = WorktreeRecordSchema.parse({
      schemaVersion: 1,
      id,
      projectId: project.id,
      reason,
      branch,
      rootPath,
      repositoryRoot: base.repositoryRoot,
      baseHead: base.headSha,
      baseBranch: base.branch,
      baseDirty: base.dirty,
      state: "creating",
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    const registry = await this.readRegistry();
    if (
      registry.worktrees.some(
        (item) =>
          item.id === id ||
          item.branch === branch ||
          pathKey(item.rootPath) === pathKey(rootPath),
      )
    ) {
      throw new Error(`FlowCode worktree id "${id}" already exists.`);
    }
    if (await pathExists(rootPath)) {
      throw new Error(`FlowCode worktree path already exists: ${rootPath}`);
    }

    await mkdir(this.itemsRoot, { recursive: true });
    await this.writeRegistry({
      schemaVersion: 1,
      worktrees: [...registry.worktrees, record],
    });
    try {
      await expectGit(
        project.rootPath,
        ["worktree", "add", "--no-track", "-b", branch, rootPath, base.headSha],
        "create the isolated worktree",
      );
      return this.updateRecord({
        ...record,
        state: "active",
        updatedAt: this.now(),
      });
    } catch (error) {
      await this.removeGitWorktree(project.rootPath, record).catch(
        () => undefined,
      );
      const orphaned = await this.updateRecord({
        ...record,
        state: "orphaned",
        updatedAt: this.now(),
        lastError: error instanceof Error ? error.message : String(error),
      });
      throw new Error(orphaned.lastError, { cause: error });
    }
  }

  private async acceptUnlocked(
    projectId: string,
    worktreeId: string,
  ): Promise<WorktreeRecord> {
    const project = await this.resolveProject(projectId);
    const record = await this.getRecord(project.id, worktreeId);
    await this.assertActiveAndManaged(project, record);
    const main = await readGitRepositoryStatus(project.id, project.rootPath);
    if (main.dirty) {
      throw new Error(
        "The original project working tree is dirty; FlowCode will not modify it.",
      );
    }
    if (main.headSha !== record.baseHead || main.branch !== record.baseBranch) {
      throw new Error(
        "The original project HEAD changed after this worktree was created.",
      );
    }
    const isolated = await readGitRepositoryStatus(project.id, record.rootPath);
    if (isolated.dirty) {
      throw new Error(
        "Commit or discard worktree changes before accepting it.",
      );
    }
    if (isolated.branch !== record.branch) {
      throw new Error(
        "The isolated worktree is no longer on its managed branch.",
      );
    }

    const accepting = await this.updateRecord({
      ...record,
      state: "accepting",
      updatedAt: this.now(),
      lastError: undefined,
    });
    try {
      await expectGit(
        project.rootPath,
        ["merge", "--ff-only", record.branch],
        "fast-forward the accepted worktree",
      );
      await this.removeGitWorktree(project.rootPath, record, false);
      const completedAt = this.now();
      return this.updateRecord({
        ...accepting,
        state: "accepted",
        updatedAt: completedAt,
        completedAt,
      });
    } catch (error) {
      await this.updateRecord({
        ...accepting,
        state: "orphaned",
        updatedAt: this.now(),
        lastError: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private async rollbackUnlocked(
    projectId: string,
    worktreeId: string,
  ): Promise<WorktreeRecord> {
    const project = await this.resolveProject(projectId);
    const record = await this.getRecord(project.id, worktreeId);
    await this.assertActiveAndManaged(project, record);
    const rollingBack = await this.updateRecord({
      ...record,
      state: "rolling-back",
      updatedAt: this.now(),
      lastError: undefined,
    });
    return this.discardManagedWorktree(project, rollingBack);
  }

  private async discardManagedWorktree(
    project: FlowProject,
    record: WorktreeRecord,
    finalState: "reverted" | "cleaned" = "reverted",
  ): Promise<WorktreeRecord> {
    await this.assertManaged(project, record);
    try {
      await this.removeGitWorktree(project.rootPath, record, true);
      const completedAt = this.now();
      return this.updateRecord({
        ...record,
        state: finalState,
        updatedAt: completedAt,
        completedAt,
        lastError: undefined,
      });
    } catch (error) {
      await this.updateRecord({
        ...record,
        state: "orphaned",
        updatedAt: this.now(),
        completedAt: undefined,
        lastError: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private async recoverUnlocked(): Promise<WorktreeRecord[]> {
    const registry = await this.readRegistry();
    const projects = await this.listProjects();
    const byId = new Map(projects.map((project) => [project.id, project]));
    let records = [...registry.worktrees];
    const timestamp = this.now();

    for (const project of projects) {
      let entries: PorcelainWorktree[];
      let projectStatus: GitRepositoryStatus;
      try {
        projectStatus = await readGitRepositoryStatus(
          project.id,
          project.rootPath,
        );
        entries = parseWorktrees(
          (
            await expectGit(
              project.rootPath,
              ["worktree", "list", "--porcelain", "-z"],
              "list project worktrees",
            )
          ).stdout,
        );
      } catch {
        continue;
      }

      for (const entry of entries) {
        const branch = entry.branch?.replace(/^refs\/heads\//, "") ?? null;
        if (!branch?.startsWith("flowcode/run/")) continue;
        const id = branch.slice("flowcode/run/".length);
        let expectedPath: string;
        try {
          expectedPath = this.managedPath(id);
        } catch {
          continue;
        }
        if (!(await samePath(entry.path, expectedPath))) continue;
        if (
          records.some((record) => record.id === id || record.branch === branch)
        ) {
          continue;
        }
        const baseHead = projectStatus.headSha ?? entry.head;
        if (!baseHead || !projectStatus.branch) continue;
        records.push(
          WorktreeRecordSchema.parse({
            schemaVersion: 1,
            id,
            projectId: project.id,
            reason: "Recovered after an interrupted FlowCode operation.",
            branch,
            rootPath: expectedPath,
            repositoryRoot: projectStatus.repositoryRoot,
            baseHead,
            baseBranch: projectStatus.branch,
            baseDirty: projectStatus.dirty,
            state: "orphaned",
            createdAt: timestamp,
            updatedAt: timestamp,
            lastError:
              "Recovered an untracked FlowCode worktree; review or clean it up.",
          }),
        );
      }
    }

    records = await Promise.all(
      records.map(async (record) => {
        if (
          record.state === "accepted" ||
          record.state === "reverted" ||
          record.state === "cleaned"
        ) {
          return record;
        }
        const project = byId.get(record.projectId);
        if (!project) {
          return WorktreeRecordSchema.parse({
            ...record,
            state: "orphaned",
            updatedAt: timestamp,
            lastError:
              "The registered project is unavailable during worktree recovery.",
          });
        }
        let entries: PorcelainWorktree[] = [];
        try {
          entries = parseWorktrees(
            (
              await expectGit(
                project.rootPath,
                ["worktree", "list", "--porcelain", "-z"],
                "list project worktrees",
              )
            ).stdout,
          );
        } catch {
          // The explicit orphan state below keeps recovery fail-closed.
        }
        let match: PorcelainWorktree | undefined;
        for (const entry of entries) {
          if (await samePath(entry.path, record.rootPath)) {
            match = entry;
            break;
          }
        }
        const branch = match?.branch?.replace(/^refs\/heads\//, "") ?? null;
        if (
          match &&
          branch === record.branch &&
          (await pathExists(record.rootPath))
        ) {
          if (record.state === "active" || record.state === "orphaned")
            return record;
          return WorktreeRecordSchema.parse({
            ...record,
            state: "orphaned",
            updatedAt: timestamp,
            lastError:
              "Recovered an interrupted worktree operation; review or clean it up.",
          });
        }
        return WorktreeRecordSchema.parse({
          ...record,
          state: "orphaned",
          updatedAt: timestamp,
          lastError:
            "The managed worktree is missing or no longer registered with Git.",
        });
      }),
    );

    await this.writeRegistry({ schemaVersion: 1, worktrees: records });
    return records.sort((left, right) => right.updatedAt - left.updatedAt);
  }

  private async removeGitWorktree(
    repositoryRoot: string,
    record: WorktreeRecord,
    force = true,
  ): Promise<void> {
    const managed = this.managedPath(record.id);
    if (pathKey(managed) !== pathKey(record.rootPath)) {
      throw new Error(
        "Refusing to remove a worktree outside FlowCode managed storage.",
      );
    }
    if (record.branch !== `flowcode/run/${record.id}`) {
      throw new Error("Refusing to remove an unexpected worktree branch.");
    }

    const removeArgs = ["worktree", "remove"];
    if (force) removeArgs.push("--force");
    removeArgs.push(record.rootPath);
    const removed = await runGit(repositoryRoot, removeArgs);
    if (removed.exitCode !== 0 && (await pathExists(record.rootPath))) {
      throw gitError("remove the managed worktree", removed);
    }
    await runGit(repositoryRoot, ["worktree", "prune"]);
    if (await pathExists(record.rootPath)) {
      await rm(record.rootPath, { recursive: true, force: true });
    }

    const deleted = await runGit(repositoryRoot, [
      "branch",
      force ? "-D" : "-d",
      record.branch,
    ]);
    if (deleted.exitCode !== 0) {
      const exists = await runGit(repositoryRoot, [
        "branch",
        "--list",
        record.branch,
      ]);
      if (exists.exitCode !== 0 || exists.stdout) {
        throw gitError("delete the managed worktree branch", deleted);
      }
    }
  }

  private managedPath(id: string): string {
    const parsed = WorktreeRecordSchema.shape.id.parse(id);
    const target = path.resolve(this.itemsRoot, parsed);
    if (
      path.dirname(target) !== path.resolve(this.itemsRoot) ||
      !isPathInside(this.itemsRoot, target)
    ) {
      throw new Error("Invalid managed worktree path.");
    }
    return target;
  }

  private async assertActiveAndManaged(
    project: FlowProject,
    record: WorktreeRecord,
  ): Promise<void> {
    if (record.state !== "active") {
      throw new Error(`Worktree "${record.id}" is not active.`);
    }
    await this.assertManaged(project, record);
  }

  private async assertManaged(
    project: FlowProject,
    record: WorktreeRecord,
  ): Promise<void> {
    const repositoryMatches = await samePath(
      record.repositoryRoot,
      project.rootPath,
    );
    if (
      record.projectId !== project.id ||
      !repositoryMatches ||
      pathKey(record.rootPath) !== pathKey(this.managedPath(record.id)) ||
      record.branch !== `flowcode/run/${record.id}`
    ) {
      throw new Error(
        "Worktree metadata does not match the managed project boundary.",
      );
    }
  }

  private async getRecord(
    projectId: string,
    worktreeId: string,
  ): Promise<WorktreeRecord> {
    const registry = await this.readRegistry();
    const record = registry.worktrees.find(
      (candidate) =>
        candidate.id === worktreeId && candidate.projectId === projectId,
    );
    if (!record) throw new Error(`Worktree "${worktreeId}" was not found.`);
    return record;
  }

  private async updateRecord(record: WorktreeRecord): Promise<WorktreeRecord> {
    const parsed = WorktreeRecordSchema.parse(record);
    const registry = await this.readRegistry();
    const index = registry.worktrees.findIndex((item) => item.id === parsed.id);
    if (index < 0) throw new Error(`Worktree "${parsed.id}" was not found.`);
    const worktrees = [...registry.worktrees];
    worktrees[index] = parsed;
    await this.writeRegistry({ schemaVersion: 1, worktrees });
    return parsed;
  }

  private async readRegistry(): Promise<WorktreeRegistry> {
    let text: string;
    try {
      text = await readFile(this.registryFile, "utf8");
    } catch (error) {
      if (isMissing(error)) return { schemaVersion: 1, worktrees: [] };
      throw error;
    }
    try {
      return WorktreeRegistrySchema.parse(JSON.parse(text) as unknown);
    } catch (error) {
      throw new WorktreeRegistryCorruptError(this.registryFile, error);
    }
  }

  private async writeRegistry(registry: WorktreeRegistry): Promise<void> {
    const parsed = WorktreeRegistrySchema.parse(registry);
    await mkdir(this.storageRoot, { recursive: true });
    const temporary = `${this.registryFile}.tmp.${process.pid}.${randomUUID()}`;
    try {
      await writeFile(temporary, `${JSON.stringify(parsed, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
      });
      await rename(temporary, this.registryFile);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationQueue.then(operation, operation);
    this.operationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
