import {
  AutomationBlueprintSchema,
  type AutomationBlueprint,
  type BlueprintStep,
  type BlueprintVariable,
  type JsonValue,
} from "../../common/blueprint";
import {
  AutomationBlueprintV2Schema,
  type AutomationBlueprintV2,
  type BlueprintStepV2,
} from "../../common/blueprint-v2";
import { BrowserLocatorSchema } from "../../common/browser";
import {
  BlueprintReviewSchema,
  type BlueprintReview,
  type EvidenceTimelineItem,
} from "../../common/evidence";
import type { ProjectKind } from "../../common/project";
import type { SessionMetaV2 } from "../../common/session";
import type { FusedEvent, FusedEvidence } from "./fusion";
import { bestLocator } from "./fusion";
import { contractHash, sealBlueprint } from "./blueprint-contract";

interface VariableCandidate {
  eventId: string;
  variable: BlueprintVariable;
}

function safeSlug(value: string, fallback: string): string {
  const slug = value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 72);
  return slug || fallback;
}

function targetRecord(event: FusedEvent): Record<string, unknown> {
  const target = event.payload.target;
  return typeof target === "object" && target !== null
    ? (target as Record<string, unknown>)
    : {};
}

function targetName(event: FusedEvent): string {
  const target = targetRecord(event);
  for (const key of ["name", "testId", "role", "tag"] as const) {
    if (typeof target[key] === "string" && target[key]) return target[key];
  }
  return "value";
}

function isSensitiveTarget(event: FusedEvent): boolean {
  const target = targetRecord(event);
  const description = [
    target.name,
    target.testId,
    target.inputType,
    target.autocomplete,
  ]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase();
  return /password|passcode|secret|token|api.?key|credit|card|cc-|cvc|cvv|security.?code|ssn|social.?security|email|phone/.test(
    description,
  );
}

function variableType(
  event: FusedEvent,
): BlueprintVariable["type"] {
  if (event.type === "browser.upload") return "file";
  const captured = event.payload.value;
  if (
    typeof captured === "object" &&
    captured !== null &&
    (captured as Record<string, unknown>).kind === "redacted"
  ) {
    return "secret";
  }
  const inputType = targetRecord(event).inputType;
  if (inputType === "number" || inputType === "range") return "number";
  const options = event.payload.options;
  if (Array.isArray(options) && options.length > 1) return "json";
  return "string";
}

function variableDefault(
  event: FusedEvent,
  type: BlueprintVariable["type"],
  sensitive: boolean,
): JsonValue | undefined {
  if (sensitive || type === "secret" || type === "file") return undefined;
  if (event.type === "browser.fill") {
    const captured = event.payload.value;
    if (typeof captured !== "object" || captured === null) return undefined;
    const value = captured as Record<string, unknown>;
    if (value.kind !== "text" || typeof value.value !== "string") return undefined;
    if (type === "number") {
      const numeric = Number(value.value);
      return Number.isFinite(numeric) ? numeric : undefined;
    }
    return value.value;
  }
  if (event.type === "browser.select" && Array.isArray(event.payload.options)) {
    const values = event.payload.options
      .map((option) =>
        typeof option === "object" && option !== null
          ? (option as Record<string, unknown>).value
          : undefined,
      )
      .filter((value): value is string => typeof value === "string");
    return values.length > 1 ? values : values[0];
  }
  return undefined;
}

function deriveVariables(events: readonly FusedEvent[]): VariableCandidate[] {
  const seen = new Map<string, number>();
  const variables: VariableCandidate[] = [];
  for (const event of events) {
    if (
      event.type !== "browser.fill" &&
      event.type !== "browser.select" &&
      event.type !== "browser.upload"
    ) {
      continue;
    }
    const base = safeSlug(targetName(event), "value");
    const ordinal = (seen.get(base) ?? 0) + 1;
    seen.set(base, ordinal);
    const id = ordinal === 1 ? base : `${base}_${ordinal}`;
    const type = variableType(event);
    const sensitive = type === "secret" || isSensitiveTarget(event);
    const defaultValue = variableDefault(event, type, sensitive);
    variables.push({
      eventId: event.eventId,
      variable: {
        id,
        name: targetName(event),
        type,
        source: type === "secret" ? "environment" : "runtime",
        required: true,
        sensitive,
        ...(defaultValue !== undefined ? { defaultValue } : {}),
        description: `Recorded from ${event.type}.`,
      },
    });
  }
  return variables;
}

