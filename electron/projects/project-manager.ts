import { randomUUID } from "node:crypto";
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import {
  FLOWCODE_PROJECT_DIRECTORY,
  FLOWCODE_PROJECT_FILE,
  FlowProjectSchema,
  ProjectIdSchema,
  ProjectKindSchema,
  type FlowProject,
  type ProjectKind,
  type ProjectListItem,
  type TemplateManifest,
} from "../../common/project";
import { TemplateStore } from "../templates/template-store";
import { initializeLocalGit } from "./git";
import {
  assertProjectPathSafe,
  canonicalizeProjectRoot,
  normalizeProjectRoot,
  projectFolderName,
  resolveProjectTarget,
} from "./path-safety";
import { ProjectRegistry } from "./registry";

export interface CreateProjectOptions {
  id?: string;
  name: string;
  kind: ProjectKind;
  targetPath: string;
}

export interface ProjectManagerOptions {
  registry: ProjectRegistry;
  templates: TemplateStore;
  initializeGit?: (directory: string) => Promise<void>;
  now?: () => number;
  createId?: () => string;
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

async function pathExists(file: string): Promise<boolean> {
  try {
    await lstat(file);
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

const REQUIRED_PATHS: Record<ProjectKind, readonly string[]> = {
  "web-test": [
    "tests",
    "pages",
    "fixtures",
    "data",
    "assertions",
    "utils",
    "playwright.config.ts",
    "package.json",
    "tsconfig.json",
    "eslint.config.js",
    ".env.example",
    "README.md",
  ],
  "browser-automation": [
    "src/pages",
    "src/workflows",
    "src/fixtures",
    "src/config",
    "src/cli",
    "src/utils",
    "tests/smoke",
    "package.json",
    "tsconfig.json",
    "eslint.config.js",
    ".env.example",
    "README.md",
  ],
};

const REQUIRED_SCRIPTS: Record<ProjectKind, readonly string[]> = {
  "web-test": [
    "test",
    "test:ui",
    "test:headed",
    "report",
    "typecheck",
    "lint",
    "format",
  ],
  "browser-automation": ["start", "workflow", "smoke", "typecheck", "lint"],
};

export class ProjectManager {
  private readonly registry: ProjectRegistry;
  private readonly templates: TemplateStore;
  private readonly initializeGit: (directory: string) => Promise<void>;
  private readonly now: () => number;
  private readonly createId: () => string;
  private creationQueue: Promise<void> = Promise.resolve();

  constructor(options: ProjectManagerOptions) {
    this.registry = options.registry;
    this.templates = options.templates;
    this.initializeGit = options.initializeGit ?? initializeLocalGit;
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? (() => `project-${randomUUID()}`);
  }

  list(): Promise<ProjectListItem[]> {
    return this.registry.list();
  }

  async planTarget(
    parentDirectory: string,
    projectName: string,
  ): Promise<string> {
    const parent = await canonicalizeProjectRoot(parentDirectory);
    return resolveProjectTarget(parent, projectFolderName(projectName));
  }

  create(options: CreateProjectOptions): Promise<FlowProject> {
    return this.enqueueCreation(() => this.createUnlocked(options));
  }

  async open(id: string): Promise<FlowProject> {
    const projectId = ProjectIdSchema.parse(id);
    const item = (await this.registry.list()).find(
      ({ project }) => project.id === projectId,
    );
    if (!item) throw new Error(`Project "${projectId}" is not registered.`);
    if (item.availability !== "available") {
      throw new Error(item.message ?? `Project "${projectId}" is unavailable.`);
    }

    const file = await assertProjectPathSafe(
      item.project.rootPath,
      `${FLOWCODE_PROJECT_DIRECTORY}/${FLOWCODE_PROJECT_FILE}`,
    );
    const stored = FlowProjectSchema.parse(
      JSON.parse(await readFile(file, "utf8")) as unknown,
    );
    if (
      stored.id !== item.project.id ||
      normalizeProjectRoot(stored.rootPath) !== item.project.rootPath
    ) {
      throw new Error(
        "The project metadata does not match its registry entry.",
      );
    }
    return stored;
  }

  private async createUnlocked(
    options: CreateProjectOptions,
  ): Promise<FlowProject> {
    const name = FlowProjectSchema.shape.name.parse(options.name);
    const kind = ProjectKindSchema.parse(options.kind);
    const id = ProjectIdSchema.parse(options.id ?? this.createId());
    const requestedTarget = normalizeProjectRoot(options.targetPath);
    const parent = await canonicalizeProjectRoot(path.dirname(requestedTarget));
    const targetPath = resolveProjectTarget(
      parent,
      path.basename(requestedTarget),
    );
    if (await pathExists(targetPath)) {
      throw new Error(`Project target already exists: ${targetPath}`);
    }

    const manifest = await this.templates.forKind(kind);
    const timestamp = this.now();
    const project = FlowProjectSchema.parse({
      schemaVersion: 1,
      id,
      name,
      kind,
      rootPath: targetPath,
      templateId: manifest.id,
      templateVersion: manifest.version,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    await this.registry.assertCanAdd(project, false);

    const temporary = await mkdtemp(
      path.join(parent, `.${path.basename(targetPath)}.flowcode-tmp-`),
    );
    let moved = false;
    try {
      await this.templates.materialize(manifest.id, temporary);
      await this.writeProjectMetadata(temporary, project);
      await this.initializeGit(temporary);
      await this.verifyProject(temporary, project, manifest);
      await rename(temporary, targetPath);
      moved = true;
      try {
        return await this.registry.add(project);
      } catch (error) {
        await rm(targetPath, { recursive: true, force: true });
        moved = false;
        throw error;
      }
    } finally {
      if (!moved) await rm(temporary, { recursive: true, force: true });
    }
  }

  private async writeProjectMetadata(
    directory: string,
    project: FlowProject,
  ): Promise<void> {
    const flowcode = path.join(directory, FLOWCODE_PROJECT_DIRECTORY);
    await mkdir(path.join(flowcode, "blueprints"), { recursive: true });
    await mkdir(path.join(flowcode, "runs"), { recursive: true });
    await writeJsonAtomic(path.join(flowcode, FLOWCODE_PROJECT_FILE), project);
  }

  private async verifyProject(
    directory: string,
    project: FlowProject,
    manifest: TemplateManifest,
  ): Promise<void> {
    await this.templates.verifyMaterialized(manifest, directory);
    for (const relative of REQUIRED_PATHS[project.kind]) {
      await access(await assertProjectPathSafe(directory, relative));
    }

    const metadataFile = await assertProjectPathSafe(
      directory,
      `${FLOWCODE_PROJECT_DIRECTORY}/${FLOWCODE_PROJECT_FILE}`,
    );
    await access(
      await assertProjectPathSafe(
        directory,
        `${FLOWCODE_PROJECT_DIRECTORY}/blueprints`,
      ),
    );
    await access(
      await assertProjectPathSafe(
        directory,
        `${FLOWCODE_PROJECT_DIRECTORY}/runs`,
      ),
    );
    const metadata = FlowProjectSchema.parse(
      JSON.parse(await readFile(metadataFile, "utf8")) as unknown,
    );
    if (metadata.id !== project.id || metadata.rootPath !== project.rootPath) {
      throw new Error("Generated project metadata failed validation.");
    }

    const packageFile = await assertProjectPathSafe(directory, "package.json");
    const packageJson = JSON.parse(await readFile(packageFile, "utf8")) as {
      scripts?: Record<string, unknown>;
    };
    for (const script of REQUIRED_SCRIPTS[project.kind]) {
      if (typeof packageJson.scripts?.[script] !== "string") {
        throw new Error(`Generated project is missing npm script "${script}".`);
      }
    }

    const ignoreFile = await assertProjectPathSafe(directory, ".gitignore");
    const ignore = await readFile(ignoreFile, "utf8");
    const ignoreLines = new Set(
      ignore.split(/\r?\n/).map((line) => line.trim()),
    );
    for (const ignored of ["node_modules/", ".env", ".flowcode/runs/"]) {
      if (!ignoreLines.has(ignored)) {
        throw new Error(
          `Generated project .gitignore is missing "${ignored}".`,
        );
      }
    }
  }

  private enqueueCreation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.creationQueue.then(operation, operation);
    this.creationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
