import {
  BrowserSemanticEventSchema,
  type BrowserSemanticEvent,
} from "../../../../common/browser";

export const DEFAULT_BROWSER_BUFFER_EVENTS = 2000;
export const DEFAULT_BROWSER_BUFFER_BYTES = 4 * 1024 * 1024;

export interface SerializedBrowserBuffer {
  events: BrowserSemanticEvent[];
  droppedEvents: number;
}

function encodedBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

export class ReliableEventBuffer {
  private events: BrowserSemanticEvent[] = [];
  private bytes = 0;
  private dropped = 0;

  constructor(
    private readonly maxEvents = DEFAULT_BROWSER_BUFFER_EVENTS,
    private readonly maxBytes = DEFAULT_BROWSER_BUFFER_BYTES,
  ) {
    if (!Number.isInteger(maxEvents) || maxEvents < 1) {
      throw new Error("Browser buffer maxEvents must be a positive integer.");
    }
    if (!Number.isInteger(maxBytes) || maxBytes < 1) {
      throw new Error("Browser buffer maxBytes must be a positive integer.");
    }
  }

  get size(): number {
    return this.events.length;
  }

  get byteLength(): number {
    return this.bytes;
  }

  get droppedEvents(): number {
    return this.dropped;
  }

  pending(): readonly BrowserSemanticEvent[] {
    return this.events;
  }

  enqueue(input: BrowserSemanticEvent): { accepted: boolean; dropped: number } {
    const event = BrowserSemanticEventSchema.parse(input);
    if (
      this.events.some(
        (candidate) =>
          candidate.sessionId === event.sessionId &&
          candidate.sourceId === event.sourceId &&
          candidate.seq === event.seq,
      )
    ) {
      return { accepted: false, dropped: 0 };
    }
    const eventBytes = encodedBytes(event);
    if (eventBytes > this.maxBytes) {
      this.dropped += 1;
      return { accepted: false, dropped: 1 };
    }
    this.events.push(event);
    this.bytes += eventBytes;
    let dropped = 0;
    while (this.events.length > this.maxEvents || this.bytes > this.maxBytes) {
      const removed = this.events.shift();
      if (!removed) break;
      this.bytes -= encodedBytes(removed);
      this.dropped += 1;
      dropped += 1;
    }
    return { accepted: true, dropped };
  }

  acknowledge(sessionId: string, sourceId: string, sequence: number): boolean {
    const index = this.events.findIndex(
      (event) =>
        event.sessionId === sessionId &&
        event.sourceId === sourceId &&
        event.seq === sequence,
    );
    if (index < 0) return false;
    const [removed] = this.events.splice(index, 1);
    this.bytes -= encodedBytes(removed);
    return true;
  }

  clearSession(sessionId: string): number {
    const retained = this.events.filter(
      (event) => event.sessionId !== sessionId,
    );
    const removed = this.events.length - retained.length;
    this.events = retained;
    this.bytes = retained.reduce(
      (total, event) => total + encodedBytes(event),
      0,
    );
    return removed;
  }

  serialize(): SerializedBrowserBuffer {
    return { events: [...this.events], droppedEvents: this.dropped };
  }

  restore(value: unknown): void {
    if (!value || typeof value !== "object") return;
    const candidate = value as Partial<SerializedBrowserBuffer>;
    const droppedEvents = Number.isInteger(candidate.droppedEvents)
      ? Math.max(0, Number(candidate.droppedEvents))
      : 0;
    this.events = [];
    this.bytes = 0;
    this.dropped = droppedEvents;
    if (!Array.isArray(candidate.events)) return;
    for (const raw of candidate.events) {
      const parsed = BrowserSemanticEventSchema.safeParse(raw);
      if (!parsed.success) {
        this.dropped += 1;
        continue;
      }
      this.enqueue(parsed.data);
    }
  }
}
