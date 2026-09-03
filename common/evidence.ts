import { z } from "zod";

import {
  AutomationBlueprintSchema,
  BlueprintLocatorSchema,
  BlueprintVariableSchema,
  JsonValueSchema,
} from "./blueprint";
import { BrowserGapSchema, BrowserKindSchema, BrowserLocatorSchema } from "./browser";
import { ProjectKindSchema } from "./project";
import { SessionMetaV2Schema } from "./session";

export const FLOW_EVENT_SCHEMA_VERSION = 1 as const;
export const EVIDENCE_INDEX_SCHEMA_VERSION = 1 as const;

const IdentifierSchema = z
  .string()
  .min(1)
  .max(192)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const ShortIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
const TimestampSchema = z.number().nonnegative().finite();
const SafeRelativePathSchema = z
  .string()
  .min(1)
  .max(512)
  .refine(
    (value) =>
      !value.includes("\0") &&
      !value.includes("\\") &&
      !value.startsWith("/") &&
      value.split("/").every((part) => part && part !== "." && part !== ".."),
    "Expected a safe relative POSIX path.",
  );

export const FlowEventSourceSchema = z.enum([
  "desktop",
  "browser",
  "cdp",
  "user",
  "system",
]);
export type FlowEventSource = z.infer<typeof FlowEventSourceSchema>;

export const FlowEventSchema = z
  .object({
    schemaVersion: z.literal(FLOW_EVENT_SCHEMA_VERSION),
    eventId: IdentifierSchema,
    sessionId: ShortIdSchema,
    sourceId: IdentifierSchema,
    source: FlowEventSourceSchema,
    seq: z.number().int().nonnegative(),
    epochMs: TimestampSchema,
    monotonicMs: TimestampSchema.optional(),
    type: z.string().min(1).max(128),
    payload: z.record(z.string(), z.unknown()),
    privacyTags: z.array(z.string().min(1).max(64)).max(32).optional(),
  })
  .strict();
export type FlowEvent = z.infer<typeof FlowEventSchema>;

export const AssertionMarkerRequestSchema = z
  .object({ note: z.string().trim().min(1).max(2_000) })
  .strict();
export type AssertionMarkerRequest = z.infer<
  typeof AssertionMarkerRequestSchema
>;

const LegacyEventSchema = z
  .object({
    seq: z.number().int().nonnegative(),
    t: TimestampSchema,
    epoch: TimestampSchema,
    type: z.string().min(1).max(128),
    source: z.string().min(1).max(192),
    payload: z.record(z.string(), z.unknown()),
  })
  .passthrough();

