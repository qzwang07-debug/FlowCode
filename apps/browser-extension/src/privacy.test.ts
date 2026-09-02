import assert from "node:assert/strict";
import test from "node:test";

import { captureFieldValue, sensitiveFieldReason } from "./privacy";

test("password, payment-card, and security-code fields never retain their value", () => {
  const cases = [
    [{ inputType: "password" }, "correct horse battery staple", "password"],
    [{ autocomplete: "cc-number" }, "4111111111111111", "credit-card"],
    [{ name: "payment_card_number" }, "5555555555554444", "credit-card"],
    [{ ariaLabel: "CVV security code" }, "123", "security-code"],
    [{ autocomplete: "one-time-code" }, "829104", "sensitive-autocomplete"],
  ] as const;

  for (const [metadata, rawValue, reason] of cases) {
    const captured = captureFieldValue(rawValue, metadata);
    assert.deepEqual(captured, {
      kind: "redacted",
      length: rawValue.length,
      reason,
    });
    assert.equal(JSON.stringify(captured).includes(rawValue), false);
  }
});

test("ordinary values are bounded and labeled when truncated", () => {
  const rawValue = "a".repeat(5000);
  const captured = captureFieldValue(rawValue, { inputType: "text" });
  assert.equal(captured.kind, "text");
  if (captured.kind !== "text") throw new Error("Expected a text value.");
  assert.equal(captured.value.length, 4096);
  assert.equal(captured.length, 5000);
  assert.equal(captured.truncated, true);
  assert.equal(sensitiveFieldReason({ name: "customer_name" }), null);
});
