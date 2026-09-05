import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { selectedZiniaoEndpoint } from "./ziniao-endpoint";

const require = createRequire(import.meta.url);
const Zip = require("adm-zip");
const selected = await selectedZiniaoEndpoint();
const { chromium } = await import(
  pathToFileURL(
    path.resolve(".stage5a/tools/node_modules/playwright/index.mjs"),
  ).href
);
const browser = await chromium.connectOverCDP(selected.endpoint, {
  noDefaults: true,
  isLocal: true,
});
const context = browser.contexts()[0],
  original = context.pages();
const origin = new URL(
  original.find((p: any) => /^https:\/\//.test(p.url())).url(),
).origin;
const fixtureUrl = `${origin}/flowcode-artifact-${randomBytes(12).toString("hex")}`;
const out = path.resolve(".stage5a/evidence");
await mkdir(out, { recursive: true });
const page = await context.newPage();
let tracingStarted = false;
const report: Record<string, unknown> = {
  schemaVersion: 1,
  kernel: selected.kernelVersion,
  playwright: "1.62.1",
  existingContext: true,
  video: {
    status: "unknown",
    reason:
      "recordVideo is not configured on the borrowed context; no inferred video support",
  },
};
try {
  await page.route(fixtureUrl, (r: any) =>
    r.fulfill({
      contentType: "text/html",
      body: "<!doctype html><html><head><title>FlowCode artifact fixture</title></head><body><button onclick=\"document.querySelector('p').textContent='Fixture done'\">Fixture action</button><p role=\"status\"></p></body></html>",
    }),
  );
  await page.goto(fixtureUrl);
  await page.bringToFront();
  // No DOM/network snapshots, sources or browser screenshots from other tabs.
  await context.tracing.start({
    screenshots: false,
    snapshots: false,
    sources: false,
  });
  tracingStarted = true;
  await page.getByRole("button", { name: "Fixture action" }).click();
  assert.equal(await page.getByRole("status").textContent(), "Fixture done");
  await page.screenshot({
    path: path.join(out, "ziniao-artifact-fixture.png"),
  });
  const trace = path.join(out, "ziniao-actions-only.trace.zip");
  await context.tracing.stop({ path: trace });
  tracingStarted = false;
  const zip = new Zip(trace);
  const entries = zip.getEntries() as Array<{
    entryName: string;
    getData(): Buffer;
  }>;
  const networkBytes = entries
    .filter((e) => e.entryName.endsWith(".network"))
    .reduce((n, e) => n + e.getData().length, 0);
  const resources = entries.filter((e) => e.entryName.startsWith("resources/"));
  assert.equal(networkBytes, 0);
  assert.equal(resources.length, 0);
  assert.ok(
    entries.some(
      (e) =>
        e.entryName.endsWith(".trace") &&
        e.getData().toString().includes('"method":"click"'),
    ),
  );
  report.trace = {
    status: "supported",
    scope: "actions-only; snapshots/screenshots/sources disabled",
    networkBytes,
    capturedResourceCount: resources.length,
  };
  report.fixtureScreenshot = "pass";
  assert.equal(typeof selected.state.downloadFolderPath, "string");
  report.cliDownloadDirectoryReported = true;
  await assert.rejects(
    selected.service.verifyBinding({
      ...selected.binding,
      expectedName: "FlowCode deliberately mismatched fixture name",
    }),
  );
  report.wrongExpectedNameRejected = true;
  await selected.service.verifyBinding(selected.binding);
  report.accountConfigFingerprintRechecked = true;
} catch (error) {
  report.failure = String(error).replaceAll(origin, "<fixture-origin>");
  process.exitCode = 1;
} finally {
  if (tracingStarted) await context.tracing.stop().catch(() => {});
  await page.close();
  report.originalPagesPreserved = original.every((p: any) => !p.isClosed());
  await browser.close();
  await writeFile(
    path.join(out, "ziniao-artifacts.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report));
}
