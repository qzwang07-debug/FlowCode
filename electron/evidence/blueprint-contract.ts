import { createHash } from "node:crypto";
import {
  AutomationBlueprintSchema,
  type AutomationBlueprint,
} from "../../common/blueprint";
import {
  AutomationBlueprintV2Schema,
  type AutomationBlueprintV2,
  type BlueprintStepV2,
} from "../../common/blueprint-v2";
import {
  BlueprintReviewSchema,
  type BlueprintReview,
} from "../../common/evidence";

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    if (
      encoded === undefined ||
      (typeof value === "number" && !Number.isFinite(value))
    )
      throw new Error("Expected a finite JSON value.");
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
    )
    .join(",")}}`;
}
export function contractHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
export function blueprintHash(bp: AutomationBlueprintV2): string {
  const { contentHash: _hash, ...content } = bp;
  return contractHash(content);
}
export function sealBlueprint(
  input: AutomationBlueprintV2,
): AutomationBlueprintV2 {
  const bp = AutomationBlueprintV2Schema.parse(input);
  return { ...bp, contentHash: blueprintHash(bp) };
}
export function readBlueprintDocument(
  input: unknown,
): AutomationBlueprint | AutomationBlueprintV2 {
  if (
    typeof input === "object" &&
    input !== null &&
    "schemaVersion" in input &&
    input.schemaVersion === 1
  )
    return AutomationBlueprintSchema.parse(input);
  const bp = AutomationBlueprintV2Schema.parse(input);
  if (blueprintHash(bp) !== bp.contentHash)
    throw new Error("Blueprint content hash mismatch.");
  return bp;
}

/** Pure derived migration. No original event, Blueprint or review file is changed.
 * v1 lacks reliable page/frame/lifecycle context: never infer it from text or time.
 */
export function migrateBlueprintV1(
  input: unknown,
  context: {
    sessionId: string;
    evidenceVersion: number;
    evidenceHash: string;
    review?: BlueprintReview;
    sessionSchemaVersion?: 1 | 2;
    eventSchemaVersion?: 0 | 1;
  },
): AutomationBlueprintV2 {
  const original = AutomationBlueprintSchema.parse(input);
  const review = context.review
    ? BlueprintReviewSchema.parse(context.review)
    : undefined;
  if (
    review &&
    (review.sessionId !== context.sessionId ||
      review.projectKind !== original.projectKind)
  )
    throw new Error("Review belongs to another session/project kind.");
  const gaps: AutomationBlueprintV2["gaps"] = [];
  const gap = (
    ownerId: string,
    field: AutomationBlueprintV2["gaps"][number]["field"],
    reason: string,
  ) => gaps.push({ id: `gap-${gaps.length + 1}`, ownerId, field, reason });
  const migrateStep = (
    s: AutomationBlueprint["steps"][number],
  ): BlueprintStepV2 => {
    gap(
      s.id,
      "context",
      "v1 has no reliable logical page or frame locator chain.",
    );
    if (s.action === "custom")
      gap(s.id, "action", "Preserve the original action for manual review.");
    const ref =
      typeof s.value === "string"
        ? /^\{\{([A-Za-z0-9][A-Za-z0-9._-]*)\}\}$/.exec(s.value)?.[1]
        : undefined;
    if (ref && !original.variables.some((v) => v.id === ref))
      throw new Error("Legacy input has a dangling variable reference.");
    return {
      id: s.id,
      action: s.action,
      description: s.description,
      handling: s.action === "custom" ? "manual" : "needs-review",
      contextStatus: "unresolved",
      ...(s.target ? { target: s.target } : {}),
      ...(s.url ? { urlPattern: s.url } : {}),
      ...(ref
        ? { input: { kind: "variable", variableRef: ref } as const }
        : s.value !== undefined
          ? { input: { kind: "literal", value: s.value } as const }
          : {}),
      outputs: [],
      evidenceRefs: s.evidenceRefs,
    };
  };
  const steps = original.steps.map(migrateStep),
    cleanup = original.cleanup.map(migrateStep);
  const assertions = original.assertions.map((a) => {
    const reviewed = review?.assertions.find((r) => r.id === a.id);
    if (
      reviewed &&
      !original.evidenceRefs.some(
        (e) =>
          a.evidenceRefs.includes(e.id) &&
          e.kind === "event" &&
          e.reference === reviewed.markerEventId,
      )
    )
      throw new Error(
        "Review marker does not belong to the original assertion evidence.",
      );
    gap(
      a.id,
      "context",
      "v1 assertion has no reliable logical page/frame context.",
    );
    if (!reviewed?.stepId)
      gap(
        a.id,
        "anchor",
        "No saved review step association; manual placement required.",
      );
    const { expected, ...base } = a;
    return {
      ...base,
      ...(expected !== undefined
        ? { expected: { kind: "literal" as const, value: expected } }
        : {}),
      contextStatus: "unresolved" as const,
      ...(reviewed?.stepId ? { afterStepId: reviewed.stepId } : {}),
    };
  });
  const variables = original.variables.map((v) => {
    if (v.source === "derived")
      gap(v.id, "binding", "v1 does not identify a producer step/output.");
    return v;
  });
  return sealBlueprint({
    schemaVersion: 2,
    id: original.id,
    revision: 1,
    contentHash: "0".repeat(64),
    source: {
      sessionId: context.sessionId,
      sessionSchemaVersion: context.sessionSchemaVersion ?? 1,
      eventSchemaVersion: context.eventSchemaVersion ?? 0,
      evidenceVersion: context.evidenceVersion,
      evidenceHash: context.evidenceHash,
      migratedFrom: { schemaVersion: 1, contentHash: contractHash(original) },
    },
    projectKind: original.projectKind,
    intent: original.intent,
    preconditions: original.preconditions,
    pages: [],
    frames: [],
    variables,
    steps,
    cleanup,
    assertions,
    results: [],
    gaps,
    evidenceRefs: original.evidenceRefs.map((e) => ({
      ...e,
      sessionId: context.sessionId,
      evidenceVersion: context.evidenceVersion,
    })),
    privacy: original.privacy,
  });
}
