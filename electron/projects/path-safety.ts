import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function pathKey(value: string): string {
  const normalized = path.resolve(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(pathKey(root), pathKey(candidate));
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

export function normalizeProjectRoot(input: string): string {
  if (typeof input !== "string" || input.length === 0 || input.includes("\0")) {
    throw new Error("Project root must be a non-empty absolute path.");
  }
  if (!path.isAbsolute(input)) {
    throw new Error("Project root must be an absolute path.");
  }
  return path.resolve(input);
}

function relativeSegments(relativePath: string): string[] {
  if (
    typeof relativePath !== "string" ||
    relativePath.length === 0 ||
    relativePath.includes("\0") ||
    path.isAbsolute(relativePath) ||
    path.win32.isAbsolute(relativePath) ||
    path.posix.isAbsolute(relativePath)
  ) {
    throw new Error("Project paths must be non-empty relative paths.");
  }

  const segments = relativePath.split(/[\\/]+/);
  if (
    segments.some(
      (segment) => segment === "" || segment === "." || segment === "..",
    )
  ) {
    throw new Error("Project path traversal is not allowed.");
  }
  return segments;
}

export function resolveProjectPath(root: string, relativePath: string): string {
  const normalizedRoot = normalizeProjectRoot(root);
  const resolved = path.resolve(
    normalizedRoot,
    ...relativeSegments(relativePath),
  );
  if (!isPathInside(normalizedRoot, resolved) || resolved === normalizedRoot) {
    throw new Error("Project path resolves outside the project root.");
  }
  return resolved;
}

export function resolveProjectTarget(
  parent: string,
  folderName: string,
): string {
  const normalizedParent = normalizeProjectRoot(parent);
  const segments = relativeSegments(folderName);
  if (
    segments.length !== 1 ||
    folderName.includes("/") ||
    folderName.includes("\\")
  ) {
    throw new Error(
      "A project target must be a single folder name without traversal.",
    );
  }
  if (/[<>:"|?*]/.test(folderName) || /[. ]$/.test(folderName)) {
    throw new Error(
      "A project target contains characters that are unsafe on Windows.",
    );
  }
  return path.join(normalizedParent, folderName);
}

export function projectFolderName(name: string): string {
  let folder = name
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .slice(0, 80)
    .trim();
  if (!folder || folder === "." || folder === "..") folder = "FlowCode project";
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(folder)) {
    folder = `FlowCode ${folder}`;
  }
  return folder;
}

export async function canonicalizeProjectRoot(input: string): Promise<string> {
  const normalized = normalizeProjectRoot(input);
  const info = await lstat(normalized);
  if (info.isSymbolicLink()) {
    throw new Error("Project root cannot be a symbolic link.");
  }
  if (!info.isDirectory()) {
    throw new Error("Project root must be a directory.");
  }
  return path.resolve(await realpath(normalized));
}

/**
 * Resolve one project-relative path and reject any existing symbolic-link component.
 * Missing tail components are allowed so callers can validate a path before creating it.
 */
export async function assertProjectPathSafe(
  root: string,
  relativePath: string,
): Promise<string> {
  const canonicalRoot = await canonicalizeProjectRoot(root);
  const segments = relativeSegments(relativePath);
  let current = canonicalRoot;

  for (const segment of segments) {
    current = path.join(current, segment);
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if (isMissing(error))
        return resolveProjectPath(canonicalRoot, relativePath);
      throw error;
    }
    if (info.isSymbolicLink()) {
      throw new Error(`Project path crosses a symbolic link at "${segment}".`);
    }
  }

  const resolved = path.resolve(await realpath(current));
  if (!isPathInside(canonicalRoot, resolved)) {
    throw new Error("Project path resolves outside the project root.");
  }
  return resolved;
}
