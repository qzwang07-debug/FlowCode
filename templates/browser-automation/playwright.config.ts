import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/smoke",
  outputDir: "runs/test-results",
  reporter: [["list"], ["json", { outputFile: "runs/smoke-results.json" }]],
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
