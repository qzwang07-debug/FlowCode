import { expect, test } from "@playwright/test";

import { inputSchema, metadata } from "../../src/workflows/example.workflow.js";

test("the example workflow exposes metadata and valid input", () => {
  expect(metadata.id).toBe("example");
  expect(inputSchema.parse({ url: "https://example.test" }).url).toBe("https://example.test");
});