function hostIntent(evidence: FusedEvidence): string {
  const urls = evidence.events
    .map((event) => event.payload.url)
    .filter((value): value is string => typeof value === "string");
  let host = "the recorded browser flow";
  if (urls[0]) {
    try {
      host = new URL(urls[0]).host;
    } catch {
      // The browser schema already restricts URLs; generic future events may not.
    }
  }
  const count = evidence.index.timeline.filter(
    (item) => item.kind === "browser-action",
  ).length;
  return count
    ? `Replay ${count} recorded browser action${count === 1 ? "" : "s"} on ${host}.`
    : "Review the recorded desktop workflow.";
}

function markerAssertions(evidence: FusedEvidence) {
  const markers = evidence.index.timeline.filter(
    (item) => item.kind === "assertion-marker",
  );
  return markers.map((marker, index) => ({
    id: `assertion-${String(index + 1).padStart(4, "0")}`,
    markerEventId: marker.eventId,
    note: marker.summary,
    ...(marker.relatedStepId ? { stepId: marker.relatedStepId } : {}),
    ...(marker.screenshotRefs[0]
      ? { screenshotRef: marker.screenshotRefs[0] }
      : {}),
    ...(marker.target ? { target: marker.target } : {}),
    matcher: "userInstruction",
    expected: marker.summary,
    confirmed: false,
  }));
}

export function createBlueprintReview(
  session: SessionMetaV2,
  projectKind: ProjectKind,
  evidence: FusedEvidence,
): BlueprintReview {
  return BlueprintReviewSchema.parse({
    schemaVersion: 1,
    sessionId: session.id,
    revision: 1,
    updatedAt: session.stoppedAt ?? session.startedAt,
    projectKind,
    intent: hostIntent(evidence),
    variables: deriveVariables(evidence.events).map(({ variable }) => variable),
    assertions: markerAssertions(evidence),
    privacyReviewed: false,
  });
}

function actionFor(event: FusedEvent): BlueprintStep["action"] | null {
  switch (event.type) {
    case "browser.navigate":
      return "navigate";
    case "browser.click":
      return "click";
    case "browser.fill":
      return "fill";
    case "browser.select":
      return "select";
    case "browser.check":
      return event.payload.checked === false ? "uncheck" : "check";
    case "browser.submit":
      return "submit";
    case "browser.upload":
      return "upload";
    case "browser.download":
      return "download";
    case "browser.tab-open":
    case "browser.tab-close":
    case "browser.popup":
      return "custom";
    default:
      return null;
  }
}

function describeStep(event: FusedEvent): string {
  const name = targetName(event);
  switch (event.type) {
    case "browser.navigate":
      return `Navigate to ${String(event.payload.url ?? "the recorded page")}.`;
    case "browser.click":
      return `Click ${name}.`;
    case "browser.fill":
      return `Fill ${name}.`;
    case "browser.select":
      return `Select the recorded option in ${name}.`;
    case "browser.check":
      return `${event.payload.checked === false ? "Uncheck" : "Check"} ${name}.`;
    case "browser.submit":
      return `Submit ${name}.`;
    case "browser.upload":
      return `Upload a file through ${name}.`;
    case "browser.download":
      return "Download the recorded file.";
    case "browser.tab-open":
      return "Open the recorded browser tab.";
    case "browser.tab-close":
      return "Close the recorded browser tab.";
    case "browser.popup":
      return "Open the recorded popup.";
    default:
      return event.type;
  }
}

function stepIdFor(
  eventId: string,
  timeline: readonly EvidenceTimelineItem[],
  fallbackOrdinal: number,
): string {
  return (
    timeline.find((item) => item.eventId === eventId)?.relatedStepId ??
    `step-${String(fallbackOrdinal).padStart(4, "0")}`
  );
}

