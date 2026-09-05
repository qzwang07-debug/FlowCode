import { z } from "zod";
import {
  BlueprintLocatorSchema,
  BlueprintPreconditionSchema,
  BlueprintPrivacySummarySchema,
  BlueprintVariableSchema,
  JsonValueSchema,
} from "./blueprint";
import { ProjectKindSchema } from "./project";
import {
  ContractIdSchema as Id,
  ContentHashSchema,
  ContractTextSchema as Text,
  uniqueIds,
} from "./execution-primitives";

export const BlueprintBindingSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("variable"), variableRef: Id }).strict(),
  z.object({ kind: z.literal("literal"), value: JsonValueSchema }).strict(),
]);
export const BlueprintWaitSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("locator"),
      target: BlueprintLocatorSchema,
      state: z.enum(["visible", "hidden", "attached", "detached"]),
      timeoutMs: z.number().int().positive().max(600000),
    })
    .strict(),
  z
    .object({
      kind: z.literal("url"),
      urlPattern: Text,
      timeoutMs: z.number().int().positive().max(600000),
    })
    .strict(),
  z
    .object({
      kind: z.literal("result"),
      resultRef: Id,
      timeoutMs: z.number().int().positive().max(600000),
    })
    .strict(),
]);
export const BlueprintPageSchema = z
  .object({
    id: Id,
    kind: z.enum(["existing", "tab", "popup"]),
    openedByResultRef: Id.optional(),
    closedByStepId: Id.optional(),
  })
  .strict();
export const BlueprintFrameSchema = z
  .object({
    id: Id,
    pageRef: Id,
    locatorChain: z.array(BlueprintLocatorSchema).min(1).max(16),
  })
  .strict();
export const BlueprintOutputSchema = z
  .object({
    id: Id,
    variableRef: Id,
    kind: z.enum(["text", "attribute", "json", "download"]),
    target: BlueprintLocatorSchema.optional(),
    attribute: Text.optional(),
  })
  .strict();
export const BlueprintStepV2Schema = z
  .object({
    id: Id,
    action: z.enum([
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
      "extract",
      "close-page",
      "manual",
      "custom",
    ]),
    description: Text,
    handling: z.enum(["automatic", "manual", "needs-review"]),
    contextStatus: z.enum(["resolved", "unresolved"]),
    pageRef: Id.optional(),
    frameRef: Id.optional(),
    target: BlueprintLocatorSchema.optional(),
    urlPattern: Text.optional(),
    input: BlueprintBindingSchema.optional(),
    wait: BlueprintWaitSchema.optional(),
    outputs: z.array(BlueprintOutputSchema).max(100),
    evidenceRefs: z.array(Id).max(500),
  })
  .strict();
export type BlueprintStepV2 = z.infer<typeof BlueprintStepV2Schema>;
export const BlueprintAssertionV2Schema = z
  .object({
    id: Id,
    source: z.enum(["user-marker", "user-editor", "code", "ai-suggestion"]),
    matcher: Text,
    expected: BlueprintBindingSchema.optional(),
    target: BlueprintLocatorSchema.optional(),
    confirmed: z.boolean(),
    contextStatus: z.enum(["resolved", "unresolved"]),
    beforeStepId: Id.optional(),
    afterStepId: Id.optional(),
    pageRef: Id.optional(),
    frameRef: Id.optional(),
    wait: BlueprintWaitSchema.optional(),
    evidenceRefs: z.array(Id).max(500),
  })
  .strict();
export const BlueprintResultSchema = z
  .object({
    id: Id,
    kind: z.enum(["popup", "tab", "navigation", "document", "download"]),
    triggerStepId: Id,
    pageRef: Id,
    evidenceRef: Id,
  })
  .strict();
export const BlueprintEvidenceV2Schema = z
  .object({
    id: Id,
    kind: z.enum([
      "event",
      "screenshot",
      "dom",
      "network",
      "narration",
      "other",
    ]),
    reference: Text,
    sessionId: Id,
    evidenceVersion: z.number().int().positive(),
  })
  .strict();
