import { createHash } from "node:crypto";

import {
  BrowserGapSchema,
  BrowserLocatorSchema,
  BrowserSemanticEventSchema,
  BrowserSemanticEventTypeSchema,
  type BrowserGap,
} from "../../common/browser";
import {
  BrowserClockSampleSchema,
  EvidenceIndexSchema,
  FlowEventSchema,
  type BrowserClockSample,
  type EvidenceIndex,
  type EvidenceTimelineItem,
  type FlowEvent,
} from "../../common/evidence";
import type { BlueprintLocator } from "../../common/blueprint";
import type { SessionMetaV2 } from "../../common/session";

export interface EvidenceFrame {
  file: string;
  epochMs: number;
}

export interface FusedEvent extends FlowEvent {
  effectiveEpochMs: number;
}

export interface FusedEvidence {
  index: EvidenceIndex;
  events: FusedEvent[];
}

export interface FuseEvidenceInput {
  session: SessionMetaV2;
  desktopEvents: readonly unknown[];
  browserEvents: readonly unknown[];
  clockSamples: readonly unknown[];
  gaps: readonly unknown[];
  frames?: readonly EvidenceFrame[];
}

type ClockEstimate = {
  offsetMs: number;
  roundTripMs: number;
  sampleCount: number;
  anchor: BrowserClockSample;
};

const BROWSER_ACTIONS = new Set([
  "browser.navigate",
  "browser.click",
  "browser.fill",
  "browser.select",
  "browser.check",
  "browser.submit",
  "browser.tab-open",
  "browser.tab-close",
  "browser.popup",
  "browser.upload",
  "browser.download",
]);
const CAUSAL_ACTIONS = new Set([
  "browser.click",
  "browser.fill",
  "browser.select",
  "browser.check",
  "browser.submit",
  "browser.upload",
]);
const STRUCTURAL_DESKTOP_EVENTS = new Set([
  "session.start",
  "session.stop",
  "video.start",
  "video.stop",
  "frame.captured",
]);

function estimateClock(samples: readonly BrowserClockSample[]): ClockEstimate | null {
  if (samples.length === 0) return null;
  const ranked = samples
    .map((sample) => ({
      sample,
      roundTripMs:
        sample.desktopReceivedEpochMs - sample.desktopSentEpochMs,
      offsetMs:
        (sample.desktopSentEpochMs + sample.desktopReceivedEpochMs) / 2 -
        sample.sourceEpochMs,
    }))
    .sort(
      (left, right) =>
        left.roundTripMs - right.roundTripMs ||
        left.sample.sampleId.localeCompare(right.sample.sampleId),
    );
  const selected = ranked.slice(0, Math.min(5, ranked.length));
  const offsets = selected.map(({ offsetMs }) => offsetMs).sort((a, b) => a - b);
  const midpoint = Math.floor(offsets.length / 2);
  const offsetMs =
    offsets.length % 2 === 0
      ? (offsets[midpoint - 1] + offsets[midpoint]) / 2
      : offsets[midpoint];
  return {
    offsetMs,
    roundTripMs: ranked[0]!.roundTripMs,
    sampleCount: samples.length,
    anchor: ranked[0]!.sample,
  };
}

function correctedEpoch(event: FlowEvent, estimate: ClockEstimate | null): number {
  if (!estimate || event.source !== "browser") return event.epochMs;
  if (event.monotonicMs !== undefined) {
    return (
      event.monotonicMs +
      (estimate.anchor.sourceEpochMs - estimate.anchor.sourceMonotonicMs) +
      estimate.offsetMs
    );
  }
  return event.epochMs + estimate.offsetMs;
}

