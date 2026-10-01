import { AutomationBlueprintV2Schema, type AutomationBlueprintV2 } from "../../common/blueprint-v2";
import { BlueprintEditSchema, type BlueprintEdit, type BlueprintReviewFlags,
  EMPTY_REVIEW_FLAGS, type GenerationPreflight } from "../../common/analyzer";
import type { BrowserCapabilities } from "../../common/browser-environment";
import { canonicalJson, sealBlueprint, readBlueprintDocument } from "../evidence/blueprint-contract";

const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
export function validateCandidate(base: AutomationBlueprintV2, raw: unknown, intentConfirmed = false): AutomationBlueprintV2 {
  const next = AutomationBlueprintV2Schema.parse(raw);
  if (next.id !== base.id || next.projectKind !== base.projectKind || !same(next.source, base.source) ||
    !same(next.evidenceRefs, base.evidenceRefs) || !same(next.pages, base.pages) || !same(next.frames, base.frames))
    throw new Error("Candidate changed its bound source, context or evidence scope.");
  if (next.revision !== base.revision + 1 || !same(next.parent, { revision: base.revision, contentHash: base.contentHash }))
    throw new Error("Candidate has a stale base revision.");
  if (intentConfirmed && next.intent !== base.intent) throw new Error("Confirmed intent must be preserved.");
  for (const assertion of base.assertions.filter(a => a.confirmed)) {
    if (!same(next.assertions.find(a => a.id === assertion.id) ?? null, assertion))
      throw new Error("Confirmed assertions and their execution positions must be preserved.");
  }
  for (const a of next.assertions.filter(a => a.confirmed)) {
    if (!base.assertions.some(b => b.id === a.id && b.confirmed && same(b, a)))
      throw new Error("An Analyzer cannot confirm assertions.");
  }
  if (base.gaps.some(g => !next.gaps.some(n => same(n, g)) &&
    !(base.steps.some(s => s.id === g.ownerId) && !next.steps.some(s => s.id === g.ownerId))))
    throw new Error("Evidence gaps cannot be silently removed by analysis.");
  for (const step of next.steps) {
    const recorded = base.steps.find(s => s.id === step.id);
    if (recorded?.contextStatus === "resolved" && (recorded.pageRef !== step.pageRef || recorded.frameRef !== step.frameRef))
      throw new Error("Candidate cannot rewrite a recorded page/frame binding.");
  }
  if (!same(next.privacy, base.privacy)) throw new Error("Analyzer cannot change privacy authorization.");
  if ([...next.steps, ...next.cleanup].some(s => s.evidenceRefs.length === 0))
    throw new Error("Analysis steps require evidence grounding.");
  return sealBlueprint(next);
}