function stableLegacyId(
  sessionId: string,
  sourceId: string,
  sequence: number,
  type: string,
): string {
  const input = `${sessionId}\0${sourceId}\0${sequence}\0${type}`;
  let hash = 2_166_136_261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return `legacy-${sequence}-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function safeSourceId(source: string): string {
  const normalized = source.replace(/[^A-Za-z0-9._:-]+/g, "-").slice(0, 192);
  return /^[A-Za-z0-9]/.test(normalized) ? normalized : `source-${normalized}`;
}

function legacySource(source: string): FlowEventSource {
  if (source === "user" || source === "ui") return "user";
  if (source === "recorder" || source === "system") return "system";
  return "desktop";
}

/** Normalize current and pre-Stage-4 desktop records without mutating raw evidence. */
export function normalizeStoredFlowEvent(
  input: unknown,
  context: { sessionId: string; startedAt: number },
): FlowEvent {
  const current = FlowEventSchema.safeParse(input);
  if (current.success) {
    if (current.data.sessionId !== context.sessionId) {
      throw new Error("Event belongs to another session.");
    }
    return current.data;
  }

  const legacy = LegacyEventSchema.parse(input);
  const sourceId = safeSourceId(legacy.source);
  return FlowEventSchema.parse({
    schemaVersion: FLOW_EVENT_SCHEMA_VERSION,
    eventId: stableLegacyId(
      context.sessionId,
      sourceId,
      legacy.seq,
      legacy.type,
    ),
    sessionId: context.sessionId,
    sourceId,
    source: legacySource(legacy.source),
    seq: legacy.seq,
    epochMs: legacy.epoch,
    monotonicMs: legacy.t,
    type: legacy.type,
    payload: legacy.payload,
  });
}

/** Compatibility view consumed by the original bundle, scanner, and describer. */
export function flowEventToLegacyRecord(
  event: FlowEvent,
  startedAt: number,
): import("./types").RecEvent {
  return {
    eventId: event.eventId,
    sessionId: event.sessionId,
    sourceId: event.sourceId,
    sourceCategory: event.source,
    seq: event.seq,
    t: Math.max(0, event.epochMs - startedAt),
    epoch: event.epochMs,
    type: event.type,
    source: event.sourceId,
    payload: event.payload,
  };
}

export const BrowserClockSampleSchema = z
  .object({
    schemaVersion: z.literal(1),
    sampleId: IdentifierSchema,
    sessionId: ShortIdSchema,
    browser: BrowserKindSchema,
    sourceId: IdentifierSchema,
    nonce: IdentifierSchema,
    desktopSentEpochMs: TimestampSchema,
    desktopReceivedEpochMs: TimestampSchema,
    sourceEpochMs: TimestampSchema,
    sourceMonotonicMs: TimestampSchema,
  })
  .strict()
  .refine(
    (sample) => sample.desktopReceivedEpochMs >= sample.desktopSentEpochMs,
    {
      path: ["desktopReceivedEpochMs"],
      message: "A clock response cannot arrive before its request.",
    },
  );
export type BrowserClockSample = z.infer<typeof BrowserClockSampleSchema>;

export const EvidenceClockEstimateSchema = z
  .object({
    offsetMs: z.number().finite(),
    roundTripMs: z.number().nonnegative().finite(),
    sampleCount: z.number().int().positive(),
  })
  .strict();

export const EvidenceSourceSchema = z
  .object({
    sourceId: IdentifierSchema,
    source: FlowEventSourceSchema,
    eventCount: z.number().int().nonnegative(),
    firstSequence: z.number().int().nonnegative(),
    lastSequence: z.number().int().nonnegative(),
    duplicatesRemoved: z.number().int().nonnegative(),
    clock: EvidenceClockEstimateSchema.nullable(),
  })
  .strict();

export const EvidenceEventRecordSchema = z
  .object({
    eventId: IdentifierSchema,
    sourceId: IdentifierSchema,
    source: FlowEventSourceSchema,
    seq: z.number().int().nonnegative(),
    type: z.string().min(1).max(128),
    epochMs: TimestampSchema,
    effectiveEpochMs: TimestampSchema,
    privacyTags: z.array(z.string().min(1).max(64)).max(32),
  })
  .strict();

export const EvidenceCausalLinkSchema = z
  .object({
    id: ShortIdSchema,
    kind: z.enum([
      "action-to-navigation",
      "action-to-document",
      "action-to-network",
      "clipboard-to-fill",
    ]),
    fromEventId: IdentifierSchema,
    toEventId: IdentifierSchema,
    confidence: z.enum(["high", "medium"]),
    deltaMs: z.number().nonnegative().finite(),
  })
  .strict();
export type EvidenceCausalLink = z.infer<typeof EvidenceCausalLinkSchema>;

export const EvidenceTimelineItemSchema = z
  .object({
    id: ShortIdSchema,
    kind: z.enum([
      "desktop",
      "browser-action",
      "browser-context",
      "assertion-marker",
    ]),
    eventId: IdentifierSchema,
    type: z.string().min(1).max(128),
    sourceId: IdentifierSchema,
    epochMs: TimestampSchema,
    summary: z.string().min(1).max(1_024),
    relatedStepId: ShortIdSchema.optional(),
    target: BlueprintLocatorSchema.optional(),
    locatorCandidates: z.array(BrowserLocatorSchema).max(12),
    screenshotRefs: z.array(SafeRelativePathSchema).max(12),
    privacyTags: z.array(z.string().min(1).max(64)).max(32),
  })
  .strict();
export type EvidenceTimelineItem = z.infer<typeof EvidenceTimelineItemSchema>;

export const EvidenceIndexSchema = z
  .object({
    schemaVersion: z.literal(EVIDENCE_INDEX_SCHEMA_VERSION),
    sessionId: ShortIdSchema,
    generatedAt: TimestampSchema,
    sources: z.array(EvidenceSourceSchema),
    events: z.array(EvidenceEventRecordSchema),
    causalLinks: z.array(EvidenceCausalLinkSchema),
    gaps: z.array(BrowserGapSchema),
    timeline: z.array(EvidenceTimelineItemSchema),
    stats: z
      .object({
        desktopEvents: z.number().int().nonnegative(),
        browserEvents: z.number().int().nonnegative(),
        duplicatesRemoved: z.number().int().nonnegative(),
        causalLinks: z.number().int().nonnegative(),
        gaps: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();
export type EvidenceIndex = z.infer<typeof EvidenceIndexSchema>;

export const BlueprintReviewAssertionSchema = z
  .object({
    id: ShortIdSchema,
    markerEventId: IdentifierSchema,
    note: z.string().trim().min(1).max(2_000),
    stepId: ShortIdSchema.optional(),
    screenshotRef: SafeRelativePathSchema.optional(),
    target: BlueprintLocatorSchema.optional(),
    matcher: z.string().trim().min(1).max(120),
    expected: JsonValueSchema.optional(),
    confirmed: z.boolean(),
  })
  .strict();
export type BlueprintReviewAssertion = z.infer<
  typeof BlueprintReviewAssertionSchema
>;

export const BlueprintReviewSchema = z
  .object({
    schemaVersion: z.literal(1),
    sessionId: ShortIdSchema,
    revision: z.number().int().positive(),
    updatedAt: TimestampSchema,
    projectKind: ProjectKindSchema,
    intent: z.string().trim().min(1).max(2_000),
    variables: z.array(BlueprintVariableSchema).max(500),
    assertions: z.array(BlueprintReviewAssertionSchema).max(500),
    privacyReviewed: z.boolean(),
  })
  .strict()
  .superRefine((review, context) => {
    for (const key of ["variables", "assertions"] as const) {
      const ids = new Set<string>();
      for (const [index, item] of review[key].entries()) {
        if (ids.has(item.id)) {
          context.addIssue({
            code: "custom",
            path: [key, index, "id"],
            message: `Duplicate ${key} id "${item.id}".`,
          });
        }
        ids.add(item.id);
      }
    }
  });
export type BlueprintReview = z.infer<typeof BlueprintReviewSchema>;

export const EvidenceRecordingSummarySchema = z
  .object({
    sessionId: ShortIdSchema,
    startedAt: TimestampSchema,
    stoppedAt: TimestampSchema.nullable(),
    mode: z.enum(["analyze-only", "analyze-and-build"]),
    projectId: ShortIdSchema.optional(),
    projectName: z.string().min(1).max(120).optional(),
    projectKind: ProjectKindSchema,
    targetId: ShortIdSchema.optional(),
    desktopEventCount: z.number().int().nonnegative(),
    browserEventCount: z.number().int().nonnegative(),
    assertionCount: z.number().int().nonnegative(),
    degraded: z.boolean(),
    blueprintReady: z.boolean(),
  })
  .strict();
export type EvidenceRecordingSummary = z.infer<
  typeof EvidenceRecordingSummarySchema
>;

export const EvidenceReviewSnapshotSchema = z
  .object({
    session: SessionMetaV2Schema,
    projectName: z.string().min(1).max(120).optional(),
    index: EvidenceIndexSchema,
    review: BlueprintReviewSchema,
    blueprint: AutomationBlueprintSchema,
  })
  .strict();
export type EvidenceReviewSnapshot = z.infer<
  typeof EvidenceReviewSnapshotSchema
>;

export const EvidenceSessionRequestSchema = z
  .object({ sessionId: ShortIdSchema })
  .strict();
export type EvidenceSessionRequest = z.infer<
  typeof EvidenceSessionRequestSchema
>;

export const EvidenceReviewUpdateRequestSchema = z
  .object({
    sessionId: ShortIdSchema,
    expectedRevision: z.number().int().positive(),
    review: BlueprintReviewSchema,
  })
  .strict();
export type EvidenceReviewUpdateRequest = z.infer<
  typeof EvidenceReviewUpdateRequestSchema
>;

export const EvidenceExportRequestSchema = z
  .object({
    sessionId: ShortIdSchema,
    includeScreenshots: z.boolean(),
  })
  .strict();
export type EvidenceExportRequest = z.infer<
  typeof EvidenceExportRequestSchema
>;
