import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  flowEventToLegacyRecord,
  normalizeStoredFlowEvent,
} from "../../common/evidence";
import { migrateSessionMeta } from "../../common/session";
import {
  correlate,
  type CorrelationOptions,
  type CorrelationResult,
  type ProbeRequest,
} from "../../common/correlation";
import type { RecEvent } from "../../common/types";
import { createLogger } from "../logger";
import type { FrameExtractor } from "./extractor";

const log = createLogger("Correlate");

export { correlate };

/** Parse legacy or FlowEvent `events.jsonl` into compatibility records. */
export function readEvents(eventsPath: string): RecEvent[] {
  if (!existsSync(eventsPath)) return [];
  let sessionId = path.basename(path.dirname(eventsPath));
  let startedAt = 0;
  try {
    const meta = migrateSessionMeta(
      JSON.parse(
        readFileSync(path.join(path.dirname(eventsPath), "session.json"), "utf8"),
      ) as unknown,
    );
    sessionId = meta.id;
    startedAt = meta.startedAt;
  } catch {
    // Standalone/eval fixtures can still carry their own legacy timestamps.
  }
  const out: RecEvent[] = [];
  for (const line of readFileSync(eventsPath, "utf8").split("\n")) {
    const s = line.trim();
    if (!s) continue;
    try {
      const raw = JSON.parse(s) as unknown;
      try {
        const event = normalizeStoredFlowEvent(raw, { sessionId, startedAt });
        out.push(flowEventToLegacyRecord(event, startedAt));
      } catch {
        const legacy = raw as RecEvent;
        if (
          typeof legacy.seq === "number" &&
          typeof legacy.epoch === "number" &&
          typeof legacy.type === "string" &&
          typeof legacy.source === "string" &&
          typeof legacy.payload === "object" &&
          legacy.payload !== null
        ) {
          out.push(legacy);
        }
      }
    } catch {
      // ignore partial/corrupt trailing line
    }
  }
  return out;
}

export interface EngineOptions extends CorrelationOptions {
  /**
   * Whether to actually *execute* probe suggestions (extract more frames) as
   * part of correlation. Default **false** — the post-stop pass stays fast and
   * purely event-anchored; it only *records* probe suggestions in
   * `correlation.json`. The describer later drives the opportunistic loop on
   * demand (budget-bounded), which is where "extract more when unsure" belongs.
   */
  autoDensify?: boolean;
  /** Max auto-densify rounds when `autoDensify` is on. Default 2. */
  maxRounds?: number;
}

/**
 * Orchestrates correlation and, optionally, the adaptive-densify ("optimization")
 * loop. By default it runs correlation **once** and persists the result plus a
 * list of suggested probe windows — no extra video decoding. When `autoDensify`
 * is enabled it will also execute those suggestions via
 * `FrameExtractor.extractWindow`, re-correlating until no new frames appear or
 * the round budget is spent (convergence guaranteed by dedupe + frame budget +
 * the already-probed set). Persists to `correlation.json`.
 */
export class CorrelationEngine {
  private readonly probed = new Set<string>();

  constructor(
    private readonly extractor: FrameExtractor,
    private readonly sessionDir: string,
    private readonly opts: EngineOptions = {},
  ) {}

  async run(): Promise<CorrelationResult> {
    const events = readEvents(path.join(this.sessionDir, "events.jsonl"));
    let result = correlate(events, this.extractor.manifest, this.opts);

    if (this.opts.autoDensify) {
      const maxRounds = this.opts.maxRounds ?? 2;
      for (let round = 0; round < maxRounds; round++) {
        const fresh = result.probeRequests.filter((r) => !this.probed.has(this.key(r)));
        if (fresh.length === 0) break;

        let newFrames = 0;
        for (const req of fresh) {
          this.probed.add(this.key(req));
          const added = await this.extractor.extractWindow({
            startMs: req.startMs,
            endMs: req.endMs,
            fps: req.fps,
            maxFrames: req.maxFrames,
            reason: req.reason,
          });
          newFrames += added.length;
        }
        log.info(`densify round ${round + 1}: ${fresh.length} windows → ${newFrames} new frames`);
        if (newFrames === 0) break;

        result = correlate(events, this.extractor.manifest, this.opts);
      }
    }

    this.persist(result);
    log.info(
      `correlated ${result.stats.frameCount} frames; ` +
        `${result.stats.unexplainedCount} unexplained, ${result.stats.silentEventCount} silent events, ` +
        `${result.probeRequests.length} probe suggestions`,
    );
    return result;
  }

  private key(r: ProbeRequest): string {
    return `${Math.round(r.startMs / 500)}:${Math.round(r.endMs / 500)}`;
  }

  private persist(result: CorrelationResult): void {
    try {
      writeFileSync(
        path.join(this.sessionDir, "correlation.json"),
        JSON.stringify(result, null, 2),
      );
    } catch (err) {
      log.warn("failed to persist correlation.json:", err instanceof Error ? err.message : err);
    }
  }
}
