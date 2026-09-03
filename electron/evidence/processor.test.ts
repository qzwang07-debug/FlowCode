import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { AutomationBlueprintSchema } from "../../common/blueprint";
import { BlueprintReviewSchema, EvidenceIndexSchema } from "../../common/evidence";
import { processEvidenceSession } from "./processor";

test("processing a legacy session creates deterministic Stage 4 artifacts", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "flowcode-evidence-process-"));
  try {
    await writeFile(
      path.join(root, "session.json"),
      JSON.stringify({
        id: "legacy-session",
        startedAt: 1_000,
        stoppedAt: 2_000,
        platform: "win32",
        appVersion: "0.5.0",
      }),
    );
    await writeFile(
      path.join(root, "events.jsonl"),
      [
        {
          seq: 0,
          t: 100,
          epoch: 1_100,
          type: "app.activate",
          source: "active-window",
          payload: { app: "Chrome", title: "Example" },
        },
        {
          seq: 1,
          t: 500,
          epoch: 1_500,
          type: "assertion.marker",
          source: "user",
          payload: { markerId: "marker-one", note: "The page is visible" },
        },
      ].map((event) => JSON.stringify(event)).join("\n") + "\n",
    );
    await writeFile(path.join(root, "browser-events.jsonl"), "");
    await writeFile(path.join(root, "browser-gaps.jsonl"), "");
    await writeFile(
      path.join(root, "video-frames.json"),
      JSON.stringify({
        version: 1,
        format: "jpeg",
        heartbeatMs: 5_000,
        frames: [
          {
            file: "video-frames/frame_000001.jpg",
            tMs: 1_700,
            offsetMs: 700,
            width: 1_280,
            height: 720,
          },
        ],
      }),
    );

    const first = await processEvidenceSession(root, "web-test");
    const second = await processEvidenceSession(root, "web-test");
    assert.deepEqual(second.index, first.index);
    assert.deepEqual(EvidenceIndexSchema.parse(first.index), first.index);
    assert.deepEqual(
      AutomationBlueprintSchema.parse(first.blueprint),
      first.blueprint,
    );
    assert.deepEqual(BlueprintReviewSchema.parse(first.review), first.review);
    assert.ok(first.blueprint.steps.length > 0);
    assert.equal(
      first.review.assertions[0]?.screenshotRef,
      "video-frames/frame_000001.jpg",
    );
    assert.deepEqual(
      JSON.parse(await readFile(path.join(root, "evidence-index.json"), "utf8")),
      first.index,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("nested browser and marker secrets are redacted from every derived artifact", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "flowcode-evidence-redact-"));
  const email = "dev@internal.example.com";
  try {
    await writeFile(
      path.join(root, "session.json"),
      JSON.stringify({
        schemaVersion: 2,
        eventSchemaVersion: 1,
        startedAtMonotonicMs: 1_000,
        id: "redaction-session",
        startedAt: 1_000,
        stoppedAt: 2_000,
        platform: "win32",
        appVersion: "0.5.0",
        link: { mode: "analyze-only", browserEnhancement: "semantic" },
      }),
    );
    await writeFile(
      path.join(root, "events.jsonl"),
      `${JSON.stringify({
        seq: 0,
        t: 400,
        epoch: 1_400,
        type: "assertion.marker",
        source: "user",
        payload: {
          markerId: "marker-private",
          note: `Send confirmation to ${email}`,
        },
      })}\n`,
    );
    const browserLine = JSON.stringify({
      schemaVersion: 1,
      eventId: "fill-contact",
      sessionId: "redaction-session",
      sourceId: "chrome-source",
      source: "browser",
      seq: 0,
      epochMs: 1_300,
      type: "browser.fill",
      payload: {
        tabId: 1,
        frameId: 0,
        documentId: "document-one",
        url: "https://example.test/",
        target: { tag: "input", role: "textbox", name: "Contact" },
        locators: [
          { kind: "role", value: "textbox|Contact", unique: true, score: 100 },
        ],
        value: { kind: "text", value: email, length: email.length, truncated: false },
      },
    });
    await writeFile(path.join(root, "browser-events.jsonl"), `${browserLine}\n`);
    await writeFile(path.join(root, "browser-gaps.jsonl"), "");
    await writeFile(path.join(root, "browser-clock.jsonl"), "");

    const result = await processEvidenceSession(root, "web-test");
    for (const artifact of [result.index, result.review, result.blueprint]) {
      assert.doesNotMatch(JSON.stringify(artifact), new RegExp(email));
    }
    assert.equal(result.review.variables[0]?.sensitive, true);
    assert.equal(result.review.variables[0]?.defaultValue, undefined);
    assert.ok(
      result.blueprint.privacy.redactions.some(
        (redaction) => redaction.category === "email",
      ),
    );
    assert.match(await readFile(path.join(root, "browser-events.jsonl"), "utf8"), new RegExp(email));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
