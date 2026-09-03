import { randomUUID } from "node:crypto";
import { writeFile, appendFile, rename, rm } from "node:fs/promises";
import path from "node:path";

import {
  BrowserCaptureSummarySchema,
  BrowserGapSchema,
  BrowserSemanticEventSchema,
  type BrowserCaptureSummary,
  type BrowserGap,
  type BrowserKind,
  type BrowserSemanticEvent,
} from "../../common/browser";
import {
  BrowserClockSampleSchema,
  type BrowserClockSample,
} from "../../common/evidence";

interface SourceCaptureState {
  browser: BrowserKind;
  sourceId: string;
  eventCount: number;
  firstSequence: number | null;
  lastSequence: number | null;
  flushed: boolean;
  droppedEvents: number;
}

async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  const temporary = `${file}.tmp.${process.pid}.${randomUUID()}`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

export class BrowserSessionStore {
  readonly eventPath: string;
  readonly gapPath: string;
  readonly clockPath: string;
  readonly summaryPath: string;
  private readonly sources = new Map<string, SourceCaptureState>();
  private queue: Promise<void> = Promise.resolve();
  private closed = false;
  private eventCount = 0;
  private gapCount = 0;

  private constructor(
    readonly sessionId: string,
    readonly startedAt: number,
    readonly sessionDir: string,
  ) {
    this.eventPath = path.join(sessionDir, "browser-events.jsonl");
    this.gapPath = path.join(sessionDir, "browser-gaps.jsonl");
    this.clockPath = path.join(sessionDir, "browser-clock.jsonl");
    this.summaryPath = path.join(sessionDir, "browser-capture.json");
  }

  static async create(
    sessionId: string,
    startedAt: number,
    sessionDir: string,
  ): Promise<BrowserSessionStore> {
    const store = new BrowserSessionStore(sessionId, startedAt, sessionDir);
    await Promise.all([
      writeFile(store.eventPath, "", { encoding: "utf8", flag: "wx" }),
      writeFile(store.gapPath, "", { encoding: "utf8", flag: "wx" }),
      writeFile(store.clockPath, "", { encoding: "utf8", flag: "wx" }),
    ]);
    return store;
  }

  source(browser: BrowserKind, sourceId: string): SourceCaptureState {
    const existing = this.sources.get(sourceId);
    if (existing) {
      if (existing.browser !== browser) {
        throw new Error("A browser source changed browser identity.");
      }
      return existing;
    }
    const created: SourceCaptureState = {
      browser,
      sourceId,
      eventCount: 0,
      firstSequence: null,
      lastSequence: null,
      flushed: false,
      droppedEvents: 0,
    };
    this.sources.set(sourceId, created);
    return created;
  }

  appendEvent(
    browser: BrowserKind,
    input: BrowserSemanticEvent,
  ): Promise<"written" | "duplicate"> {
    const event = BrowserSemanticEventSchema.parse(input);
    if (event.sessionId !== this.sessionId) {
      return Promise.reject(
        new Error("Browser event belongs to another session."),
      );
    }
    return this.enqueue(async () => {
      const source = this.source(browser, event.sourceId);
      if (source.lastSequence !== null && event.seq <= source.lastSequence) {
        return "duplicate" as const;
      }
      if (source.lastSequence !== null && event.seq > source.lastSequence + 1) {
        await this.appendGapDirect({
          schemaVersion: 1,
          gapId: `gap-${randomUUID()}`,
          sessionId: this.sessionId,
          browser,
          sourceId: event.sourceId,
          epochMs: event.epochMs,
          reason: "sequence-gap",
          fromSequence: source.lastSequence + 1,
          toSequence: event.seq - 1,
          droppedEvents: event.seq - source.lastSequence - 1,
        });
      }
      await appendFile(this.eventPath, `${JSON.stringify(event)}\n`, "utf8");
      source.firstSequence ??= event.seq;
      source.lastSequence = event.seq;
      source.eventCount += 1;
      this.eventCount += 1;
      return "written" as const;
    });
  }

  recordGap(input: BrowserGap): Promise<void> {
    const gap = BrowserGapSchema.parse(input);
    if (gap.sessionId !== this.sessionId) {
      return Promise.reject(
        new Error("Browser gap belongs to another session."),
      );
    }
    return this.enqueue(() => this.appendGapDirect(gap));
  }

  appendClockSample(input: BrowserClockSample): Promise<void> {
    const sample = BrowserClockSampleSchema.parse(input);
    if (sample.sessionId !== this.sessionId) {
      return Promise.reject(
        new Error("Browser clock sample belongs to another session."),
      );
    }
    return this.enqueue(() =>
      appendFile(this.clockPath, `${JSON.stringify(sample)}\n`, "utf8"),
    );
  }

  markFlushed(
    browser: BrowserKind,
    sourceId: string,
    droppedEvents: number,
  ): void {
    const source = this.source(browser, sourceId);
    source.flushed = true;
    source.droppedEvents = Math.max(source.droppedEvents, droppedEvents);
  }

  noteDropped(
    browser: BrowserKind,
    sourceId: string,
    droppedEvents: number,
  ): void {
    const source = this.source(browser, sourceId);
    source.droppedEvents = Math.max(source.droppedEvents, droppedEvents);
  }

  async finalize(completedAt: number): Promise<BrowserCaptureSummary> {
    if (this.closed)
      throw new Error("Browser session store is already finalized.");
    this.closed = true;
    await this.queue;
    const sources = [...this.sources.values()]
      .map((source) => ({ ...source }))
      .sort((left, right) => left.sourceId.localeCompare(right.sourceId));
    const summary = BrowserCaptureSummarySchema.parse({
      schemaVersion: 1,
      sessionId: this.sessionId,
      startedAt: this.startedAt,
      completedAt,
      eventCount: this.eventCount,
      gapCount: this.gapCount,
      degraded:
        sources.length === 0 ||
        this.gapCount > 0 ||
        sources.some((source) => !source.flushed || source.droppedEvents > 0),
      sources,
    });
    await writeJsonAtomic(this.summaryPath, summary);
    return summary;
  }

  private async appendGapDirect(gap: BrowserGap): Promise<void> {
    await appendFile(this.gapPath, `${JSON.stringify(gap)}\n`, "utf8");
    this.gapCount += 1;
    const source = this.source(gap.browser, gap.sourceId);
    source.droppedEvents = Math.max(source.droppedEvents, gap.droppedEvents);
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed)
      return Promise.reject(new Error("Browser session store is closed."));
    const result = this.queue.then(operation, operation);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
