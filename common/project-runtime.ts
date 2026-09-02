import { z } from "zod";

import { FlowProjectSchema, ProjectIdSchema } from "./project";
import {
  ProjectRunActionSchema,
  ProjectRunSchema,
  RunIdSchema,
} from "./project-run";

const TimestampSchema = z.number().int().nonnegative().finite();
const GitShaSchema = z.string().regex(/^[a-f0-9]{40}$/);
const SafeTextSchema = z.string().trim().min(1).max(500);

function isSafeProjectRelativePath(value: string): boolean {
  if (
    !value ||
    value.includes("\0") ||
    value.includes("\\") ||
    value.startsWith("/") ||
    /^[A-Za-z]:/.test(value)
  ) {
    return false;
  }
  const segments = value.split("/");
  if (
    segments.some(
      (segment) =>
        !segment ||
        segment === "." ||
        segment === ".." ||
        segment.includes(":"),
    )
  ) {
    return false;
  }
  const normalized = value.toLowerCase();
  return !(
    normalized === ".git" ||
    normalized.startsWith(".git/") ||
    normalized === ".flowcode/runs" ||
    normalized.startsWith(".flowcode/runs/") ||
    normalized === ".flowcode/storage-state" ||
    normalized.startsWith(".flowcode/storage-state/")
  );
}

export const ProjectRelativePathSchema = z
  .string()
  .max(1_024)
  .refine(isSafeProjectRelativePath, "Invalid project-relative path.");
export type ProjectRelativePath = z.infer<typeof ProjectRelativePathSchema>;

export const ProjectRuntimeRequestSchema = z
  .object({ projectId: ProjectIdSchema })
  .strict();
export type ProjectRuntimeRequest = z.infer<typeof ProjectRuntimeRequestSchema>;

