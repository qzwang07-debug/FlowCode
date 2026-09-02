import { createHash } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
} from "node:fs/promises";
import path from "node:path";

import {
  ProjectIdSchema,
  TemplateManifestSchema,
  type ProjectKind,
  type TemplateFile,
  type TemplateManifest,
} from "../../common/project";
import { isPathInside } from "../projects/path-safety";

const MANIFEST_FILE = "template.json";

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function posixPath(value: string): string {
  return value.split(path.sep).join("/");
}

async function sha256(file: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(file))
    .digest("hex");
}

/** Hash the ordered file inventory as `path NUL digest NUL required LF`. */
export function templateIntegrity(files: readonly TemplateFile[]): string {
  const inventory = [...files]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map(
      (file) => `${file.path}\0${file.sha256}\0${file.required ? "1" : "0"}\n`,
    )
    .join("");
  return createHash("sha256").update(inventory).digest("hex");
}

async function walkFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (!directory) break;
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) {
        throw new Error(
          `Template contains a symbolic link: ${posixPath(path.relative(root, absolute))}`,
        );
      }
      if (info.isDirectory()) {
        pending.push(absolute);
      } else if (info.isFile()) {
        const relative = posixPath(path.relative(root, absolute));
        if (relative !== MANIFEST_FILE) files.push(relative);
      } else {
        throw new Error(
          `Template contains an unsupported filesystem entry: ${entry.name}`,
        );
      }
    }
  }
  files.sort();
  return files;
}

export class TemplateStore {
  readonly root: string;

  constructor(root: string) {
    if (!path.isAbsolute(root))
      throw new Error("Template root must be absolute.");
    this.root = path.resolve(root);
  }

  async list(): Promise<TemplateManifest[]> {
    const entries = await readdir(this.root, { withFileTypes: true });
    const manifests: TemplateManifest[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      manifests.push(await this.readManifest(entry.name));
    }
    manifests.sort((a, b) => a.id.localeCompare(b.id));
    return manifests;
  }

  async forKind(kind: ProjectKind): Promise<TemplateManifest> {
    const matches = (await this.list()).filter(
      (manifest) => manifest.kind === kind,
    );
    if (matches.length !== 1) {
      throw new Error(
        `Expected exactly one template for project kind "${kind}".`,
      );
    }
    await this.validate(matches[0].id);
    return matches[0];
  }

  async validate(id: string): Promise<TemplateManifest> {
    const manifest = await this.readManifest(id);
    const directory = this.templateDirectory(id);
    const directoryInfo = await lstat(directory);
    if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) {
      throw new Error(`Template "${id}" is not a normal directory.`);
    }
    const canonicalDirectory = path.resolve(await realpath(directory));
    const actualPaths = await walkFiles(directory);
    const declared = new Map(manifest.files.map((file) => [file.path, file]));

    for (const actual of actualPaths) {
      if (!declared.has(actual)) {
        throw new Error(
          `Template "${id}" contains undeclared file "${actual}".`,
        );
      }
    }
    for (const file of manifest.files) {
      if (!actualPaths.includes(file.path)) {
        if (file.required) {
          throw new Error(
            `Template "${id}" is missing required file "${file.path}".`,
          );
        }
        continue;
      }
      const source = path.join(directory, ...file.path.split("/"));
      const info = await lstat(source);
      if (info.isSymbolicLink()) {
        throw new Error(`Template file "${file.path}" is a symbolic link.`);
      }
      const canonicalSource = path.resolve(await realpath(source));
      if (!isPathInside(canonicalDirectory, canonicalSource)) {
        throw new Error(
          `Template file "${file.path}" resolves outside its template.`,
        );
      }
      const digest = await sha256(source);
      if (digest !== file.sha256) {
        throw new Error(
          `Template file "${file.path}" failed its SHA-256 check.`,
        );
      }
    }
    if (templateIntegrity(manifest.files) !== manifest.integrity.value) {
      throw new Error(`Template "${id}" failed its manifest integrity check.`);
    }
    return manifest;
  }

  async materialize(
    id: string,
    destination: string,
  ): Promise<TemplateManifest> {
    const manifest = await this.validate(id);
    try {
      await mkdir(destination);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const info = await lstat(destination);
      if (!info.isDirectory() || info.isSymbolicLink()) {
        throw new Error("Template destination must be a normal directory.");
      }
      if ((await readdir(destination)).length !== 0) {
        throw new Error("Template destination must be empty.");
      }
    }

    const sourceRoot = this.templateDirectory(id);
    for (const file of manifest.files) {
      const source = path.join(sourceRoot, ...file.path.split("/"));
      let sourceInfo;
      try {
        sourceInfo = await lstat(source);
      } catch (error) {
        if (!file.required && isMissing(error)) continue;
        throw error;
      }
      if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink()) {
        throw new Error(`Template file "${file.path}" is not a normal file.`);
      }
      const target = path.join(destination, ...file.path.split("/"));
      await mkdir(path.dirname(target), { recursive: true });
      await copyFile(source, target);
    }
    await this.verifyMaterialized(manifest, destination);
    return manifest;
  }

  async verifyMaterialized(
    manifest: TemplateManifest,
    destination: string,
  ): Promise<void> {
    const rootInfo = await lstat(destination);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
      throw new Error("Materialized template root must be a normal directory.");
    }
    const canonicalRoot = path.resolve(await realpath(destination));
    for (const file of manifest.files) {
      const target = path.join(destination, ...file.path.split("/"));
      let info;
      try {
        info = await lstat(target);
      } catch (error) {
        if (
          !file.required &&
          (error as NodeJS.ErrnoException).code === "ENOENT"
        )
          continue;
        throw error;
      }
      if (!info.isFile() || info.isSymbolicLink()) {
        throw new Error(
          `Materialized file "${file.path}" is not a normal file.`,
        );
      }
      const canonicalTarget = path.resolve(await realpath(target));
      if (!isPathInside(canonicalRoot, canonicalTarget)) {
        throw new Error(
          `Materialized file "${file.path}" resolves outside the project.`,
        );
      }
      if ((await sha256(target)) !== file.sha256) {
        throw new Error(
          `Materialized file "${file.path}" failed its SHA-256 check.`,
        );
      }
    }
  }

  private templateDirectory(id: string): string {
    if (!ProjectIdSchema.safeParse(id).success)
      throw new Error("Invalid template id.");
    return path.join(this.root, id);
  }

  private async readManifest(id: string): Promise<TemplateManifest> {
    const directory = this.templateDirectory(id);
    let raw: unknown;
    try {
      raw = JSON.parse(
        await readFile(path.join(directory, MANIFEST_FILE), "utf8"),
      ) as unknown;
    } catch (error) {
      throw new Error(`Could not read template manifest for "${id}".`, {
        cause: error,
      });
    }
    const manifest = TemplateManifestSchema.parse(raw);
    if (manifest.id !== id) {
      throw new Error(
        `Template directory "${id}" contains manifest id "${manifest.id}".`,
      );
    }
    return manifest;
  }
}
