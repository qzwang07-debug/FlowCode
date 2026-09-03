export type RecorderState = "idle" | "recording";

export interface SessionMeta {
  id: string;
  startedAt: number; // wall-clock epoch ms
  stoppedAt: number | null;
  platform: NodeJS.Platform;
  appVersion: string;
}

/**
 * Compatibility view used by the original bundle, correlation, sensitive scan,
 * and describer code. New `events.jsonl` lines use FlowEvent; the reader migrates
 * both generations into this shape without rewriting legacy source evidence.
 */
export interface RecEvent {
  /** Canonical Stage 4 identity when this record was normalized from a FlowEvent. */
  eventId?: string;
  sessionId?: string;
  sourceId?: string;
  sourceCategory?: "desktop" | "browser" | "cdp" | "user" | "system";
  seq: number; // monotonic per-session index (stable id for correlation)
  t: number; // ms since session start (monotonic-derived)
  epoch: number; // wall-clock epoch ms
  type: string; // e.g. "marker", "app.activate", "clipboard.change"
  source: string; // collector name
  payload: Record<string, unknown>;
}
