import { z } from "zod";

import { ProjectKindSchema } from "./project";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const BlueprintIdSchema = z.string().regex(SAFE_ID, "Invalid Blueprint id.");

export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);

export const BlueprintPreconditionSchema = z
  .object({
    id: BlueprintIdSchema,
    kind: z.enum(["authentication", "state", "data", "environment", "other"]),
    description: z.string().trim().min(1),
    details: z.record(z.string(), JsonValueSchema).optional(),
  })
  .strict();
export type BlueprintPrecondition = z.infer<typeof BlueprintPreconditionSchema>;

export const BlueprintVariableSchema = z
  .object({
    id: BlueprintIdSchema,
    name: z.string().trim().min(1).max(120),
    type: z.enum(["string", "number", "boolean", "secret", "file", "json"]),
    source: z.enum(["runtime", "environment", "fixed", "derived"]),
    required: z.boolean(),
    sensitive: z.boolean(),
    defaultValue: JsonValueSchema.optional(),
    description: z.string().optional(),
  })
  .strict();
export type BlueprintVariable = z.infer<typeof BlueprintVariableSchema>;

export const BlueprintLocatorSchema = z
  .object({
    kind: z.enum([
      "role",
      "label",
      "test-id",
      "id",
      "placeholder",
      "text",
      "css",
    ]),
    role: z.string().optional(),
    name: z.string().optional(),
    value: z.string().optional(),
    selector: z.string().optional(),
  })
  .strict()
  .superRefine((locator, context) => {
    const usable =
      (locator.kind === "role" && Boolean(locator.role)) ||
      (locator.kind === "css" && Boolean(locator.selector)) ||
      (locator.kind !== "role" &&
        locator.kind !== "css" &&
        Boolean(locator.value));
    if (!usable) {
      context.addIssue({
        code: "custom",
        message: `Locator kind "${locator.kind}" is missing its identifying value.`,
      });
    }
  });
export type BlueprintLocator = z.infer<typeof BlueprintLocatorSchema>;

export const BlueprintStepActionSchema = z.enum([
  "navigate",
  "click",
  "fill",
  "select",
  "check",
  "uncheck",
  "submit",
  "upload",
  "download",
  "wait",
  "custom",
]);
export type BlueprintStepAction = z.infer<typeof BlueprintStepActionSchema>;

export const BlueprintStepSchema = z
  .object({
    id: BlueprintIdSchema,
    action: BlueprintStepActionSchema,
    description: z.string().trim().min(1),
    url: z.string().optional(),
    target: BlueprintLocatorSchema.optional(),
    value: JsonValueSchema.optional(),
    evidenceRefs: z.array(BlueprintIdSchema),
  })
  .strict();
export type BlueprintStep = z.infer<typeof BlueprintStepSchema>;

export const BlueprintAssertionSchema = z
  .object({
    id: BlueprintIdSchema,
    source: z.enum(["user-marker", "user-editor", "code", "ai-suggestion"]),
    matcher: z.string().trim().min(1),
    target: BlueprintLocatorSchema.optional(),
    expected: JsonValueSchema.optional(),
    confirmed: z.boolean(),
    evidenceRefs: z.array(BlueprintIdSchema),
  })
  .strict()
  .superRefine((assertion, context) => {
    if (assertion.source === "ai-suggestion" && assertion.confirmed) {
      context.addIssue({
        code: "custom",
        path: ["confirmed"],
        message:
          "An AI suggestion must be converted to a user-confirmed source before confirmation.",
      });
    }
  });
export type BlueprintAssertion = z.infer<typeof BlueprintAssertionSchema>;

export const EvidenceRefSchema = z
  .object({
    id: BlueprintIdSchema,
    kind: z.enum([
      "event",
      "screenshot",
      "dom",
      "network",
      "narration",
      "other",
    ]),
    reference: z.string().trim().min(1),
  })
  .strict();
export type EvidenceRef = z.infer<typeof EvidenceRefSchema>;

export const BlueprintPrivacySummarySchema = z
  .object({
    containsSensitiveData: z.boolean(),
    redactions: z.array(
      z
        .object({
          category: z.string().trim().min(1),
          count: z.number().int().nonnegative(),
        })
        .strict(),
    ),
    userReviewed: z.boolean(),
  })
  .strict();
export type BlueprintPrivacySummary = z.infer<
  typeof BlueprintPrivacySummarySchema
>;

function reportDuplicates(
  values: readonly { id: string }[],
  path: string,
  context: z.RefinementCtx,
): void {
  const ids = new Set<string>();
  for (const [index, value] of values.entries()) {
    if (ids.has(value.id)) {
      context.addIssue({
        code: "custom",
        path: [path, index, "id"],
        message: `Duplicate id "${value.id}".`,
      });
    }
    ids.add(value.id);
  }
}

export const AutomationBlueprintSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: BlueprintIdSchema,
    projectKind: ProjectKindSchema,
    intent: z.string().trim().min(1),
    preconditions: z.array(BlueprintPreconditionSchema),
    variables: z.array(BlueprintVariableSchema),
    steps: z.array(BlueprintStepSchema),
    assertions: z.array(BlueprintAssertionSchema),
    cleanup: z.array(BlueprintStepSchema),
    evidenceRefs: z.array(EvidenceRefSchema),
    privacy: BlueprintPrivacySummarySchema,
  })
  .strict()
  .superRefine((blueprint, context) => {
    reportDuplicates(blueprint.preconditions, "preconditions", context);
    reportDuplicates(blueprint.variables, "variables", context);
    reportDuplicates(
      [...blueprint.steps, ...blueprint.cleanup],
      "steps",
      context,
    );
    reportDuplicates(blueprint.assertions, "assertions", context);
    reportDuplicates(blueprint.evidenceRefs, "evidenceRefs", context);

    const evidenceIds = new Set(blueprint.evidenceRefs.map(({ id }) => id));
    const owners = [
      ...blueprint.steps,
      ...blueprint.cleanup,
      ...blueprint.assertions,
    ];
    for (const owner of owners) {
      for (const ref of owner.evidenceRefs) {
        if (!evidenceIds.has(ref)) {
          context.addIssue({
            code: "custom",
            message: `Unknown evidence reference "${ref}" on "${owner.id}".`,
          });
        }
      }
    }
  });
export type AutomationBlueprint = z.infer<typeof AutomationBlueprintSchema>;
