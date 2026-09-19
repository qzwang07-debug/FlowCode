import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { capabilitySupported } from "../../common/browser-environment";
import {
  ZINIAO_VALIDATED_CLIENT_VERSIONS,
  validatedZiniaoCapabilities,
} from "./capabilities";

test("Stage 5B receipts preserve the real result without store, endpoint, or credential data", async () => {
  const files = await Promise.all(
    [
      "fixtures/stage5b/evidence/ziniao-recording.json",
      "fixtures/stage5b/evidence/ziniao-fixed-sensor.json",
      "fixtures/stage5b/evidence/ziniao-fixture-host.json",
    ].map((file) => readFile(file, "utf8")),
  );
  const combined = files.join("\n");
  for (const forbidden of [
    /"storeId"/i,
    /"accountRef"/i,
    /webSocketDebuggerUrl/i,
    /devtools\/browser/i,
    /https?:\/\//i,
    /"ip"\s*:/i,
    /"proxy"\s*:/i,
    /AppData/i,
    /[A-Z]:\\/,
  ])
    assert.doesNotMatch(combined, forbidden);
  const recording = JSON.parse(files[0]) as any;
  const fixed = JSON.parse(files[1]) as any;
  const fixture = JSON.parse(files[2]) as any;
  assert.equal(recording.exactStoreBinding, true);
  assert.ok(recording.simultaneousStoreProcesses >= 2);
  assert.equal(recording.sourceCount, 1);
  assert.equal(recording.modelUsed, false);
  assert.equal(recording.flush, "pass");
  assert.equal(recording.fullFlowGap.retained, true);
  assert.equal(recording.blueprint.schemaVersion, 2);
  assert.equal(recording.blueprint.containsStoreOrEndpoint, false);
  assert.equal(fixed.gapCount, 0);
  assert.equal(fixed.flush, "pass");
  assert.equal(fixture.submitted, true);
  assert.equal(fixture.uploadSelected, true);
  assert.equal(fixture.iframeInputs, 2);
  assert.equal(fixture.popupComplete, true);
  assert.equal(fixture.originalPagesPreserved, true);
  assert.ok(ZINIAO_VALIDATED_CLIENT_VERSIONS.includes("6.27.2.14"));
  const current = validatedZiniaoCapabilities(1, {
    client: "6.27.2.14",
  });
  assert.equal(capabilitySupported(current, "cross-store-isolation"), true);
  assert.equal(capabilitySupported(current, "browser.tab-open"), true);
  assert.equal(capabilitySupported(current, "trace"), false);
});
