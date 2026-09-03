import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { TextDecoder } from "node:util";

import type { FlowProject } from "../../common/project";
import {
  ProjectFileContentSchema,
  ProjectRelativePathSchema,
  ProjectTreeSchema,
  type ProjectFileContent,
  type ProjectTree,
  type ProjectTreeEntry,
} from "../../common/project-runtime";
import { assertProjectPathSafe, canonicalizeProjectRoot } from "./path-safety";

const DEFAULT_MAX_ENTRIES = 20_000;
const DEFAULT_MAX_FILE_BYTES = 1024 * 1024;

export interface ProjectFileServiceOptions {
  maxEntries?: number;
  maxFileBytes?: number;
}

type ProjectResolver = (projectId: string) => Promise<FlowProject>;

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

function posixJoin(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name;
}

function isPrivateOrGenerated(relativePath: string): boolean {
  const lower = relativePath.toLowerCase();
  const segments = lower.split("/");
  const name = segments.at(-1) ?? "";
  if (segments[0] === ".git" || segments[0] === "node_modules") return true;
  if (
    lower === ".flowcode/runs" ||
    lower.startsWith(".flowcode/runs/") ||
    lower === ".flowcode/storage-state" ||
    lower.startsWith(".flowcode/storage-state/")
  ) {
    return true;
  }
  if (
    name === ".env" ||
    (name.startsWith(".env.") && name !== ".env.example")
  ) {
    return true;
  }
  if (
    [
      ".git-credentials",
      ".netrc",
      ".npmrc",
      "_netrc",
      "credentials.json",
      "secrets.json",
    ].includes(name)
  ) {
    return true;
  }
  return [".key", ".p12", ".pem", ".pfx"].includes(path.posix.extname(name));
}

function languageFor(relativePath: string): string {
  const name = path.posix.basename(relativePath).toLowerCase();
  const extension = path.posix.extname(name);
  if (name === "dockerfile") return "dockerfile";
  if (name === ".gitignore" || name === ".gitattributes") return "plaintext";
  return (
    (
      {
        ".cjs": "javascript",
        ".css": "css",
        ".html": "html",
        ".js": "javascript",
        ".json": "json",
        ".jsx": "javascript",
        ".md": "markdown",
        ".mjs": "javascript",
        ".ts": "typescript",
        ".tsx": "typescript",
        ".xml": "xml",
        ".yaml": "yaml",
        ".yml": "yaml",
      } as Record<string, string>
    )[extension] ?? "plaintext"
  );
}

export class ProjectFileService {
  private readonly maxEntries: number;
  private readonly maxFileBytes: number;

  constructor(
    private readonly resolveProject: ProjectResolver,
    options: ProjectFileServiceOptions = {},
  ) {
    this.maxEntries = positiveInteger(
      options.maxEntries ?? DEFAULT_MAX_ENTRIES,
      "maxEntries",
    );
    this.maxFileBytes = positiveInteger(
      options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
      "maxFileBytes",
    );
  }

  async list(projectId: string): Promise<ProjectTree> {
    const project = await this.resolveProject(projectId);
    const root = await canonicalizeProjectRoot(project.rootPath);
    const entries: ProjectTreeEntry[] = [];
    const pending = [""];
    let truncated = false;

    while (pending.length > 0 && !truncated) {
      const parent = pending.pop() ?? "";
      const directory = parent
        ? await assertProjectPathSafe(root, parent)
        : root;
      const children = await readdir(directory, { withFileTypes: true });
      children.sort((left, right) => {
        const kind = Number(right.isDirectory()) - Number(left.isDirectory());
        return kind || left.name.localeCompare(right.name);
      });

      const childDirectories: string[] = [];
      for (const child of children) {
        const relative = posixJoin(parent, child.name);
        if (isPrivateOrGenerated(relative) || child.isSymbolicLink()) continue;
        if (entries.length >= this.maxEntries) {
          truncated = true;
          break;
        }
        if (child.isDirectory()) {
          entries.push({ path: relative, kind: "directory" });
          childDirectories.push(relative);
        } else if (child.isFile()) {
          const info = await lstat(path.join(directory, child.name));
          entries.push({ path: relative, kind: "file", size: info.size });
        }
      }
      pending.push(...childDirectories.reverse());
    }

    entries.sort((left, right) => left.path.localeCompare(right.path));
    return ProjectTreeSchema.parse({ entries, truncated });
  }

  async read(
    projectId: string,
    inputPath: string,
  ): Promise<ProjectFileContent> {
    const relativePath = ProjectRelativePathSchema.parse(inputPath);
    if (isPrivateOrGenerated(relativePath)) {
      throw new Error(
        "Sensitive, private, or generated project files cannot be opened.",
      );
    }
    const project = await this.resolveProject(projectId);
    const root = await canonicalizeProjectRoot(project.rootPath);
    const file = await assertProjectPathSafe(root, relativePath);
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error("Only normal project files can be opened.");
    }
    if (info.size > this.maxFileBytes) {
      throw new Error(
        `Project file is too large; the read-only limit is ${this.maxFileBytes} bytes.`,
      );
    }

    const bytes = await readFile(file);
    if (bytes.includes(0))
      throw new Error("Binary project files cannot be opened.");
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new Error("Project file is not valid UTF-8 text.");
    }
    return ProjectFileContentSchema.parse({
      path: relativePath,
      content,
      size: bytes.byteLength,
      language: languageFor(relativePath),
      readOnly: true,
    });
  }
}
