import { z } from "zod";
import { JsonValueSchema } from "./blueprint";
import { ProjectKindSchema } from "./project";
import { ProjectRelativePathSchema } from "./project-runtime";
import {
  ContractIdSchema as Id,
  ContentHashSchema as Hash,
  ContractTextSchema as Text,
  ContractTimeSchema as Time,
  ContractRevisionSchema,
  ContractSourceIdSchema,
  uniqueIds,
} from "./execution-primitives";

const CodeReferenceSchema = z
  .object({ path: ProjectRelativePathSchema, contentHash: Hash })
  .strict();
export const ProjectTargetSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: Id,
    projectId: Id,
    kind: ProjectKindSchema,
    name: Text,
    entry: CodeReferenceSchema,
    symbol: Text,
    pageObjects: z.array(CodeReferenceSchema),
    fixtures: z.array(CodeReferenceSchema),
    codeHash: Hash,
    assertions: z.array(
      z
        .object({
          id: Id,
          kind: z.enum(["assertion", "wait", "unknown"]),
          file: ProjectRelativePathSchema,
          line: z.number().int().positive(),
          summary: Text,
        })
        .strict(),
    ),
  })
  .strict()
  .superRefine((target, ctx) => {
    uniqueIds(target.assertions, ctx, "assertions");
    const paths = new Set([
      target.entry.path,
      ...target.pageObjects.map((p) => p.path),
      ...target.fixtures.map((f) => f.path),
    ]);
    for (const assertion of target.assertions)
      if (!paths.has(assertion.file))
        ctx.addIssue({
          code: "custom",
          message: "Assertion file is outside the target context.",
        });
  });
export const ProjectContextSchema = z.discriminatedUnion("status", [
  z
    .object({
      schemaVersion: z.literal(1),
      status: z.literal("unavailable"),
      projectId: Id,
      targetId: Id.optional(),
      reason: z.enum(["not-indexed", "target-missing", "stale-code"]),
      readOnly: z.literal(true),
    })
    .strict(),
  z
    .object({
      schemaVersion: z.literal(1),
      status: z.literal("available"),
      target: ProjectTargetSchema,
      readOnly: z.literal(true),
      redacted: z.literal(true),
      summary: Text,
    })
    .strict(),
]);
export const RunParameterSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("value"),
      type: z.enum(["string", "number", "boolean", "json"]),
      value: JsonValueSchema,
    })
    .strict()
    .refine(
      (p) => p.type === "json" || typeof p.value === p.type,
      "Parameter has the wrong type.",
    ),
  z
    .object({
      kind: z.literal("secret-ref"),
      ref: Id,
      revision: z.number().int().positive(),
    })
    .strict(),
  z
    .object({ kind: z.literal("file-ref"), ref: Id, contentHash: Hash })
    .strict(),
]);
export const RunParametersSchema = z.record(Id, RunParameterSchema);
export const ProjectRunRequestV2Schema = z
  .object({
    schemaVersion: z.literal(2),
    requestId: Id,
    projectId: Id,
    targetId: Id,
    worktreeId: Id.optional(),
    environmentProfileId: Id,
    blueprint: ContractRevisionSchema,
    mode: z.enum(["reviewed-run", "agent-validation"]),
    parameters: RunParametersSchema,
    confirmationId: Id,
  })
  .strict()
  .refine(
    (r) => r.mode !== "agent-validation" || Boolean(r.worktreeId),
    "Agent validation requires a worktree.",
  );
export const ConfirmationBindingSchema = z
  .object({
    schemaVersion: z.literal(1),
    blueprint: ContractRevisionSchema,
    projectId: Id,
    targetId: Id,
    environmentProfileId: Id,
    environmentHash: Hash,
    codeHash: Hash,
    planHash: Hash,
    parametersHash: Hash,
  })
  .strict();
export type ConfirmationBinding = z.infer<typeof ConfirmationBindingSchema>;
export const ConfirmationRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: Id,
    idempotencyKey: Id,
    kind: z.enum(["generate", "execute", "business-step"]),
    binding: ConfirmationBindingSchema,
    confirmedAt: Time,
    expiresAt: Time,
    stepIds: z.array(Id),
    revokedAt: Time.optional(),
  })
  .strict()
  .refine(
    (r) =>
      r.expiresAt > r.confirmedAt &&
      (r.revokedAt === undefined || r.revokedAt >= r.confirmedAt),
    "Invalid confirmation lifetime.",
  );

export const RecordingSourcePhaseSchema = z.enum([
  "preparing",
  "recording",
  "flushing",
  "recorded",
  "degraded",
  "discarded",
  "failed",
  "canceled",
]);
export const AgentPhaseSchema = z.enum([
  "analysis",
  "planning",
  "editing",
  "validating",
  "waiting-user",
  "review-ready",
  "interrupted",
  "succeeded",
  "failed",
  "canceled",
]);
export const ProjectRunPhaseSchema = z.enum([
  "preparing",
  "running",
  "paused",
  "waiting-user",
  "interrupted",
  "succeeded",
  "failed",
  "canceled",
  "timed-out",
]);
export const RunCheckpointSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: Id,
    runId: Id,
    binding: ConfirmationBindingSchema,
    leaseId: Id,
    updatedAt: Time,
    phase: ProjectRunPhaseSchema,
    steps: z.array(
      z
        .object({
          id: Id,
          state: z.enum([
            "pending",
            "running",
            "succeeded",
            "failed",
            "unknown-result",
          ]),
          effect: z.enum(["read-only", "idempotent-write", "business-submit"]),
          resultHash: Hash.optional(),
        })
        .strict(),
    ),
  })
  .strict()
  .superRefine((r, ctx) => uniqueIds(r.steps, ctx, "steps"));
export const RecordingSourceStateSchema = z
  .object({
    schemaVersion: z.literal(1),
    sessionId: Id,
    sourceId: ContractSourceIdSchema,
    environmentProfileId: Id,
    leaseId: Id.optional(),
    phase: RecordingSourcePhaseSchema,
    updatedAt: Time,
    gapRefs: z.array(Id),
  })
  .strict();
export const AgentRunStateV2Schema = z
  .object({
    schemaVersion: z.literal(2),
    id: Id,
    recordingId: Id,
    blueprint: ContractRevisionSchema,
    phase: AgentPhaseSchema,
    updatedAt: Time,
    promptVersion: Text,
    schemaContractVersion: z.literal(2),
    provider: Text,
    model: Text,
  })
  .strict();
export const ProjectRunStateV2Schema = z
  .object({
    schemaVersion: z.literal(2),
    id: Id,
    request: ProjectRunRequestV2Schema,
    phase: ProjectRunPhaseSchema,
    updatedAt: Time,
    checkpointId: Id.optional(),
    codeHash: Hash,
  })
  .strict();
// Contracts only: persistence, indexing, UI and actual execution belong to 5B/5C/6A.