export function applyBlueprintEdit(base: AutomationBlueprintV2, raw: BlueprintEdit): AutomationBlueprintV2 {
  readBlueprintDocument(base);
  const edit = BlueprintEditSchema.parse(raw);
  const next = structuredClone(base);
  if (edit.kind === "intent") next.intent = edit.intent;
  else if (edit.kind === "confirm-assertion") {
    const a = next.assertions.find(a => a.id === edit.assertionId);
    if (!a) throw new Error("Unknown assertion.");
    a.source = "user-editor"; a.confirmed = true;
  } else if (edit.kind === "edit-assertion") {
    const index = next.assertions.findIndex(a => a.id === edit.assertionId);
    if (index < 0) throw new Error("Unknown assertion.");
    const previous = next.assertions[index]!;
    if (edit.target && !same(previous.target ?? null, edit.target) && !next.steps.some(s => s.target && same(s.target, edit.target)))
      throw new Error("Choose the existing assertion Locator or one already present in the reviewed steps.");
    next.assertions[index] = { id: previous.id, source: "user-editor", confirmed: false, contextStatus: "resolved",
      evidenceRefs: previous.evidenceRefs, matcher: edit.matcher,
      ...(previous.wait ? { wait: previous.wait } : {}),
      ...(edit.expected ? { expected: edit.expected } : {}), ...(edit.beforeStepId ? { beforeStepId: edit.beforeStepId } : {}),
      ...(edit.afterStepId ? { afterStepId: edit.afterStepId } : {}), ...(edit.pageRef ? { pageRef: edit.pageRef } : {}),
      ...(edit.frameRef ? { frameRef: edit.frameRef } : {}), ...(edit.target ? { target: edit.target } : {}) };
    next.gaps = next.gaps.filter(g => g.ownerId !== previous.id || !["context", "anchor"].includes(g.field));
  } else if (edit.kind === "merge-inputs") {
    if (new Set(edit.stepIds).size !== edit.stepIds.length) throw new Error("Duplicate merge step.");
    const indexes = edit.stepIds.map(id => next.steps.findIndex(s => s.id === id));
    if (indexes.some(i => i < 0) || indexes.some((i, n) => n > 0 && i !== indexes[n - 1]! + 1))
      throw new Error("Only consecutive repeated inputs can be merged.");
    const group = indexes.map(i => next.steps[i]!);
    const first = group[0]!;
    if (first.action !== "fill" || group.some(s => s.action !== "fill" || s.pageRef !== first.pageRef ||
      s.frameRef !== first.frameRef || !same(s.target, first.target) || s.outputs.length || s.wait || s.handling !== first.handling))
      throw new Error("Repeated inputs must have the same page, frame, target and handling.");
    // Keep the first stable ID, final input value and all evidence. Graph validation
    // rejects removed assertion/result/producer/lifecycle anchors instead of guessing.
    first.input = group.at(-1)!.input;
    first.evidenceRefs = [...new Set(group.flatMap(s => s.evidenceRefs))];
    next.steps.splice(indexes[0]! + 1, group.length - 1);
  } else {
    const i = next.steps.findIndex(s => s.id === edit.stepId);
    if (i < 0) throw new Error("Unknown step.");
    if (edit.kind === "delete") next.steps.splice(i, 1);
    if (edit.kind === "manual") { next.steps[i]!.handling = "manual"; next.steps[i]!.description = edit.description; }
    if (edit.kind === "input") {
      if (!["fill", "select", "upload"].includes(next.steps[i]!.action)) throw new Error("This step does not accept an input.");
      next.steps[i]!.input = edit.input;
    }
  }
  next.revision = base.revision + 1;
  next.gaps = next.gaps.filter(g => !base.steps.some(s => s.id === g.ownerId) || next.steps.some(s => s.id === g.ownerId));
  next.parent = { revision: base.revision, contentHash: base.contentHash };
  return sealBlueprint(next);
}

