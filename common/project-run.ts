import { z } from "zod";

import { ProjectIdSchema, ProjectKindSchema } from "./project";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export const RunIdSchema = z.string().regex(SAFE_ID, "Invalid run id.");
const TimestampSchema = z.number().int().nonnegative().finite();

export const RunStatusSchema = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
  "canceled",
  "timed-out",
]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const ProjectRunActionSchema = z.enum([
  "test",
  "typecheck",
  "lint",
  "report",
  "workflow",
  "smoke",
]);
export type ProjectRunAction = z.infer<typeof ProjectRunActionSchema>;

export const CommandResultSchema = z
  .object({
    command: z.array(z.string()).min(1),
    status: RunStatusSchema,
    startedAt: TimestampSchema,
    completedAt: TimestampSchema.optional(),
    exitCode: z.number().int().nullable().optional(),
    logPath: z.string().optional(),
    logBytes: z.number().int().nonnegative().optional(),
    logTruncated: z.boolean().optional(),
    error: z.string().optional(),
  })
  .strict()
  .superRefine((result, context) => {
    if (
      result.completedAt !== undefined &&
      result.completedAt < result.startedAt
    ) {
      context.addIssue({
        code: "custom",
        path: ["completedAt"],
        message: "completedAt cannot be earlier than startedAt.",
      });
    }
  });
export type CommandResult = z.infer<typeof CommandResultSchema>;

export const AgentToolCallSchema = z
  .object({
    id: RunIdSchema,
    tool: z.string().trim().min(1),
    status: RunStatusSchema,
    startedAt: TimestampSchema,
    completedAt: TimestampSchema.optional(),
    inputSummary: z.string().optional(),
    outputSummary: z.string().optional(),
  })
  .strict();
export type AgentToolCall = z.infer<typeof AgentToolCallSchema>;

export const AgentRunSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: RunIdSchema,
    kind: z.enum(["analysis", "build"]),
    status: RunStatusSchema,
    projectId: ProjectIdSchema.optional(),
    recordingId: RunIdSchema.optional(),
    blueprintId: RunIdSchema.optional(),
    gitCommit: z
      .string()
      .regex(/^[a-f0-9]{40}$/)
      .optional(),
    promptVersion: z.string().trim().min(1),
    provider: z.string().trim().min(1),
    model: z.string().trim().min(1),
    startedAt: TimestampSchema,
    completedAt: TimestampSchema.optional(),
    inputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
    costUsd: z.number().nonnegative().finite().optional(),
    toolCalls: z.array(AgentToolCallSchema),
    diffPath: z.string().optional(),
    testResults: z.array(CommandResultSchema),
  })
  .strict()
  .superRefine((run, context) => {
    if (run.completedAt !== undefined && run.completedAt < run.startedAt) {
      context.addIssue({
        code: "custom",
        path: ["completedAt"],
        message: "completedAt cannot be earlier than startedAt.",
      });
    }
  });
export type AgentRun = z.infer<typeof AgentRunSchema>;

export const ProjectRunArtifactSchema = z
  .object({
    kind: z.enum(["log", "report", "screenshot", "video", "trace", "output"]),
    path: z.string().trim().min(1),
    mediaType: z.string().optional(),
    label: z.string().optional(),
  })
  .strict();
export type ProjectRunArtifact = z.infer<typeof ProjectRunArtifactSchema>;

export const ProjectRunSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: RunIdSchema,
    projectId: ProjectIdSchema,
    targetId: RunIdSchema.optional(),
    recordingId: RunIdSchema.optional(),
    blueprintId: RunIdSchema.optional(),
    gitCommit: z
      .string()
      .regex(/^[a-f0-9]{40}$/)
      .optional(),
    kind: ProjectKindSchema,
    action: ProjectRunActionSchema.optional(),
    command: z.array(z.string()).min(1).optional(),
    status: RunStatusSchema,
    startedAt: TimestampSchema,
    completedAt: TimestampSchema.optional(),
    exitCode: z.number().int().nullable().optional(),
    error: z.string().optional(),
    logBytes: z.number().int().nonnegative().optional(),
    logTruncated: z.boolean().optional(),
    browserVersion: z.string().optional(),
    artifacts: z.array(ProjectRunArtifactSchema),
  })
  .strict()
  .superRefine((run, context) => {
    if (run.completedAt !== undefined && run.completedAt < run.startedAt) {
      context.addIssue({
        code: "custom",
        path: ["completedAt"],
        message: "completedAt cannot be earlier than startedAt.",
      });
    }
  });
export type ProjectRun = z.infer<typeof ProjectRunSchema>;
