import {
  AutomationBlueprintSchema,
  type AutomationBlueprint,
  type BlueprintStep,
  type BlueprintVariable,
  type JsonValue,
} from "../../common/blueprint";
import {
  BlueprintReviewSchema,
  type BlueprintReview,
  type EvidenceTimelineItem,
} from "../../common/evidence";
import type { ProjectKind } from "../../common/project";
import type { SessionMetaV2 } from "../../common/session";
import type { FusedEvent, FusedEvidence } from "./fusion";
import { bestLocator } from "./fusion";

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
