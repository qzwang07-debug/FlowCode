import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";

import { ZipArchive } from "archiver";

import type { AutomationBlueprint, BlueprintVariable } from "../../common/blueprint";
import type { FlowEvent, EvidenceIndex } from "../../common/evidence";
import { maskValue } from "../../common/sensitive";

export interface BlueprintExportInput {
  destination: string;
  sessionDir: string;
  blueprint: AutomationBlueprint;
  evidenceIndex: EvidenceIndex;
  browserEvents: readonly FlowEvent[];
  includeScreenshots: boolean;
  sensitiveValues?: readonly string[];
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function jsonLine(value: unknown): string {
  return JSON.stringify(value);
}

function variableJsonType(variable: BlueprintVariable): string | string[] {
  switch (variable.type) {
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "json":
      return ["array", "object", "string", "number", "boolean", "null"];
    default:
      return "string";
  }
}

function variablesSchema(variables: readonly BlueprintVariable[]) {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    additionalProperties: false,
    properties: Object.fromEntries(
      variables.map((variable) => [
        variable.id,
        {
          type: variableJsonType(variable),
          title: variable.name,
          ...(variable.description ? { description: variable.description } : {}),
          ...(variable.defaultValue !== undefined && !variable.sensitive
            ? { default: variable.defaultValue }
            : {}),
          "x-flowcode-source": variable.source,
          "x-flowcode-sensitive": variable.sensitive,
        },
      ]),
    ),
    required: variables.filter((variable) => variable.required).map((variable) => variable.id),
  };
}

function exportRedactor(values: readonly string[]): (value: string) => string {
  const ordered = [...new Set(values.filter((value) => value.length >= 3))].sort(
    (left, right) => right.length - left.length,
  );
  return (value) => {
    let result = value;
    for (const sensitive of ordered) {
      result = result.split(sensitive).join(maskValue(sensitive));
    }
    return result;
  };
}

function redactUnknown(value: unknown, redact: (value: string) => string): unknown {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map((item) => redactUnknown(item, redact));
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, redactUnknown(item, redact)]),
  );
}

function sanitizeBrowserEvent(
  rawEvent: FlowEvent,
  redact: (value: string) => string,
): FlowEvent {
  const event = redactUnknown(rawEvent, redact) as FlowEvent;
  if (event.type !== "browser.fill") return event;
  const value = rawEvent.payload.value;
  if (typeof value !== "object" || value === null) return event;
  const record = value as Record<string, unknown>;
  if (record.kind !== "text") return event;
  return {
    ...event,
    payload: {
      ...event.payload,
      value: {
        kind: "omitted",
        length:
          typeof record.length === "number"
            ? record.length
            : typeof record.value === "string"
              ? record.value.length
              : 0,
        reason: "export-policy",
      },
    },
  };
}

function locatorInventory(events: readonly FlowEvent[]) {
  return events
    .filter((event) => Array.isArray(event.payload.locators))
    .map((event) => ({
      eventId: event.eventId,
      type: event.type,
      target: event.payload.target,
      candidates: event.payload.locators,
    }));
}

