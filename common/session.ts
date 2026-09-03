import { z } from "zod";

import { ProjectIdSchema } from "./project";

export const SESSION_SCHEMA_VERSION = 2 as const;
export const SESSION_EVENT_SCHEMA_VERSION = 1 as const;

const SafeIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
const TimestampSchema = z.number().int().nonnegative().finite();
const MonotonicTimestampSchema = z.number().nonnegative().finite();
const PlatformSchema = z.custom<NodeJS.Platform>(
  (value) => typeof value === "string" && value.length > 0 && value.length <= 32,
  "Invalid Node.js platform.",
);

export const RecordingSessionLinkSchema = z
  .object({
    projectId: ProjectIdSchema.optional(),
    targetId: SafeIdSchema.optional(),
    mode: z.enum(["analyze-only", "analyze-and-build"]),
    browserEnhancement: z.enum([
      "none",
      "semantic",
      "enhanced",
      "full-debug",
    ]),
  })
  .strict()
  .superRefine((link, context) => {
    if (link.mode === "analyze-and-build" && !link.projectId) {
      context.addIssue({
        code: "custom",
        path: ["projectId"],
        message: "Analyze-and-build recordings must be linked to a project.",
      });
    }
    if (link.targetId && !link.projectId) {
      context.addIssue({
        code: "custom",
        path: ["targetId"],
        message: "A target cannot be selected without a project.",
      });
    }
  });
export type RecordingSessionLink = z.infer<typeof RecordingSessionLinkSchema>;

const SessionBaseFields = {
  id: SafeIdSchema,
  startedAt: TimestampSchema,
  stoppedAt: TimestampSchema.nullable(),
  platform: PlatformSchema,
  appVersion: z.string().min(1).max(64),
};

export const LegacySessionMetaSchema = z.object(SessionBaseFields).passthrough();

export const SessionMetaV2Schema = z
  .object({
    schemaVersion: z.literal(SESSION_SCHEMA_VERSION),
    eventSchemaVersion: z.literal(SESSION_EVENT_SCHEMA_VERSION),
    startedAtMonotonicMs: MonotonicTimestampSchema,
    ...SessionBaseFields,
    link: RecordingSessionLinkSchema,
  })
  .strict()
  .refine(
    (meta) => meta.stoppedAt === null || meta.stoppedAt >= meta.startedAt,
    { path: ["stoppedAt"], message: "Session cannot stop before it starts." },
  );
export type SessionMetaV2 = z.infer<typeof SessionMetaV2Schema>;

export const DEFAULT_SESSION_LINK: RecordingSessionLink = {
  mode: "analyze-only",
  browserEnhancement: "semantic",
};

/**
 * Read either metadata generation without rewriting the source artifact. Legacy
 * sessions receive conservative in-memory defaults and remain byte-for-byte intact.
 */
export function migrateSessionMeta(input: unknown): SessionMetaV2 {
  const current = SessionMetaV2Schema.safeParse(input);
  if (current.success) return current.data;

  if (
    typeof input === "object" &&
    input !== null &&
    "schemaVersion" in input
  ) {
    throw current.error;
  }

  const legacy = LegacySessionMetaSchema.parse(input);
  return SessionMetaV2Schema.parse({
    schemaVersion: SESSION_SCHEMA_VERSION,
    eventSchemaVersion: SESSION_EVENT_SCHEMA_VERSION,
    startedAtMonotonicMs: legacy.startedAt,
    id: legacy.id,
    startedAt: legacy.startedAt,
    stoppedAt: legacy.stoppedAt,
    platform: legacy.platform,
    appVersion: legacy.appVersion,
    link: {
      mode: "analyze-only",
      browserEnhancement: "none",
    },
  });
}

export function createSessionMeta(
  input: Omit<
    SessionMetaV2,
    "schemaVersion" | "eventSchemaVersion" | "startedAtMonotonicMs" | "link"
  > & {
    startedAtMonotonicMs?: number;
    link?: RecordingSessionLink;
  },
): SessionMetaV2 {
  return SessionMetaV2Schema.parse({
    schemaVersion: SESSION_SCHEMA_VERSION,
    eventSchemaVersion: SESSION_EVENT_SCHEMA_VERSION,
    ...input,
    startedAtMonotonicMs:
      input.startedAtMonotonicMs ?? performance.timeOrigin + performance.now(),
    link: input.link ?? DEFAULT_SESSION_LINK,
  });
}