export const BlueprintGapV2Schema = z
  .object({
    id: Id,
    ownerId: Id,
    field: z.enum([
      "context",
      "anchor",
      "binding",
      "action",
      "causality",
      "evidence",
    ]),
    reason: Text,
  })
  .strict();
export const BlueprintV2Shape = z
  .object({
    schemaVersion: z.literal(2),
    id: Id,
    revision: z.number().int().positive(),
    contentHash: ContentHashSchema,
    parent: z
      .object({
        revision: z.number().int().positive(),
        contentHash: ContentHashSchema,
      })
      .strict()
      .optional(),
    source: z
      .object({
        sessionId: Id,
        sessionSchemaVersion: z.union([z.literal(1), z.literal(2)]),
        eventSchemaVersion: z.union([z.literal(0), z.literal(1)]),
        evidenceVersion: z.number().int().positive(),
        evidenceHash: ContentHashSchema,
        migratedFrom: z
          .object({
            schemaVersion: z.literal(1),
            contentHash: ContentHashSchema,
          })
          .strict()
          .optional(),
      })
      .strict(),
    projectKind: ProjectKindSchema,
    intent: Text,
    pages: z.array(BlueprintPageSchema).max(100),
    frames: z.array(BlueprintFrameSchema).max(500),
    preconditions: z.array(BlueprintPreconditionSchema).max(500),
    variables: z
      .array(
        BlueprintVariableSchema.safeExtend({
          producer: z.object({ stepId: Id, outputRef: Id }).strict().optional(),
        }),
      )
      .max(500),
    steps: z.array(BlueprintStepV2Schema).max(10000),
    cleanup: z.array(BlueprintStepV2Schema).max(1000),
    assertions: z.array(BlueprintAssertionV2Schema).max(1000),
    results: z.array(BlueprintResultSchema).max(2000),
    evidenceRefs: z.array(BlueprintEvidenceV2Schema).max(20000),
    gaps: z.array(BlueprintGapV2Schema).max(20000),
    privacy: BlueprintPrivacySummarySchema,
  })
  .strict();