function exportContents(input: BlueprintExportInput): Map<string, string> {
  const files = new Map<string, string>();
  const redact = exportRedactor(input.sensitiveValues ?? []);
  const browserEvents = input.browserEvents.map((event) =>
    sanitizeBrowserEvent(event, redact),
  );
  files.set(
    "workflow.yaml",
    json({
      schemaVersion: input.blueprint.schemaVersion,
      kind: input.blueprint.projectKind,
      intent: input.blueprint.intent,
      preconditions: input.blueprint.preconditions,
      steps: input.blueprint.steps,
      cleanup: input.blueprint.cleanup,
    }),
  );
  files.set("assertions.yaml", json(input.blueprint.assertions));
  files.set(
    "variables.schema.json",
    json(variablesSchema(input.blueprint.variables)),
  );
  files.set("privacy-summary.json", json(input.blueprint.privacy));
  files.set(
    "BUILD.md",
    [
      "# FlowCode Automation Blueprint",
      "",
      `Intent: ${input.blueprint.intent}`,
      "",
      "This package was generated deterministically from local recording evidence.",
      "The `.yaml` files use JSON-compatible YAML syntax. Review unconfirmed assertions",
      "and provide runtime or environment variables before generating project code.",
      "",
    ].join("\n"),
  );
  files.set("evidence/timeline.json", json(input.evidenceIndex.timeline));
  files.set(
    "evidence/browser-actions.jsonl",
    `${browserEvents.map((event) => jsonLine(event)).join("\n")}${browserEvents.length ? "\n" : ""}`,
  );
  files.set(
    "evidence/locator-candidates.json",
    json(locatorInventory(browserEvents)),
  );
  files.set(
    "evidence/network-summary.json",
    json({
      schemaVersion: 1,
      exchanges: browserEvents
        .filter((event) => event.type === "browser.network")
        .map((event) => event),
      note:
        "Network bodies are not included. Standard Stage 4 exports contain metadata only.",
    }),
  );
  return files;
}

async function safeScreenshotFiles(input: BlueprintExportInput) {
  if (!input.includeScreenshots) return [];
  const root = await realpath(input.sessionDir);
  const references = new Set(
    input.blueprint.evidenceRefs
      .filter((reference) => reference.kind === "screenshot")
      .map((reference) => reference.reference),
  );
  const files: Array<{ data: Buffer; name: string }> = [];
  for (const reference of [...references].sort()) {
    if (
      reference.includes("\0") ||
      reference.includes("\\") ||
      reference.startsWith("/") ||
      reference.split("/").some((part) => !part || part === "." || part === "..")
    ) {
      continue;
    }
    const candidate = path.resolve(root, ...reference.split("/"));
    const relative = path.relative(root, candidate);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) continue;
    const info = await lstat(candidate).catch(() => null);
    if (!info?.isFile() || info.isSymbolicLink()) continue;
    const canonical = await realpath(candidate).catch(() => null);
    if (!canonical) continue;
    const canonicalRelative = path.relative(root, canonical);
    if (canonicalRelative.startsWith("..") || path.isAbsolute(canonicalRelative)) continue;
    files.push({
      data: await readFile(canonical),
      name: `evidence/screenshots/${reference}`,
    });
  }
  return files;
}

export async function writeBlueprintExport(input: BlueprintExportInput): Promise<void> {
  const contents = exportContents(input);
  const screenshots = await safeScreenshotFiles(input);
  const hashes = [
    ...[...contents.entries()].map(([name, value]) => ({
      path: name,
      sha256: createHash("sha256").update(value, "utf8").digest("hex"),
    })),
    ...screenshots.map((screenshot) => ({
      path: screenshot.name,
      sha256: createHash("sha256").update(screenshot.data).digest("hex"),
    })),
  ].sort((left, right) => left.path.localeCompare(right.path));
  contents.set(
    "manifest.json",
    json({
      schemaVersion: 1,
      blueprintId: input.blueprint.id,
      sessionId: input.evidenceIndex.sessionId,
      generatedAt: input.evidenceIndex.generatedAt,
      screenshotsIncluded: input.includeScreenshots,
      files: hashes,
    }),
  );
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve();
    };
    const output = createWriteStream(input.destination, { flags: "w" });
    const archive = new ZipArchive({ zlib: { level: 6 } });
    output.on("close", () => finish());
    output.on("error", (error) => finish(error));
    archive.on("error", (error) => finish(error));
    archive.pipe(output);
    for (const [name, value] of contents) archive.append(value, { name });
    if (screenshots.length === 0) {
      archive.append("", { name: "evidence/screenshots/" });
    }
    for (const screenshot of screenshots) {
      archive.append(screenshot.data, { name: screenshot.name });
    }
    void archive.finalize();
  });
}
