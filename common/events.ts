// The typed producer contract shared by desktop collectors. Stage 4 sessions
// persist the canonical FlowEvent envelope from evidence.ts; RecEvent remains an
// in-memory compatibility view for the original bundle/describer pipeline.

/** Canonical event type identifiers, grouped by domain. */
export const EventType = {
  SessionStart: "session.start",
  SessionStop: "session.stop",
  Marker: "marker",
  AssertionMarker: "assertion.marker",
  AppActivate: "app.activate",
  AppTitleChange: "app.title-change",
  ClipboardChange: "clipboard.change",
  // Retained as describer/eval vocabulary; live capture was removed (no producer
  // ships today). A safer recorded-terminal (PTY) producer is tracked in #7.
  TerminalCommand: "terminal.command",
  BrowserUrl: "browser.url",
  VideoStart: "video.start",
  VideoStop: "video.stop",
  FrameCaptured: "frame.captured",
} as const;

export type EventType = (typeof EventType)[keyof typeof EventType];

// --- Per-domain payloads (declared as `type` aliases so they are assignable to
// Record<string, unknown> when persisted). Optional fields are platform- or
// collector-specific enrichments. ---

export type SessionStartPayload = { platform: NodeJS.Platform };
export type SessionStopPayload = Record<string, never>;
export type MarkerPayload = { note: string };
export type AssertionMarkerPayload = { markerId: string; note: string };

export type WindowBounds = { x: number; y: number; width: number; height: number };

export type AppActivatePayload = {
  app: string;
  title: string;
  url?: string;
  host?: string;
  bundleId?: string;
  pid?: number;
  path?: string;
  bounds?: WindowBounds;
};

export type AppTitleChangePayload = { app: string; title: string };

export type ClipboardChangePayload = {
  formats: string[];
  length: number;
  hash: string;
  textPreview?: string;
};

export type TerminalCommandPayload = {
  command: string;
  cwd: string;
  shell?: string;
  exitCode?: number;
  durationMs?: number;
};

export type BrowserUrlPayload = { app: string; url: string; host?: string; title?: string };

export type VideoPayload = { file: string; fps?: number };

export type FrameCapturedPayload = {
  file: string;
  source: "event" | "scene";
  phash?: string;
  correlatedEventSeqs?: number[];
};

/** Maps each event type to its payload shape. */
export interface EventPayloads {
  "session.start": SessionStartPayload;
  "session.stop": SessionStopPayload;
  marker: MarkerPayload;
  "assertion.marker": AssertionMarkerPayload;
  "app.activate": AppActivatePayload;
  "app.title-change": AppTitleChangePayload;
  "clipboard.change": ClipboardChangePayload;
  "terminal.command": TerminalCommandPayload;
  "browser.url": BrowserUrlPayload;
  "video.start": VideoPayload;
  "video.stop": VideoPayload;
  "frame.captured": FrameCapturedPayload;
}

/**
 * A not-yet-persisted event as produced by a collector. The session store adds
 * FlowEvent identity, source, sequence, wall-clock, and monotonic timestamps.
 */
export type EventInput = {
  [K in EventType]: { type: K; source: string; payload: EventPayloads[K] };
}[EventType];
