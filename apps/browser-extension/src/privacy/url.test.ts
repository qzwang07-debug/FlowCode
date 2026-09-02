import assert from "node:assert/strict";
import test from "node:test";

import { sanitizeBrowserUrl } from "./url";

test("standard browser URLs omit credentials, query values, and fragments", () => {
  const sanitized = sanitizeBrowserUrl(
    "https://alice:secret@example.test/orders/42?token=abc&view=full#access_token=xyz",
  );
  assert.equal(
    sanitized,
    "https://example.test/orders/42?token=%5Bredacted%5D&view=%5Bredacted%5D#redacted",
  );
  assert.equal(sanitized?.includes("secret"), false);
  assert.equal(sanitized?.includes("abc"), false);
  assert.equal(sanitized?.includes("xyz"), false);
  assert.equal(sanitizeBrowserUrl("chrome://settings"), null);
  assert.equal(sanitizeBrowserUrl("not a URL"), null);
});