export function buildDeterministicBlueprint(
  session: SessionMetaV2,
  evidence: FusedEvidence,
  rawReview: BlueprintReview,
): AutomationBlueprint {
  const review = BlueprintReviewSchema.parse(rawReview);
  if (review.sessionId !== session.id) {
    throw new Error("Blueprint review belongs to another session.");
  }

  const evidenceRefs: AutomationBlueprint["evidenceRefs"] = [];
  const eventRefIds = new Map<string, string>();
  const addEventRef = (eventId: string): string => {
    const existing = eventRefIds.get(eventId);
    if (existing) return existing;
    const id = `evidence-event-${String(eventRefIds.size + 1).padStart(5, "0")}`;
    eventRefIds.set(eventId, id);
    evidenceRefs.push({ id, kind: "event", reference: eventId });
    return id;
  };
  const screenshotRefIds = new Map<string, string>();
  const addScreenshotRef = (reference: string): string => {
    const existing = screenshotRefIds.get(reference);
    if (existing) return existing;
    const id = `evidence-screenshot-${String(screenshotRefIds.size + 1).padStart(4, "0")}`;
    screenshotRefIds.set(reference, id);
    evidenceRefs.push({ id, kind: "screenshot", reference });
    return id;
  };

  const variableCandidates = deriveVariables(evidence.events);
  const variablesById = new Map(review.variables.map((variable) => [variable.id, variable]));
  const eventVariables = new Map<string, BlueprintVariable>();
  for (const candidate of variableCandidates) {
    eventVariables.set(
      candidate.eventId,
      variablesById.get(candidate.variable.id) ?? candidate.variable,
    );
  }

  const steps: BlueprintStep[] = [];
  for (const event of evidence.events) {
    const action = actionFor(event);
    if (!action) continue;
    const refs = [addEventRef(event.eventId)];
    for (const link of evidence.index.causalLinks) {
      if (link.fromEventId === event.eventId) refs.push(addEventRef(link.toEventId));
      if (
        link.kind === "clipboard-to-fill" &&
        link.toEventId === event.eventId
      ) {
        refs.push(addEventRef(link.fromEventId));
      }
    }
    const variable = eventVariables.get(event.eventId);
    steps.push({
      id: stepIdFor(event.eventId, evidence.index.timeline, steps.length + 1),
      action,
      description: describeStep(event),
      ...(event.type === "browser.navigate" && typeof event.payload.url === "string"
        ? { url: event.payload.url }
        : {}),
      ...(bestLocator(event) ? { target: bestLocator(event) } : {}),
      ...(variable ? { value: `{{${variable.id}}}` } : {}),
      evidenceRefs: [...new Set(refs)],
    });
  }

  if (steps.length === 0) {
    for (const item of evidence.index.timeline.filter(
      (entry) =>
        entry.kind === "desktop" &&
        entry.type !== "session.start" &&
        entry.type !== "session.stop",
    )) {
      steps.push({
        id: `step-${String(steps.length + 1).padStart(4, "0")}`,
        action: "custom",
        description: item.summary,
        evidenceRefs: [addEventRef(item.eventId)],
      });
    }
  }

  const assertions = review.assertions.map((assertion) => {
    const refs = [addEventRef(assertion.markerEventId)];
    if (assertion.screenshotRef) refs.push(addScreenshotRef(assertion.screenshotRef));
    return {
      id: assertion.id,
      source: "user-marker" as const,
      matcher: assertion.matcher,
      ...(assertion.target ? { target: assertion.target } : {}),
      ...(assertion.expected !== undefined ? { expected: assertion.expected } : {}),
      confirmed: assertion.confirmed,
      evidenceRefs: refs,
    };
  });

  const redactions = new Map<string, number>();
  for (const event of evidence.events.filter((item) => item.type === "browser.fill")) {
    const value = event.payload.value;
    if (typeof value !== "object" || value === null) continue;
    const record = value as Record<string, unknown>;
    if (record.kind !== "redacted" || typeof record.reason !== "string") continue;
    redactions.set(record.reason, (redactions.get(record.reason) ?? 0) + 1);
  }
  const sensitiveVariables = review.variables.filter((variable) => variable.sensitive).length;
  if (sensitiveVariables > 0) redactions.set("sensitive-variable", sensitiveVariables);

  return AutomationBlueprintSchema.parse({
    schemaVersion: 1,
    id: `blueprint-${session.id}`,
    projectKind: review.projectKind,
    intent: review.intent,
    preconditions: [],
    variables: review.variables,
    steps,
    assertions,
    cleanup: [],
    evidenceRefs,
    privacy: {
      containsSensitiveData: redactions.size > 0,
      redactions: [...redactions.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([category, count]) => ({ category, count })),
      userReviewed: review.privacyReviewed,
    },
  });
}