export const GitRepositoryStatusSchema = z
  .object({
    schemaVersion: z.literal(1),
    projectId: ProjectIdSchema,
    repositoryRoot: z.string().min(1),
    hasCommits: z.boolean(),
    headSha: GitShaSchema.nullable(),
    branch: z.string().min(1).nullable(),
    detached: z.boolean(),
    dirty: z.boolean(),
    changedFileCount: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((status, context) => {
    if (status.hasCommits !== (status.headSha !== null)) {
      context.addIssue({
        code: "custom",
        path: ["headSha"],
        message: "A repository with commits must have a HEAD SHA.",
      });
    }
    if (status.detached !== (status.branch === null && status.hasCommits)) {
      context.addIssue({
        code: "custom",
        path: ["detached"],
        message: "Detached status must agree with the current branch.",
      });
    }
  });
export type GitRepositoryStatus = z.infer<typeof GitRepositoryStatusSchema>;

export const WorktreeStateSchema = z.enum([
  "creating",
  "active",
  "accepting",
  "rolling-back",
  "orphaned",
  "accepted",
  "reverted",
  "cleaned",
]);
export type WorktreeState = z.infer<typeof WorktreeStateSchema>;

export const WorktreeRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: RunIdSchema,
    projectId: ProjectIdSchema,
    reason: SafeTextSchema,
    branch: z
      .string()
      .regex(/^flowcode\/run\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
    rootPath: z.string().min(1),
    repositoryRoot: z.string().min(1),
    baseHead: GitShaSchema,
    baseBranch: z.string().min(1),
    baseDirty: z.boolean(),
    state: WorktreeStateSchema,
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
    completedAt: TimestampSchema.optional(),
    lastError: z.string().optional(),
  })
  .strict()
  .superRefine((record, context) => {
    if (record.updatedAt < record.createdAt) {
      context.addIssue({
        code: "custom",
        path: ["updatedAt"],
        message: "updatedAt cannot be earlier than createdAt.",
      });
    }
    const finished =
      record.state === "accepted" ||
      record.state === "reverted" ||
      record.state === "cleaned";
    if (finished !== (record.completedAt !== undefined)) {
      context.addIssue({
        code: "custom",
        path: ["completedAt"],
        message: "Only completed worktrees have completedAt.",
      });
    }
  });
export type WorktreeRecord = z.infer<typeof WorktreeRecordSchema>;

export const WorktreeRegistrySchema = z
  .object({
    schemaVersion: z.literal(1),
    worktrees: z.array(WorktreeRecordSchema),
  })
  .strict()
  .superRefine((registry, context) => {
    const ids = new Set<string>();
    const branches = new Set<string>();
    for (const [index, item] of registry.worktrees.entries()) {
      for (const [value, seen, key] of [
        [item.id, ids, "id"],
        [item.branch, branches, "branch"],
      ] as const) {
        if (seen.has(value)) {
          context.addIssue({
            code: "custom",
            path: ["worktrees", index, key],
            message: `Duplicate worktree ${key}.`,
          });
        }
        seen.add(value);
      }
    }
  });
export type WorktreeRegistry = z.infer<typeof WorktreeRegistrySchema>;

export const WorktreeCreateRequestSchema = z
  .object({
    projectId: ProjectIdSchema,
    reason: SafeTextSchema,
  })
  .strict();
export type WorktreeCreateRequest = z.infer<typeof WorktreeCreateRequestSchema>;

export const WorktreeControlRequestSchema = z
  .object({
    projectId: ProjectIdSchema,
    worktreeId: RunIdSchema,
  })
  .strict();
export type WorktreeControlRequest = z.infer<
  typeof WorktreeControlRequestSchema
>;

export const ProjectTreeEntrySchema = z
  .object({
    path: ProjectRelativePathSchema,
    kind: z.enum(["directory", "file"]),
    size: z.number().int().nonnegative().optional(),
  })
  .strict();
export type ProjectTreeEntry = z.infer<typeof ProjectTreeEntrySchema>;

export const ProjectTreeSchema = z
  .object({
    entries: z.array(ProjectTreeEntrySchema),
    truncated: z.boolean(),
  })
  .strict();
export type ProjectTree = z.infer<typeof ProjectTreeSchema>;

export const ProjectFileReadRequestSchema = z
  .object({
    projectId: ProjectIdSchema,
    path: ProjectRelativePathSchema,
  })
  .strict();
export type ProjectFileReadRequest = z.infer<
  typeof ProjectFileReadRequestSchema
>;

export const ProjectFileContentSchema = z
  .object({
    path: ProjectRelativePathSchema,
    content: z.string(),
    size: z.number().int().nonnegative(),
    language: z.string().min(1),
    readOnly: z.literal(true),
  })
  .strict();
export type ProjectFileContent = z.infer<typeof ProjectFileContentSchema>;

export const ProjectRunStartRequestSchema = z
  .object({
    projectId: ProjectIdSchema,
    action: ProjectRunActionSchema,
  })
  .strict();
export type ProjectRunStartRequest = z.infer<
  typeof ProjectRunStartRequestSchema
>;

export const ProjectRunControlRequestSchema = z
  .object({
    projectId: ProjectIdSchema,
    runId: RunIdSchema,
  })
  .strict();
export type ProjectRunControlRequest = z.infer<
  typeof ProjectRunControlRequestSchema
>;

export const ProjectRunLogEventSchema = z
  .object({
    projectId: ProjectIdSchema,
    runId: RunIdSchema,
    sequence: z.number().int().nonnegative(),
    stream: z.enum(["stdout", "stderr", "system"]),
    text: z.string().max(65_536),
    run: ProjectRunSchema.optional(),
  })
  .strict();
export type ProjectRunLogEvent = z.infer<typeof ProjectRunLogEventSchema>;

export const ProjectRunLogSchema = z
  .object({
    content: z.string(),
    truncated: z.boolean(),
  })
  .strict();
export type ProjectRunLog = z.infer<typeof ProjectRunLogSchema>;

export const ProjectRuntimeSnapshotSchema = z
  .object({
    project: FlowProjectSchema,
    git: GitRepositoryStatusSchema,
    files: ProjectTreeSchema,
    runs: z.array(ProjectRunSchema),
    worktrees: z.array(WorktreeRecordSchema),
    actions: z.array(ProjectRunActionSchema),
  })
  .strict();
export type ProjectRuntimeSnapshot = z.infer<
  typeof ProjectRuntimeSnapshotSchema
>;
