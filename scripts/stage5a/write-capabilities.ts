import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  BrowserCapabilitiesSchema,
  BrowserCapabilityFeatureSchema,
} from "../../common/browser-environment";

const root = path.resolve("fixtures/stage5a");
const read = async (name: string) =>
  JSON.parse(
    await readFile(path.join(root, "evidence", `${name}.json`), "utf8"),
  );
const [browser, manual, artifacts] = await Promise.all([
  read("ziniao-browser"),
  read("ziniao-manual-capture"),
  read("ziniao-artifacts"),
]);
assert.equal(browser.failure, undefined);
assert.equal(browser.flush, "pass");
assert.equal(browser.gaps, 0);
assert.equal(browser.connectionOptions.noDefaults, true);
assert.equal(browser.cliApprovedDownloadDirectory, true);
assert.equal(browser.downloadPolicyRestored, true);
assert.equal(manual.manualHumanCapture, "pass");
assert.equal(artifacts.failure, undefined);
assert.equal(artifacts.wrongExpectedNameRejected, true);
const proven = new Map<string, { evidenceRefs: string[]; detail: string }>();
const add = (features: string[], evidenceRef: string, detail: string) =>
  features.forEach((f) =>
    proven.set(f, { evidenceRefs: [evidenceRef], detail }),
  );
const startup = await read("ziniao-startup");
assert.equal(startup.initialState.running, false);
assert.equal(startup.subsequentState.running, true);
assert.equal(startup.blindRetryPerformed, false);
add(
  ["store-launch"],
  "ziniao-startup",
  "Observed not-running to running transition after a timed-out launch; no blind retry. Cold kernel download was not observed.",
);
add(
  [
    "cli-query",
    "exact-store-binding",
    "account-binding",
    "endpoint-identity",
    "playwright-cdp",
    "existing-context",
  ],
  "ziniao-artifacts",
  "Real version-bound selected-store connection, authoritative name rejection and config fingerprint recheck.",
);
add(
  ["semantic-capture"],
  "ziniao-manual-capture",
  "Actual user input/click captured; manual receipt is not a whole-run Flush pass. Final Flush has its separate evidence.",
);
for (const [type, count] of Object.entries(browser.capturedEventCounts))
  if (typeof count === "number" && count > 0)
    add(
      [type],
      "ziniao-browser",
      "Trusted semantic events observed in the local fixture; production mapping is Stage 5B.",
    );
add(
  [
    "iframe",
    "shadow-dom",
    "spa",
    "flush",
    "trusted-origin",
    "upload",
    "download",
    "browser.popup",
    "browser.download",
  ],
  "ziniao-browser",
  "Real local-fixture transport probe; no claim about production UI or all sites.",
);
add(
  ["trace"],
  "ziniao-artifacts",
  "Actions-only Trace with snapshots/screenshots/sources disabled; 0 network bytes and 0 resources.",
);
const result = BrowserCapabilitiesSchema.parse({
  schemaVersion: 1,
  id: "ziniao-stage5a-validated",
  provider: "ziniao",
  checkedAt: Date.now(),
  versions: {
    cli: browser.cli,
    client: browser.client,
    kernel: browser.kernel,
    playwright: browser.playwright,
  },
  transport: "cdp-adapter",
  results: BrowserCapabilityFeatureSchema.options.map((feature) => ({
    feature,
    status: proven.has(feature)
      ? "supported"
      : feature === "extension-load"
        ? "unsupported"
        : "unknown",
    ...(proven.get(feature) ?? {
      evidenceRefs: feature === "extension-load" ? ["ziniao-browser"] : [],
      detail:
        feature === "extension-load"
          ? "Extensions.loadUnpacked is unavailable in the tested launch; Native Messaging itself remains unknown."
          : "Not verified to the full capability contract. See the 5A matrix; do not infer support.",
    }),
  })),
});
await writeFile(
  path.join(root, "ziniao-capabilities.json"),
  JSON.stringify(result, null, 2) + "\n",
);
console.log(
  "Capability matrix validated against recorded evidence; unknowns retained.",
);