function tabId(event: FlowEvent): number | null {
  const value = event.payload.tabId;
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function clipboardHash(value: string): string {
  return createHash("sha1").update(value).digest("hex").slice(0, 16);
}

function bestLocator(event: FlowEvent): BlueprintLocator | undefined {
  const raw = Array.isArray(event.payload.locators)
    ? event.payload.locators[0]
    : undefined;
  const locator = raw as
    | { kind?: string; value?: string; score?: number }
    | undefined;
  if (!locator?.kind || typeof locator.value !== "string") return undefined;
  if (locator.kind === "role") {
    const separator = locator.value.indexOf("|");
    const role = separator >= 0 ? locator.value.slice(0, separator) : locator.value;
    const name = separator >= 0 ? locator.value.slice(separator + 1) : undefined;
    return { kind: "role", role, ...(name ? { name } : {}) };
  }
  if (locator.kind === "css") return { kind: "css", selector: locator.value };
  if (
    locator.kind === "label" ||
    locator.kind === "test-id" ||
    locator.kind === "id" ||
    locator.kind === "placeholder" ||
    locator.kind === "text"
  ) {
    return { kind: locator.kind, value: locator.value };
  }
  return undefined;
}

function targetName(event: FlowEvent): string | undefined {
  const target = event.payload.target;
  if (typeof target !== "object" || target === null) return undefined;
  const value = (target as Record<string, unknown>).name;
  return typeof value === "string" && value ? value : undefined;
}

function summary(event: FlowEvent): string {
  const name = targetName(event);
  const url = typeof event.payload.url === "string" ? event.payload.url : undefined;
  switch (event.type) {
    case "browser.navigate":
      return `Navigate to ${url ?? "a page"}`;
    case "browser.document":
      return `Page ready${url ? ` · ${url}` : ""}`;
    case "browser.click":
      return `Click ${name ?? "element"}`;
    case "browser.fill":
      return `Fill ${name ?? "field"}`;
    case "browser.select":
      return `Select ${name ?? "option"}`;
    case "browser.check":
      return `${event.payload.checked === false ? "Uncheck" : "Check"} ${name ?? "control"}`;
    case "browser.submit":
      return `Submit ${name ?? "form"}`;
    case "browser.upload":
      return `Upload through ${name ?? "file input"}`;
    case "browser.download":
      return "Download a file";
    case "browser.tab-open":
      return "Open a browser tab";
    case "browser.tab-close":
      return "Close a browser tab";
    case "browser.popup":
      return "Open a popup";
    case "assertion.marker":
      return typeof event.payload.note === "string"
        ? event.payload.note
        : "Assertion marker";
    case "clipboard.change":
      return "Clipboard content changed";
    case "app.activate":
      return `Activate ${typeof event.payload.app === "string" ? event.payload.app : "application"}`;
    default:
      return event.type;
  }
}

function frameRefs(
  event: FusedEvent,
  frames: readonly EvidenceFrame[],
): string[] {
  return frames
    .filter(
      (frame) =>
        typeof frame.file === "string" &&
        !frame.file.includes("..") &&
        !frame.file.includes("\\") &&
        Math.abs(frame.epochMs - event.effectiveEpochMs) <= 5_500,
    )
    .sort(
      (left, right) =>
        Math.abs(left.epochMs - event.effectiveEpochMs) -
          Math.abs(right.epochMs - event.effectiveEpochMs) ||
        left.file.localeCompare(right.file),
    )
    .slice(0, 3)
    .map((frame) => frame.file);
}

function causalLinks(events: readonly FusedEvent[]) {
  const links: Array<{
    id: string;
    kind:
      | "action-to-navigation"
      | "action-to-document"
      | "action-to-network"
      | "clipboard-to-fill";
    fromEventId: string;
    toEventId: string;
    confidence: "high" | "medium";
    deltaMs: number;
  }> = [];
  const seen = new Set<string>();
  const add = (link: Omit<(typeof links)[number], "id">) => {
    const key = `${link.kind}\0${link.fromEventId}\0${link.toEventId}`;
    if (seen.has(key)) return;
    seen.add(key);
    links.push({ id: `link-${String(links.length + 1).padStart(4, "0")}`, ...link });
  };

  for (let index = 0; index < events.length; index += 1) {
    const action = events[index];
    if (
      action.source !== "browser" || !CAUSAL_ACTIONS.has(action.type)
    ) {
      continue;
    }
    const actionTab = tabId(action);
    for (let cursor = index + 1; cursor < events.length; cursor += 1) {
      const candidate = events[cursor];
      const deltaMs = candidate.effectiveEpochMs - action.effectiveEpochMs;
      if (deltaMs > 10_000) break;
      if (
        candidate.source === "browser" &&
        CAUSAL_ACTIONS.has(candidate.type)
      ) {
        break;
      }
      if (candidate.source !== "browser" && candidate.source !== "cdp") continue;
      const candidateTab = tabId(candidate);
      if (
        actionTab !== null &&
        candidateTab !== null &&
        actionTab !== candidateTab
      ) {
        continue;
      }
      const kind =
        candidate.type === "browser.navigate"
          ? "action-to-navigation"
          : candidate.type === "browser.document"
            ? "action-to-document"
            : candidate.type === "browser.network"
              ? "action-to-network"
              : null;
      if (!kind) continue;
      add({
        kind,
        fromEventId: action.eventId,
        toEventId: candidate.eventId,
        confidence: deltaMs <= 5_000 ? "high" : "medium",
        deltaMs,
      });
    }
  }

  const clipboards = events.filter((event) => event.type === "clipboard.change");
  for (const fill of events.filter((event) => event.type === "browser.fill")) {
    const captured = fill.payload.value;
    if (typeof captured !== "object" || captured === null) continue;
    const value = captured as Record<string, unknown>;
    if (
      value.kind !== "text" ||
      typeof value.value !== "string" ||
      value.truncated === true
    ) {
      continue;
    }
    const hash = clipboardHash(value.value);
    const match = clipboards
      .filter(
        (clipboard) =>
          clipboard.effectiveEpochMs <= fill.effectiveEpochMs &&
          fill.effectiveEpochMs - clipboard.effectiveEpochMs <= 60_000 &&
          clipboard.payload.hash === hash,
      )
      .at(-1);
    if (!match) continue;
    add({
      kind: "clipboard-to-fill",
      fromEventId: match.eventId,
      toEventId: fill.eventId,
      confidence: "high",
      deltaMs: fill.effectiveEpochMs - match.effectiveEpochMs,
    });
  }
  return links;
}

export function fuseEvidence(input: FuseEvidenceInput): FusedEvidence {
  const browserEvents: FlowEvent[] = [];
  for (const raw of input.browserEvents) {
    const semantic = BrowserSemanticEventSchema.safeParse(raw);
    const generic = FlowEventSchema.safeParse(raw);
    if (
      generic.success &&
      generic.data.sessionId === input.session.id &&
      (generic.data.source === "browser" || generic.data.source === "cdp")
    ) {
      if (
        BrowserSemanticEventTypeSchema.safeParse(generic.data.type).success &&
        !semantic.success
      ) {
        continue;
      }
      browserEvents.push(generic.data);
    }
  }
  const desktopEvents: FlowEvent[] = [];
  for (const raw of input.desktopEvents) {
    const parsed = FlowEventSchema.safeParse(raw);
    if (
      parsed.success &&
      parsed.data.sessionId === input.session.id &&
      parsed.data.source !== "browser" &&
      parsed.data.source !== "cdp"
    ) {
      desktopEvents.push(parsed.data);
    }
  }
  const samples: BrowserClockSample[] = [];
  for (const raw of input.clockSamples) {
    const parsed = BrowserClockSampleSchema.safeParse(raw);
    if (parsed.success && parsed.data.sessionId === input.session.id) {
      samples.push(parsed.data);
    }
  }
  const gaps: BrowserGap[] = [];
  for (const raw of input.gaps) {
    const parsed = BrowserGapSchema.safeParse(raw);
    if (parsed.success && parsed.data.sessionId === input.session.id) {
      gaps.push(parsed.data);
    }
  }

  const sampleGroups = new Map<string, BrowserClockSample[]>();
  for (const sample of samples) {
    const group = sampleGroups.get(sample.sourceId) ?? [];
    group.push(sample);
    sampleGroups.set(sample.sourceId, group);
  }
  const clocks = new Map<string, ClockEstimate | null>();
  for (const event of browserEvents) {
    if (!clocks.has(event.sourceId)) {
      clocks.set(
        event.sourceId,
        estimateClock(sampleGroups.get(event.sourceId) ?? []),
      );
    }
  }

  const duplicatesBySource = new Map<string, number>();
  const deduplicated = new Map<string, FlowEvent>();
  for (const event of [...desktopEvents, ...browserEvents]) {
    const key = `${event.sessionId}\0${event.sourceId}\0${event.seq}`;
    if (deduplicated.has(key)) {
      duplicatesBySource.set(
        event.sourceId,
        (duplicatesBySource.get(event.sourceId) ?? 0) + 1,
      );
      continue;
    }
    deduplicated.set(key, event);
  }

  const bySource = new Map<string, FlowEvent[]>();
  for (const event of deduplicated.values()) {
    const group = bySource.get(event.sourceId) ?? [];
    group.push(event);
    bySource.set(event.sourceId, group);
  }
  const fused: FusedEvent[] = [];
  for (const [sourceId, sourceEvents] of bySource) {
    sourceEvents.sort(
      (left, right) =>
        left.seq - right.seq || left.eventId.localeCompare(right.eventId),
    );
    let previous = -1;
    for (const event of sourceEvents) {
      const corrected = correctedEpoch(event, clocks.get(sourceId) ?? null);
      const effectiveEpochMs = Math.max(corrected, previous + 0.001);
      previous = effectiveEpochMs;
      fused.push({ ...event, effectiveEpochMs });
    }
  }
  fused.sort(
    (left, right) =>
      left.effectiveEpochMs - right.effectiveEpochMs ||
      left.sourceId.localeCompare(right.sourceId) ||
      left.seq - right.seq,
  );

  const links = causalLinks(fused);
  const frames = input.frames ?? [];
  let browserOrdinal = 0;
  const timeline: EvidenceTimelineItem[] = [];
  const priorActions: EvidenceTimelineItem[] = [];
  for (const event of fused) {
    if (
      event.source !== "browser" &&
      event.source !== "cdp" &&
      STRUCTURAL_DESKTOP_EVENTS.has(event.type)
    ) {
      continue;
    }
    let relatedStepId: string | undefined;
    if (event.source === "browser" || event.source === "cdp") {
      browserOrdinal += 1;
      relatedStepId = `step-${String(browserOrdinal).padStart(4, "0")}`;
    }
    const isMarker = event.type === "assertion.marker";
    const prior = isMarker ? priorActions.at(-1) : undefined;
    const locatorCandidates = Array.isArray(event.payload.locators)
      ? event.payload.locators
      : [];
    const candidates: EvidenceTimelineItem["locatorCandidates"] = [];
    for (const candidate of locatorCandidates) {
      const parsed = BrowserLocatorSchema.safeParse(candidate);
      if (parsed.success) candidates.push(parsed.data);
    }
    const item = {
      id: `timeline-${String(timeline.length + 1).padStart(5, "0")}`,
      kind: isMarker
        ? "assertion-marker"
        : event.source === "browser" || event.source === "cdp"
          ? BROWSER_ACTIONS.has(event.type)
            ? "browser-action"
            : "browser-context"
          : "desktop",
      eventId: event.eventId,
      type: event.type,
      sourceId: event.sourceId,
      epochMs: event.effectiveEpochMs,
      summary: summary(event),
      ...(isMarker
        ? {
            ...(prior?.relatedStepId
              ? { relatedStepId: prior.relatedStepId }
              : {}),
            ...(prior?.target ? { target: prior.target } : {}),
          }
        : relatedStepId
          ? { relatedStepId }
          : {}),
      ...(!isMarker && bestLocator(event)
        ? { target: bestLocator(event) }
        : {}),
      locatorCandidates: isMarker
        ? (prior?.locatorCandidates ?? [])
        : candidates,
      screenshotRefs: frameRefs(event, frames),
      privacyTags: event.privacyTags ?? [],
    } satisfies EvidenceTimelineItem;
    timeline.push(item);
    if (item.kind === "browser-action") priorActions.push(item);
  }

  const sources = [...bySource.entries()]
    .map(([sourceId, sourceEvents]) => {
      const clock = clocks.get(sourceId) ?? null;
      return {
        sourceId,
        source: sourceEvents[0].source,
        eventCount: sourceEvents.length,
        firstSequence: Math.min(...sourceEvents.map((event) => event.seq)),
        lastSequence: Math.max(...sourceEvents.map((event) => event.seq)),
        duplicatesRemoved: duplicatesBySource.get(sourceId) ?? 0,
        clock: clock
          ? {
              offsetMs: clock.offsetMs,
              roundTripMs: clock.roundTripMs,
              sampleCount: clock.sampleCount,
            }
          : null,
      };
    })
    .sort((left, right) => left.sourceId.localeCompare(right.sourceId));

  const index = EvidenceIndexSchema.parse({
    schemaVersion: 1,
    sessionId: input.session.id,
    generatedAt:
      input.session.stoppedAt ?? fused.at(-1)?.effectiveEpochMs ?? input.session.startedAt,
    sources,
    events: fused.map((event) => ({
      eventId: event.eventId,
      sourceId: event.sourceId,
      source: event.source,
      seq: event.seq,
      type: event.type,
      epochMs: event.epochMs,
      effectiveEpochMs: event.effectiveEpochMs,
      privacyTags: event.privacyTags ?? [],
    })),
    causalLinks: links,
    gaps,
    timeline,
    stats: {
      desktopEvents: fused.filter(
        (event) => event.source !== "browser" && event.source !== "cdp",
      ).length,
      browserEvents: fused.filter(
        (event) => event.source === "browser" || event.source === "cdp",
      ).length,
      duplicatesRemoved: [...duplicatesBySource.values()].reduce(
        (total, count) => total + count,
        0,
      ),
      causalLinks: links.length,
      gaps: gaps.length,
    },
  });
  return { index, events: fused };
}

export { bestLocator };
