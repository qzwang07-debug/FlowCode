import assert from "node:assert/strict";
import test from "node:test";

import { encodeLengthPrefixedJson, LengthPrefixedJsonDecoder } from "./framing";

test("native framing decodes split and coalesced UTF-8 messages", () => {
  const first = encodeLengthPrefixedJson({ text: "FlowCode 你好" });
  const second = encodeLengthPrefixedJson({ ok: true });
  const decoder = new LengthPrefixedJsonDecoder();
  assert.deepEqual(decoder.push(first.subarray(0, 3)), []);
  assert.deepEqual(decoder.push(Buffer.concat([first.subarray(3), second])), [
    { text: "FlowCode 你好" },
    { ok: true },
  ]);
  decoder.finish();
});

test("native framing rejects oversized, malformed, and incomplete input", () => {
  assert.throws(
    () => encodeLengthPrefixedJson({ value: "x".repeat(100) }, 20),
    /length/i,
  );
  const oversized = Buffer.alloc(4);
  oversized.writeUInt32LE(21, 0);
  assert.throws(
    () => new LengthPrefixedJsonDecoder(20).push(oversized),
    /outside the allowed range/i,
  );
  const invalid = Buffer.concat([Buffer.from([1, 0, 0, 0]), Buffer.from("{")]);
  assert.throws(
    () => new LengthPrefixedJsonDecoder().push(invalid),
    /malformed JSON/i,
  );
  const incomplete = new LengthPrefixedJsonDecoder();
  incomplete.push(encodeLengthPrefixedJson({ ok: true }).subarray(0, 5));
  assert.throws(() => incomplete.finish(), /incomplete/i);
});