// JSON Schema covers shapes; these graph checks MUST also run at the host boundary.
export const AutomationBlueprintV2Schema = BlueprintV2Shape.superRefine(
  (bp, ctx) => {
    const issue = (message: string, field?: string) =>
      ctx.addIssue({
        code: "custom",
        message,
        ...(field ? { path: [field] } : {}),
      });
    for (const key of [
      "pages",
      "frames",
      "preconditions",
      "variables",
      "assertions",
      "results",
      "evidenceRefs",
      "gaps",
    ] as const)
      uniqueIds(bp[key], ctx, key);
    const ordered = [...bp.steps, ...bp.cleanup];
    uniqueIds(ordered, ctx, "steps");
    const steps = new Map(ordered.map((s, i) => [s.id, { step: s, order: i }]));
    const pages = new Map(bp.pages.map((p) => [p.id, p]));
    const frames = new Map(bp.frames.map((f) => [f.id, f]));
    const vars = new Map(bp.variables.map((v) => [v.id, v]));
    const evidence = new Map(bp.evidenceRefs.map((e) => [e.id, e]));
    const results = new Map(bp.results.map((r) => [r.id, r]));
    const owners = new Set([
      bp.id,
      ...ordered.map((s) => s.id),
      ...bp.assertions.map((a) => a.id),
      ...bp.variables.map((v) => v.id),
      ...bp.pages.map((p) => p.id),
    ]);
    const hasGap = (id: string, field: string) =>
      bp.gaps.some((g) => g.ownerId === id && g.field === field);
    for (const gap of bp.gaps)
      if (!owners.has(gap.ownerId))
        issue("Gap references an unknown owner.", "gaps");
    if (bp.parent && bp.parent.revision >= bp.revision)
      issue("Parent revision must precede this revision.", "parent");
    for (const e of bp.evidenceRefs)
      if (
        e.sessionId !== bp.source.sessionId ||
        e.evidenceVersion !== bp.source.evidenceVersion
      )
        issue("Evidence belongs to another source/version.", "evidenceRefs");
    for (const f of bp.frames)
      if (!pages.has(f.pageRef))
        issue("Frame references an unknown page.", "frames");
    const binding = (
      value: z.infer<typeof BlueprintBindingSchema> | undefined,
      order: number,
    ) => {
      if (value?.kind !== "variable") return;
      const variable = vars.get(value.variableRef);
      if (!variable) {
        issue("Unknown variable reference.");
        return;
      }
      if (variable.producer) {
        const producer = steps.get(variable.producer.stepId);
        if (!producer || producer.order >= order)
          issue("Variable used before its producer.");
      }
    };
    const context = (
      owner: {
        id: string;
        contextStatus: string;
        pageRef?: string;
        frameRef?: string;
      },
      order: number,
    ) => {
      if (owner.contextStatus === "resolved" && !owner.pageRef)
        issue("Resolved context requires a page reference.");
      if (owner.contextStatus === "unresolved" && !hasGap(owner.id, "context"))
        issue("Unresolved context requires a gap.");
      if (owner.pageRef && !pages.has(owner.pageRef))
        issue("Unknown page reference.");
      if (
        owner.frameRef &&
        (!frames.has(owner.frameRef) ||
          frames.get(owner.frameRef)?.pageRef !== owner.pageRef)
      )
        issue("Frame does not belong to this page.");
      const page = owner.pageRef ? pages.get(owner.pageRef) : undefined;
      const opening = page?.openedByResultRef
        ? results.get(page.openedByResultRef)
        : undefined;
      if (
        opening &&
        (steps.get(opening.triggerStepId)?.order ?? Infinity) >= order
      )
        issue("Page used before it is opened.");
      if (
        page?.closedByStepId &&
        (steps.get(page.closedByStepId)?.order ?? -1) < order
      )
        issue("Page used after it is closed.");
    };
    const refs = (ids: string[]) => {
      for (const id of ids)
        if (!evidence.has(id)) issue("Unknown evidence reference.");
    };
    const wait = (
      value: z.infer<typeof BlueprintWaitSchema> | undefined,
      order: number,
    ) => {
      if (value?.kind === "result") {
        const result = results.get(value.resultRef);
        if (
          !result ||
          (steps.get(result.triggerStepId)?.order ?? Infinity) > order
        )
          issue("Wait references an unknown or future result.");
      }
    };
    ordered.forEach((s, i) => {
      if (
        s.action === "close-page" &&
        s.pageRef &&
        pages.get(s.pageRef)?.closedByStepId !== s.id
      )
        issue("Close action must agree with the page lifecycle.");
      context(s, i);
      binding(s.input, i);
      refs(s.evidenceRefs);
      wait(s.wait, i);
      uniqueIds(s.outputs, ctx, "outputs");
      if (["manual", "custom"].includes(s.action) && s.handling === "automatic")
        issue("Unsupported actions cannot execute automatically.");
      if (s.contextStatus === "unresolved" && s.handling === "automatic")
        issue("Unresolved steps cannot execute automatically.");
      if (s.handling === "automatic") {
        if (
          [
            "click",
            "fill",
            "select",
            "check",
            "uncheck",
            "submit",
            "upload",
          ].includes(s.action) &&
          !s.target
        )
          issue("Automatic action requires a locator.");
        if (["fill", "select", "upload"].includes(s.action) && !s.input)
          issue("Automatic input action requires a binding.");
        if (s.action === "navigate" && !s.urlPattern)
          issue("Navigation requires a URL pattern.");
        if (s.action === "wait" && !s.wait)
          issue("Wait action requires a condition.");
        if (s.action === "extract" && !s.outputs.length)
          issue("Extraction requires output bindings.");
      }
      if (s.action === "upload" && s.input?.kind === "literal")
        issue("Upload requires a controlled file variable.");
      if (
        s.action === "upload" &&
        s.input?.kind === "variable" &&
        vars.get(s.input.variableRef)?.type !== "file"
      )
        issue("Upload variable must have file type.");
      for (const output of s.outputs) {
        const variable = vars.get(output.variableRef);
        if (
          !variable ||
          variable.source !== "derived" ||
          variable.producer?.stepId !== s.id ||
          variable.producer.outputRef !== output.id
        )
          issue("Output and variable producer must agree.");
        if (!["extract", "download"].includes(s.action))
          issue("This action cannot produce extracted output.");
        if (output.kind === "download" && variable?.type !== "file")
          issue("Download outputs require file type.");
        if (output.kind === "attribute" && !output.attribute)
          issue("Attribute extraction requires an attribute name.");
        if (output.kind !== "download" && !output.target)
          issue("Extraction requires a locator.");
      }
    });
    for (const variable of bp.variables) {
      if (
        variable.source === "derived" &&
        !variable.producer &&
        !hasGap(variable.id, "binding")
      )
        issue("Derived variable lacks its producer.");
      if (variable.source !== "derived" && variable.producer)
        issue("Only derived variables have producers.");
      if (
        variable.producer &&
        !steps
          .get(variable.producer.stepId)
          ?.step.outputs.some(
            (o) =>
              o.id === variable.producer?.outputRef &&
              o.variableRef === variable.id,
          )
      )
        issue("Unknown variable producer.");
      if (variable.defaultValue !== undefined) {
        const value = variable.defaultValue;
        if (
          ["string", "number", "boolean"].includes(variable.type) &&
          typeof value !== variable.type
        )
          issue("Variable default has the wrong type.");
        if (["file", "secret"].includes(variable.type))
          issue("File and secret defaults must be controlled references.");
      }
    }
    for (const a of bp.assertions) {
      const before = a.beforeStepId
        ? steps.get(a.beforeStepId)?.order
        : undefined;
      const after = a.afterStepId ? steps.get(a.afterStepId)?.order : undefined;
      if (
        (a.beforeStepId && before === undefined) ||
        (a.afterStepId && after === undefined)
      )
        issue("Unknown assertion anchor.");
      if (before !== undefined && after !== undefined && before <= after)
        issue("Assertion anchors are reversed.");
      if (
        !a.beforeStepId &&
        !a.afterStepId &&
        (a.contextStatus !== "unresolved" || !hasGap(a.id, "anchor"))
      )
        issue("Assertion needs an explicit anchor or unresolved gap.");
      const at =
        after !== undefined
          ? after + 0.5
          : before !== undefined
            ? before - 0.5
            : -1;
      context(a, at);
      binding(a.expected, at);
      refs(a.evidenceRefs);
      wait(a.wait, at);
      if (a.confirmed && a.source === "ai-suggestion")
        issue("AI suggestions cannot confirm themselves.");
    }
    for (const r of bp.results) {
      if (!steps.has(r.triggerStepId) || !pages.has(r.pageRef))
        issue("Result references an unknown action/page.");
      if (evidence.get(r.evidenceRef)?.kind !== "event")
        issue("Result requires event evidence.");
      if (["popup", "tab"].includes(r.kind)) {
        const page = pages.get(r.pageRef);
        if (page?.openedByResultRef !== r.id || page.kind !== r.kind)
          issue("Page opening result and lifecycle must agree.");
        if (steps.get(r.triggerStepId)?.step.pageRef === r.pageRef)
          issue("A page cannot open itself.");
      } else if (steps.get(r.triggerStepId)?.step.pageRef !== r.pageRef)
        issue("Action result belongs to a different page.");
    }
    for (const p of bp.pages) {
      if (p.kind === "existing" && p.openedByResultRef)
        issue("Existing page cannot claim an opening result.");
      if (
        p.kind !== "existing" &&
        (!p.openedByResultRef ||
          results.get(p.openedByResultRef)?.pageRef !== p.id)
      )
        issue("New page requires a matching opening result.");
      if (
        p.closedByStepId &&
        (steps.get(p.closedByStepId)?.step.action !== "close-page" ||
          steps.get(p.closedByStepId)?.step.pageRef !== p.id)
      )
        issue("Page closure requires a matching close action.");
    }
  },
);
export type AutomationBlueprintV2 = z.infer<typeof AutomationBlueprintV2Schema>;
