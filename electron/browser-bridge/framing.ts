import { MAX_BROWSER_MESSAGE_BYTES } from "../../common/browser";

export function encodeLengthPrefixedJson(
  value: unknown,
  maxBytes = MAX_BROWSER_MESSAGE_BYTES,
): Buffer {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  if (payload.length < 1 || payload.length > maxBytes) {
    throw new Error(
      `Bridge message length ${payload.length} is outside the allowed range.`,
    );
  }
  const frame = Buffer.allocUnsafe(4 + payload.length);
  frame.writeUInt32LE(payload.length, 0);
  payload.copy(frame, 4);
  return frame;
}

export class LengthPrefixedJsonDecoder {
  private pending = Buffer.alloc(0);
  private nextLength: number | null = null;

  constructor(private readonly maxBytes = MAX_BROWSER_MESSAGE_BYTES) {
    if (!Number.isInteger(maxBytes) || maxBytes < 1) {
      throw new Error(
        "Bridge maximum message size must be a positive integer.",
      );
    }
  }

  push(chunk: Buffer | Uint8Array): unknown[] {
    if (chunk.byteLength === 0) return [];
    const incoming = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    this.pending = this.pending.length
      ? Buffer.concat([this.pending, incoming])
      : Buffer.from(incoming);
    const messages: unknown[] = [];
    while (true) {
      if (this.nextLength === null) {
        if (this.pending.length < 4) break;
        this.nextLength = this.pending.readUInt32LE(0);
        this.pending = this.pending.subarray(4);
        if (this.nextLength < 1 || this.nextLength > this.maxBytes) {
          throw new Error(
            `Bridge message length ${this.nextLength} is outside the allowed range.`,
          );
        }
      }
      if (this.pending.length < this.nextLength) break;
      const payload = this.pending.subarray(0, this.nextLength);
      this.pending = this.pending.subarray(this.nextLength);
      this.nextLength = null;
      try {
        messages.push(JSON.parse(payload.toString("utf8")) as unknown);
      } catch {
        throw new Error("Bridge message contains malformed JSON.");
      }
    }
    return messages;
  }

  finish(): void {
    if (this.nextLength !== null || this.pending.length > 0) {
      throw new Error("Bridge connection ended with an incomplete message.");
    }
  }
}