function eventTab(event: FusedEvent): number | null {
  return typeof event.payload.tabId === "number" &&
    Number.isInteger(event.payload.tabId)
    ? event.payload.tabId
    : null;
}

function eventFrame(event: FusedEvent): number | null {
  return typeof event.payload.frameId === "number" &&
    Number.isInteger(event.payload.frameId)
    ? event.payload.frameId
    : null;
}

function blueprintLocator(raw: unknown) {
  const locator = BrowserLocatorSchema.safeParse(raw);
  if (!locator.success) return undefined;
  if (locator.data.kind === "role") {
    const separator = locator.data.value.indexOf("|");
    return {
      kind: "role" as const,
      role:
        separator >= 0
          ? locator.data.value.slice(0, separator)
          : locator.data.value,
      ...(separator >= 0
        ? { name: locator.data.value.slice(separator + 1) }
        : {}),
    };
  }
  if (locator.data.kind === "css")
    return { kind: "css" as const, selector: locator.data.value };
  return { kind: locator.data.kind, value: locator.data.value };
}

/** Build executable-shape v2 context deterministically from semantic evidence.
 * It never guesses a missing page/frame/causal edge: unresolved owners receive
 * explicit gaps and cannot be marked automatic by the v2 host validator. */
export function buildDeterministicBlueprintV2(
  session: SessionMetaV2,
  evidence: FusedEvidence,
  rawReview: BlueprintReview,
): AutomationBlueprintV2 {
  const review = BlueprintReviewSchema.parse(rawReview);
  if (review.sessionId !== session.id)
    throw new Error("Blueprint review belongs to another session.");
  const legacy = buildDeterministicBlueprint(session, evidence, review);
  const gaps: AutomationBlueprintV2["gaps"] = [];
  const addGap = (
    ownerId: string,
    field: AutomationBlueprintV2["gaps"][number]["field"],
    reason: string,
  ) => {
    if (gaps.some((gap) => gap.ownerId === ownerId && gap.field === field)) return;
    gaps.push({ id: `gap-${gaps.length + 1}`, ownerId, field, reason });
  };
  const evidenceRefs: AutomationBlueprintV2["evidenceRefs"] = [];
  const evidenceIds = new Map<string, string>();
  const addEvidence = (eventId: string): string => {
    const existing = evidenceIds.get(eventId);
    if (existing) return existing;
    const id = `evidence-event-${String(evidenceIds.size + 1).padStart(5, "0")}`;
    evidenceIds.set(eventId, id);
    evidenceRefs.push({
      id,
      kind: "event",
      reference: eventId,
      sessionId: session.id,
      evidenceVersion: 1,
    });
    return id;
  };
  const variableCandidates = deriveVariables(evidence.events);
  const reviewedVariables = new Map(
    review.variables.map((variable) => [variable.id, variable]),
  );
  const variablesByEvent = new Map(
    variableCandidates.map((candidate) => [
      candidate.eventId,
      reviewedVariables.get(candidate.variable.id) ?? candidate.variable,
    ]),
  );

  const pageByTab = new Map<number, string>();
  const pageKind = new Map<number, "existing" | "tab" | "popup">();
  for (const event of evidence.events) {
    const tab = eventTab(event);
    if (tab === null || pageByTab.has(tab)) continue;
    pageByTab.set(tab, `page-${pageByTab.size + 1}`);
    pageKind.set(tab, "existing");
  }
  for (const event of evidence.events) {
    if (event.type !== "browser.popup" && event.type !== "browser.tab-open")
      continue;
    const tab = eventTab(event);
    if (tab === null) continue;
    if (event.type === "browser.popup") pageKind.set(tab, "popup");
    else if (pageKind.get(tab) !== "popup") pageKind.set(tab, "tab");
  }

  const frameByKey = new Map<string, string>();
  const frames: AutomationBlueprintV2["frames"] = [];
  for (const event of evidence.events) {
    const tab = eventTab(event);
    const frame = eventFrame(event);
    if (tab === null || frame === null || frame === 0) continue;
    const pageRef = pageByTab.get(tab);
    const key = `${tab}:${frame}`;
    if (!pageRef || frameByKey.has(key)) continue;
    const rawChain = Array.isArray(event.payload.frameLocatorChain)
      ? event.payload.frameLocatorChain
      : [];
    const locatorChain = rawChain.flatMap((raw) => {
      const locator = blueprintLocator(raw);
      return locator ? [locator] : [];
    });
    if (locatorChain.length === 0) continue;
    const id = `frame-${frames.length + 1}`;
    frameByKey.set(key, id);
    frames.push({ id, pageRef, locatorChain });
  }

  const actionEvents = evidence.events.filter(
    (event) =>
      actionFor(event) !== null &&
      !["browser.tab-open", "browser.popup", "browser.download"].includes(
        event.type,
      ),
  );
  const steps: BlueprintStepV2[] = [];
  const stepByEvent = new Map<string, BlueprintStepV2>();
  for (const event of actionEvents) {
    const originalAction = actionFor(event)!;
    const action =
      event.type === "browser.tab-close" ? "close-page" : originalAction;
    const tab = eventTab(event);
    const frame = eventFrame(event);
    const pageRef = tab === null ? undefined : pageByTab.get(tab);
    const frameRef =
      tab === null || frame === null || frame === 0
        ? undefined
        : frameByKey.get(`${tab}:${frame}`);
    const contextResolved = Boolean(
      pageRef && (frame === null || frame === 0 || frameRef),
    );
    const target = bestLocator(event);
    const variable = variablesByEvent.get(event.eventId);
    const canAutomate =
      contextResolved &&
      (!["click", "fill", "select", "check", "uncheck", "submit", "upload"].includes(
        action,
      ) || Boolean(target));
    const id = stepIdFor(
      event.eventId,
      evidence.index.timeline,
      steps.length + 1,
    );
    const step = AutomationBlueprintV2Schema.shape.steps.element.parse({
      id,
      action,
      description: describeStep(event),
      handling: canAutomate ? "automatic" : "needs-review",
      contextStatus: contextResolved ? "resolved" : "unresolved",
      ...(pageRef ? { pageRef } : {}),
      ...(frameRef ? { frameRef } : {}),
      ...(target ? { target } : {}),
      ...(event.type === "browser.navigate" && typeof event.payload.url === "string"
        ? { urlPattern: event.payload.url }
        : {}),
      ...(variable
        ? { input: { kind: "variable", variableRef: variable.id } }
        : {}),
      outputs: [],
      evidenceRefs: [addEvidence(event.eventId)],
    });
    if (!contextResolved)
      addGap(
        id,
        "context",
        pageRef
          ? "The iframe has no verified relocatable locator chain."
          : "The semantic event has no approved logical page.",
      );
    if (!canAutomate && contextResolved)
      addGap(id, "action", "The action needs a stable recorded locator before generation.");
    steps.push(step);
    stepByEvent.set(event.eventId, step);
  }

  const results: AutomationBlueprintV2["results"] = [];
  const openingResultByTab = new Map<number, string>();
  const popupTabs = new Set(
    evidence.events
      .filter((event) => event.type === "browser.popup")
      .map(eventTab)
      .filter((tab): tab is number => tab !== null),
  );
  const nearestPriorStep = (event: FusedEvent, tab?: number | null) =>
    [...evidence.events]
      .slice(0, evidence.events.indexOf(event))
      .reverse()
      .find((candidate) => {
        const step = stepByEvent.get(candidate.eventId);
        return step && (tab == null || eventTab(candidate) === tab);
      });
  for (const event of evidence.events) {
    if (event.type !== "browser.popup" && event.type !== "browser.tab-open")
      continue;
    const tab = eventTab(event);
    if (event.type === "browser.tab-open" && tab !== null && popupTabs.has(tab))
      continue;
    const opener =
      typeof event.payload.openerTabId === "number"
        ? event.payload.openerTabId
        : null;
    if (tab === null || openingResultByTab.has(tab)) continue;
    const pageRef = pageByTab.get(tab);
    const triggerEvent = nearestPriorStep(event, opener);
    const trigger = triggerEvent ? stepByEvent.get(triggerEvent.eventId) : undefined;
    if (!pageRef || !trigger) {
      if (pageRef) addGap(pageRef, "causality", "The opening action could not be proven.");
      pageKind.set(tab, "existing");
      continue;
    }
    const id = `result-${results.length + 1}`;
    results.push({
      id,
      kind: event.type === "browser.popup" ? "popup" : "tab",
      triggerStepId: trigger.id,
      pageRef,
      evidenceRef: addEvidence(event.eventId),
    });
    openingResultByTab.set(tab, id);
  }
  for (const link of evidence.index.causalLinks) {
    if (
      link.kind !== "action-to-navigation" &&
      link.kind !== "action-to-document"
    )
      continue;
    const trigger = stepByEvent.get(link.fromEventId);
    const resultEvent = evidence.events.find(
      (event) => event.eventId === link.toEventId,
    );
    const tab = resultEvent ? eventTab(resultEvent) : null;
    const pageRef = tab === null ? undefined : pageByTab.get(tab);
    if (!trigger || !pageRef || !resultEvent) continue;
    results.push({
      id: `result-${results.length + 1}`,
      kind: link.kind === "action-to-navigation" ? "navigation" : "document",
      triggerStepId: trigger.id,
      pageRef,
      evidenceRef: addEvidence(resultEvent.eventId),
    });
  }
  for (const event of evidence.events.filter(
    (candidate) => candidate.type === "browser.download",
  )) {
    const tab = eventTab(event);
    const triggerEvent = nearestPriorStep(event, tab);
    const trigger = triggerEvent ? stepByEvent.get(triggerEvent.eventId) : undefined;
    const pageRef =
      tab === null
        ? trigger?.pageRef
        : pageByTab.get(tab) ?? trigger?.pageRef;
    if (!trigger || !pageRef) {
      addGap(legacy.id, "causality", "A download notification lacked a proven trigger.");
      continue;
    }
    results.push({
      id: `result-${results.length + 1}`,
      kind: "download",
      triggerStepId: trigger.id,
      pageRef,
      evidenceRef: addEvidence(event.eventId),
    });
  }

  const pages: AutomationBlueprintV2["pages"] = [...pageByTab.entries()].map(
    ([tab, id]) => {
      const close = steps.find(
        (step) =>
          step.action === "close-page" && step.pageRef === pageByTab.get(tab),
      );
      const opening = openingResultByTab.get(tab);
      return {
        id,
        kind: opening ? (pageKind.get(tab) ?? "tab") : "existing",
        ...(opening ? { openedByResultRef: opening } : {}),
        ...(close ? { closedByStepId: close.id } : {}),
      };
    },
  );

  const assertions: AutomationBlueprintV2["assertions"] = review.assertions.map(
    (assertion) => {
      const anchor = assertion.stepId
        ? steps.find((step) => step.id === assertion.stepId)
        : undefined;
      const contextResolved = anchor?.contextStatus === "resolved";
      const value = {
        id: assertion.id,
        source: "user-marker" as const,
        matcher: assertion.matcher,
        ...(assertion.expected !== undefined
          ? { expected: { kind: "literal" as const, value: assertion.expected } }
          : {}),
        ...(assertion.target ? { target: assertion.target } : {}),
        confirmed: assertion.confirmed,
        contextStatus: contextResolved ? ("resolved" as const) : ("unresolved" as const),
        ...(anchor ? { afterStepId: anchor.id } : {}),
        ...(anchor?.pageRef ? { pageRef: anchor.pageRef } : {}),
        ...(anchor?.frameRef ? { frameRef: anchor.frameRef } : {}),
        evidenceRefs: [addEvidence(assertion.markerEventId)],
      };
      if (!anchor)
        addGap(assertion.id, "anchor", "The marker has no saved step association.");
      if (!contextResolved)
        addGap(assertion.id, "context", "The assertion context is unresolved.");
      return value;
    },
  );

  return sealBlueprint({
    schemaVersion: 2,
    id: legacy.id,
    revision: review.revision,
    contentHash: "0".repeat(64),
    source: {
      sessionId: session.id,
      sessionSchemaVersion: 2,
      eventSchemaVersion: 1,
      evidenceVersion: 1,
      evidenceHash: contractHash(evidence.index),
    },
    projectKind: legacy.projectKind,
    intent: legacy.intent,
    pages,
    frames,
    preconditions: legacy.preconditions,
    variables: review.variables,
    steps,
    cleanup: [],
    assertions,
    results,
    evidenceRefs,
    gaps,
    privacy: legacy.privacy,
  });
}
