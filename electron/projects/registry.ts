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
import os from "node:os";
import path from "node:path";

import {
  FlowProjectSchema,
  PROJECT_REGISTRY_SCHEMA_VERSION,
  ProjectRegistrySchema,
  type FlowProject,
  type ProjectListItem,
  type ProjectRegistry as ProjectRegistryData,
} from "../../common/project";
import { canonicalizeProjectRoot, normalizeProjectRoot } from "./path-safety";

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function rootKey(value: string): string {
  const normalized = path.resolve(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export class ProjectRegistryCorruptError extends Error {
  constructor(file: string, cause?: unknown) {
    super(`FlowCode project registry is corrupt: ${file}`, { cause });
    this.name = "ProjectRegistryCorruptError";
  }
}

export function flowCodeDataRoot(): string {
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA;
    if (!localAppData) {
      throw new Error(
        "LOCALAPPDATA is unavailable; cannot locate FlowCode data.",
      );
    }
    return path.join(path.resolve(localAppData), "FlowCode");
  }
  const xdgDataHome = process.env.XDG_DATA_HOME;
  return xdgDataHome
    ? path.join(path.resolve(xdgDataHome), "FlowCode")
    : path.join(os.homedir(), ".local", "share", "FlowCode");
}

export function defaultProjectRegistryPath(): string {
  return path.join(flowCodeDataRoot(), "project-registry.json");
}

export class ProjectRegistry {
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(readonly filePath: string = defaultProjectRegistryPath()) {
    if (!path.isAbsolute(filePath)) {
      throw new Error("Project registry path must be absolute.");
    }
  }

  async canonicalRoot(rootPath: string): Promise<string> {
    return canonicalizeProjectRoot(rootPath);
  }

  async read(): Promise<ProjectRegistryData> {
    let text: string;
    try {
      text = await readFile(this.filePath, "utf8");
    } catch (error) {
      if (isMissing(error)) {
        return { schemaVersion: PROJECT_REGISTRY_SCHEMA_VERSION, projects: [] };
      }
      throw error;
    }

    try {
      return ProjectRegistrySchema.parse(JSON.parse(text) as unknown);
    } catch (error) {
      throw new ProjectRegistryCorruptError(this.filePath, error);
    }
  }

  async list(): Promise<ProjectListItem[]> {
    const registry = await this.read();
    const items = await Promise.all(
      registry.projects.map(async (project): Promise<ProjectListItem> => {
        let info;
        try {
          info = await lstat(normalizeProjectRoot(project.rootPath));
        } catch (error) {
          if (isMissing(error)) {
            return {
              project,
              availability: "missing",
              message: "The project folder no longer exists.",
            };
          }
          return {
            project,
            availability: "unsafe",
            message: error instanceof Error ? error.message : String(error),
          };
        }

        if (!info.isDirectory() || info.isSymbolicLink()) {
          return {
            project,
            availability: "unsafe",
            message: "The registered project root is not a normal directory.",
          };
        }
        try {
          await realpath(project.rootPath);
          return { project, availability: "available" };
        } catch (error) {
          return {
            project,
            availability: "unsafe",
            message: error instanceof Error ? error.message : String(error),
          };
        }
      }),
    );
    items.sort((a, b) => b.project.updatedAt - a.project.updatedAt);
    return items;
  }

  async get(id: string): Promise<FlowProject | null> {
    const registry = await this.read();
    return registry.projects.find((project) => project.id === id) ?? null;
  }

  async assertCanAdd(
    candidate: FlowProject,
    requireRoot = true,
  ): Promise<FlowProject> {
    const registry = await this.read();
    if (registry.projects.some(({ id }) => id === candidate.id)) {
      throw new Error(`Project id "${candidate.id}" is already registered.`);
    }
    const canonicalRoot = requireRoot
      ? await this.canonicalRoot(candidate.rootPath)
      : normalizeProjectRoot(candidate.rootPath);
    const project = FlowProjectSchema.parse({
      ...candidate,
      rootPath: canonicalRoot,
    });
    if (
      registry.projects.some(
        ({ rootPath }) => rootKey(rootPath) === rootKey(project.rootPath),
      )
    ) {
      throw new Error(
        `Project root "${project.rootPath}" is already registered.`,
      );
    }
    return project;
  }

  add(candidate: FlowProject): Promise<FlowProject> {
    return this.enqueue(async () => {
      const project = await this.assertCanAdd(candidate);
      const registry = await this.read();
      await this.write({
        schemaVersion: PROJECT_REGISTRY_SCHEMA_VERSION,
        projects: [...registry.projects, project],
      });
      return project;
    });
  }

  remove(id: string): Promise<void> {
    return this.enqueue(async () => {
      const registry = await this.read();
      const projects = registry.projects.filter((project) => project.id !== id);
      if (projects.length === registry.projects.length) return;
      await this.write({
        schemaVersion: PROJECT_REGISTRY_SCHEMA_VERSION,
        projects,
      });
    });
  }

  private async write(data: ProjectRegistryData): Promise<void> {
    const registry = ProjectRegistrySchema.parse(data);
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.tmp.${process.pid}.${randomUUID()}`;
    try {
      await writeFile(temporary, `${JSON.stringify(registry, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
      });
      await rename(temporary, this.filePath);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(operation, operation);
    this.mutationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
