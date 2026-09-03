import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import AdmZip from "adm-zip";

import type { BrowserSemanticEvent } from "../../common/browser";
import type { EvidenceIndex } from "../../common/evidence";
import type { AutomationBlueprint } from "../../common/blueprint";
import { writeBlueprintExport } from "./exporter";

test("Blueprint exports contain the stable contract without captured fill plaintext", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "flowcode-blueprint-export-"));
  const destination = path.join(root, "blueprint.zip");
  const secret = "plain-text-must-not-export";
  const blueprint: AutomationBlueprint = {
    schemaVersion: 1,
    id: "blueprint-session-one",
    projectKind: "web-test",
    intent: "Fill the form.",
    preconditions: [],
    variables: [],
    steps: [],
    assertions: [],
    cleanup: [],
    evidenceRefs: [],
    privacy: { containsSensitiveData: true, redactions: [{ category: "password", count: 1 }], userReviewed: false },
  };
  const index: EvidenceIndex = {
    schemaVersion: 1,
    sessionId: "session-one",
    generatedAt: 2_000,
    sources: [],
    events: [],
    causalLinks: [],
    gaps: [],
    timeline: [],
    stats: { desktopEvents: 0, browserEvents: 1, duplicatesRemoved: 0, causalLinks: 0, gaps: 0 },
  };
  const browserEvent = {
    schemaVersion: 1,
    eventId: "fill-one",
    sessionId: "session-one",
    sourceId: "chrome-one",
    source: "browser",
    seq: 0,
    epochMs: 1_500,
    type: "browser.fill",
    payload: {
      tabId: 1,
      frameId: 0,
      documentId: "doc-one",
      url: "https://example.test/",
      target: { tag: "input", role: "textbox", name: `Secret ${secret}` },
      locators: [{ kind: "role", value: `textbox|Secret ${secret}`, unique: true, score: 100 }],
      value: { kind: "text", value: secret, length: secret.length, truncated: false },
    },
  } as BrowserSemanticEvent;

  try {
    await writeBlueprintExport({
      destination,
      sessionDir: root,
      blueprint,
      evidenceIndex: index,
      browserEvents: [browserEvent],
      includeScreenshots: false,
      sensitiveValues: [secret],
    });
    const zip = new AdmZip(destination);
    const names = zip.getEntries().map((entry) => entry.entryName);
    for (const required of [
      "manifest.json",
      "workflow.yaml",
      "assertions.yaml",
      "variables.schema.json",
      "privacy-summary.json",
      "BUILD.md",
      "evidence/timeline.json",
      "evidence/browser-actions.jsonl",
      "evidence/locator-candidates.json",
      "evidence/network-summary.json",
    ]) {
      assert.ok(names.includes(required), `${required} is missing`);
    }
    const bytes = await readFile(destination);
    assert.equal(bytes.includes(Buffer.from(secret)), false);
    const actions = zip.readAsText("evidence/browser-actions.jsonl");
    assert.match(actions, /"kind":"omitted"/);
    assert.doesNotMatch(actions, new RegExp(secret));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("only explicitly referenced in-session screenshots are included and hashed", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "flowcode-blueprint-screenshot-"));
  const destination = path.join(root, "with-screenshot.zip");
  await mkdir(path.join(root, "frames"));
  await writeFile(path.join(root, "frames", "assertion.jpg"), Buffer.from("jpeg-data"));
  const blueprint: AutomationBlueprint = {
    schemaVersion: 1,
    id: "blueprint-screenshot",
    projectKind: "web-test",
    intent: "Review a screenshot.",
    preconditions: [],
    variables: [],
    steps: [],
    assertions: [],
    cleanup: [],
    evidenceRefs: [
      { id: "evidence-screenshot-0001", kind: "screenshot", reference: "frames/assertion.jpg" },
    ],
    privacy: { containsSensitiveData: false, redactions: [], userReviewed: true },
  };
  const index: EvidenceIndex = {
    schemaVersion: 1,
    sessionId: "session-screenshot",
    generatedAt: 2_000,
    sources: [],
    events: [],
    causalLinks: [],
    gaps: [],
    timeline: [],
    stats: { desktopEvents: 0, browserEvents: 0, duplicatesRemoved: 0, causalLinks: 0, gaps: 0 },
  };
  try {
    await writeBlueprintExport({
      destination,
      sessionDir: root,
      blueprint,
      evidenceIndex: index,
      browserEvents: [],
      includeScreenshots: true,
    });
    const zip = new AdmZip(destination);
    const screenshotPath = "evidence/screenshots/frames/assertion.jpg";
    assert.ok(zip.getEntry(screenshotPath));
    const manifest = JSON.parse(zip.readAsText("manifest.json")) as {
      files: Array<{ path: string; sha256: string }>;
    };
    assert.match(
      manifest.files.find((file) => file.path === screenshotPath)?.sha256 ?? "",
      /^[a-f0-9]{64}$/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