export interface PreflightContext {
  recordingGaps?: number;
  locatorStatus?: Record<string, "unique" | "non-unique" | "unknown">;
  capabilities?: BrowserCapabilities | null;
  flags?: BlueprintReviewFlags;
  existingTarget?: boolean;
}
export function generationPreflight(raw: unknown, context: PreflightContext = {}): GenerationPreflight {
  const parsed = AutomationBlueprintV2Schema.safeParse(raw);
  const todos: GenerationPreflight["todos"] = [];
  const add = (code: string, message: string, ownerId?: string, severity: "blocker" | "warning" = "blocker") =>
    todos.push({ code, message, ...(ownerId ? { ownerId } : {}), severity });
  if (!parsed.success) return { schemaValid: false, reviewable: false, generationReady: false,
    todos: [{ code: "schema", severity: "blocker", message: "Blueprint shape or graph references are invalid; repair the document before review." }] };
  const bp = parsed.data;
  try { readBlueprintDocument(bp); } catch { add("hash", "Content hash does not match this revision."); }
  const flags = context.flags ?? EMPTY_REVIEW_FLAGS;
  if (!flags.intentConfirmed) add("intent-review", "Review and confirm the intent.");
  if (!flags.privacyReviewed) add("privacy-review", "Review sensitive fields and export/model data categories.");
  if (context.existingTarget) add("target-not-indexed", "Precise existing-target/code alignment is unavailable until the 6A index is implemented.");
  if (context.recordingGaps) add("recording-gap", `${context.recordingGaps} recording gap(s) remain in immutable evidence; supply missing evidence.`);
  for (const gap of bp.gaps) add(`gap-${gap.field}`, gap.reason, gap.ownerId);
  if (!bp.steps.length) add("no-steps", "There are no evidence-backed steps to generate.");
  for (const step of [...bp.steps, ...bp.cleanup]) {
    if (step.contextStatus !== "resolved") add("page-context", "Resolve the logical page and frame context.", step.id);
    if (step.handling === "needs-review" || step.action === "custom") add("unknown-action", "Review the action and choose supported automation or an explicit manual step.", step.id);
    if (step.handling === "manual") {
      if (!flags.approvedManualStepIds.includes(step.id)) add("manual-review", "Confirm the manual handoff requirement.", step.id);
      else add("manual-checkpoint", "Generation must retain this explicit manual handoff; execution is not implemented in 5C.", step.id, "warning");
    }
    if (["click", "fill", "select", "check", "uncheck", "submit", "upload"].includes(step.action) && step.handling !== "manual") {
      if (!step.target) add("locator-missing", "Choose a recorded Locator.", step.id);
      else if (context.locatorStatus?.[step.id] !== "unique") add("locator-unverified", "The chosen Locator is missing, non-unique or has no recorded uniqueness evidence.", step.id);
    }
    if (["fill", "select", "upload"].includes(step.action) && !step.input && step.handling !== "manual") add("input-missing", "Choose a fixed value or typed parameter.", step.id);
  }
  for (const v of bp.variables) {
    const used = [...bp.steps, ...bp.cleanup].some(s => s.input?.kind === "variable" && s.input.variableRef === v.id) ||
      bp.assertions.some(a => a.expected?.kind === "variable" && a.expected.variableRef === v.id);
    if (used && v.source !== "derived" && !flags.approvedVariableIds.includes(v.id)) add("parameter-review", `Review the ${v.type} parameter ${v.name}; do not treat a recorded sample as runtime data.`, v.id);
    if (used && v.source === "fixed" && v.required && v.defaultValue === undefined) add("parameter-missing", "Required fixed parameter has no value.", v.id);
  }
  for (const a of bp.assertions) {
    if (!a.confirmed) add("assertion-unconfirmed", "Confirm or revise this proposed assertion.", a.id);
    if (a.matcher === "userInstruction") add("assertion-incomplete", "Choose an executable matcher and expected result; natural-language notes are not assertions.", a.id);
    else if (!["toBeVisible", "toContainText", "toHaveText", "toHaveURL", "toHaveCount", "toBeChecked"].includes(a.matcher))
      add("assertion-unsupported", "This matcher has no supported generation contract; choose a supported assertion or keep it pending review.", a.id);
    if (["toContainText", "toHaveText", "toHaveURL", "toHaveCount"].includes(a.matcher) && !a.expected)
      add("assertion-expected", "This matcher requires an explicit expected value or variable binding.", a.id);
    if (a.matcher !== "toHaveURL" && a.matcher !== "userInstruction") {
      if (!a.target) add("assertion-locator", "Choose a recorded assertion Locator.", a.id);
      else if (context.locatorStatus?.[a.id] !== "unique") add("assertion-locator-unverified", "The assertion Locator has no verified unique recorded target.", a.id);
    }
    if (a.expected?.kind === "literal") {
      const value = a.expected.value;
      if (a.matcher === "toHaveCount" && (typeof value !== "number" || !Number.isInteger(value) || value < 0))
        add("assertion-expected-type", "toHaveCount requires a nonnegative integer.", a.id);
      if (a.matcher === "toHaveURL" && typeof value !== "string") add("assertion-expected-type", "toHaveURL requires a URL string/pattern.", a.id);
      if (["toContainText", "toHaveText"].includes(a.matcher) && typeof value !== "string" && !(Array.isArray(value) && value.every(v => typeof v === "string")))
        add("assertion-expected-type", "Text matchers require a string or a string array.", a.id);
    } else if (a.expected?.kind === "variable") {
      const ref = a.expected.variableRef;
      const variable = bp.variables.find(v => v.id === ref);
      if (variable && ((a.matcher === "toHaveCount" && variable.type !== "number") ||
        (["toHaveText", "toContainText", "toHaveURL"].includes(a.matcher) && !["string", "secret"].includes(variable.type))))
        add("assertion-parameter-type", "Review a parameter type compatible with the selected assertion matcher.", a.id);
    }
    if (a.contextStatus !== "resolved") add("assertion-context", "Resolve the assertion's page/frame context.", a.id);
    if (!a.beforeStepId && !a.afterStepId) add("assertion-anchor", "Choose the assertion execution position.", a.id);
  }
  if (!context.capabilities) add("capability-unknown", "No verified browser capability snapshot is bound; choose and verify the intended environment.");
  else {
    const features = new Set<string>(["semantic-capture"]);
    if (bp.frames.length) features.add("iframe");
    if (bp.pages.some(p => p.kind === "popup")) features.add("browser.popup");
    for (const s of bp.steps.filter(s => s.handling !== "manual")) {
      if (["upload", "download"].includes(s.action)) features.add(s.action);
    }
    if (context.capabilities.provider === "ziniao") features.add("playwright-cdp");
    for (const f of features) if (!context.capabilities.results.some(r => r.feature === f && r.status === "supported"))
      add("capability-mismatch", `The current browser/version has no successful evidence for ${f}.`);
  }
  return { schemaValid: true, reviewable: true, generationReady: !todos.some(t => t.severity === "blocker"), todos };
}
