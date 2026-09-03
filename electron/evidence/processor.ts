import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  AutomationBlueprintSchema,
  type AutomationBlueprint,
} from "../../common/blueprint";
import {
  BlueprintReviewSchema,
  EvidenceIndexSchema,
  normalizeStoredFlowEvent,
  type BlueprintReview,
  type EvidenceIndex,
} from "../../common/evidence";
import type { ProjectKind } from "../../common/project";
import { migrateSessionMeta, type SessionMetaV2 } from "../../common/session";
import {
  buildRedactor,
  scanSessionDirectory,
} from "../sensitive/scanner";
import {
  buildDeterministicBlueprint,
  createBlueprintReview,
} from "./blueprint-builder";
import { fuseEvidence, type FusedEvidence } from "./fusion";

export const EVIDENCE_INDEX_FILE = "evidence-index.json";
export const EVIDENCE_TIMELINE_FILE = "evidence-timeline.json";
export const BLUEPRINT_REVIEW_FILE = "blueprint-review.json";
export const BLUEPRINT_FILE = "blueprint.json";

export interface ProcessedEvidence {
  session: SessionMetaV2;
  evidence: FusedEvidence;
  index: EvidenceIndex;
  review: BlueprintReview;
  blueprint: AutomationBlueprint;
  /** Main-process-only raw matches used to redact export evidence; never sent over IPC. */
  sensitiveValues: string[];
}

function sanitizeJson(value: unknown, redact: (value: string) => string): unknown {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeJson(item, redact));
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, sanitizeJson(item, redact)]),
  );
}

export function sanitizeBlueprintReview(
  review: BlueprintReview,
  sensitiveValues: readonly string[],
): BlueprintReview {
  if (sensitiveValues.length === 0) return review;
  const redact = buildRedactor([...sensitiveValues]);
  return BlueprintReviewSchema.parse({
    ...review,
    intent: redact(review.intent),
    variables: review.variables.map((variable) => {
      const serialized =
        variable.defaultValue === undefined
          ? null
          : JSON.stringify(variable.defaultValue);
      const defaultIsSensitive = serialized !== null && redact(serialized) !== serialized;
      return {
        ...variable,
        name: redact(variable.name),
        ...(variable.description
          ? { description: redact(variable.description) }
          : {}),
        ...(defaultIsSensitive
          ? { sensitive: true, defaultValue: undefined }
          : {}),
      };
    }),
    assertions: review.assertions.map((assertion) => ({
      ...assertion,
      note: redact(assertion.note),
      ...(assertion.target
        ? { target: sanitizeJson(assertion.target, redact) }
        : {}),
      ...(assertion.expected !== undefined
        ? { expected: sanitizeJson(assertion.expected, redact) }
        : {}),
    })),
  });
}

function sanitizeEvidenceIndex(
  index: EvidenceIndex,
  sensitiveValues: readonly string[],
): EvidenceIndex {
  if (sensitiveValues.length === 0) return index;
  const redact = buildRedactor([...sensitiveValues]);
  return EvidenceIndexSchema.parse({
    ...index,
    timeline: index.timeline.map((item) => ({
      ...item,
      summary: redact(item.summary),
      locatorCandidates: item.locatorCandidates.map((locator) => ({
        ...locator,
        value: redact(locator.value),
      })),
      ...(item.target ? { target: sanitizeJson(item.target, redact) } : {}),
    })),
  });
}

async function readJson(file: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as unknown;
  } catch {
    return null;
  }
}

async function readJsonLines(file: string): Promise<unknown[]> {
  let contents: string;
  try {
    contents = await readFile(file, "utf8");
  } catch {
    return [];
  }
  const values: unknown[] = [];
  for (const line of contents.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      values.push(JSON.parse(line) as unknown);
    } catch {
      // Append-only files may end in one partial line after a crash.
    }
  }
  return values;
}

async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  const temporary = `${file}.tmp.${process.pid}.${randomUUID()}`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

function correlationFrames(input: unknown): Array<{ file: string; epochMs: number }> {
  if (typeof input !== "object" || input === null) return [];
  const frames = (input as Record<string, unknown>).frames;
  if (!Array.isArray(frames)) return [];
  return frames.flatMap((frame) => {
    if (typeof frame !== "object" || frame === null) return [];
    const record = frame as Record<string, unknown>;
    if (
      typeof record.file !== "string" ||
      typeof record.tMs !== "number" ||
      !Number.isFinite(record.tMs) ||
      record.tMs < 0 ||
      record.file.includes("..") ||
      record.file.includes("\\") ||
      record.file.startsWith("/")
    ) {
      return [];
    }
    return [
      {
        file: `frames/${path.posix.basename(record.file)}`,
        epochMs: record.tMs,
      },
    ];
  });
}

function capturedFrames(input: unknown): Array<{ file: string; epochMs: number }> {
  if (typeof input !== "object" || input === null) return [];
  const frames = (input as Record<string, unknown>).frames;
  if (!Array.isArray(frames)) return [];
  return frames.flatMap((frame) => {
    if (typeof frame !== "object" || frame === null) return [];
    const record = frame as Record<string, unknown>;
    if (
      typeof record.file !== "string" ||
      typeof record.tMs !== "number" ||
      !Number.isFinite(record.tMs) ||
      record.tMs < 0 ||
      record.file.includes("..") ||
      record.file.includes("\\") ||
      record.file.startsWith("/") ||
      record.file.split("/").some((part) => !part || part === "." || part === "..")
    ) {
      return [];
    }
    return [{ file: record.file, epochMs: record.tMs }];
  });
}

export async function processEvidenceSession(
  sessionDir: string,
  projectKind: ProjectKind,
): Promise<ProcessedEvidence> {
  const session = migrateSessionMeta(
    await readJson(path.join(sessionDir, "session.json")),
  );
  const desktopEvents = (await readJsonLines(path.join(sessionDir, "events.jsonl")))
    .flatMap((raw) => {
      try {
        return [
          normalizeStoredFlowEvent(raw, {
            sessionId: session.id,
            startedAt: session.startedAt,
          }),
        ];
      } catch {
        return [];
      }
    });
  const rawBrowserEvents = await readJsonLines(
    path.join(sessionDir, "browser-events.jsonl"),
  );
  const rawClockSamples = await readJsonLines(
    path.join(sessionDir, "browser-clock.jsonl"),
  );
  const rawGaps = await readJsonLines(
    path.join(sessionDir, "browser-gaps.jsonl"),
  );
  const frameCandidates = [
    ...correlationFrames(
      await readJson(path.join(sessionDir, "correlation.json")),
    ),
    ...capturedFrames(
      await readJson(path.join(sessionDir, "video-frames.json")),
    ),
  ];
  const frames = [
    ...new Map(
      frameCandidates.map((frame) => [`${frame.file}\0${frame.epochMs}`, frame]),
    ).values(),
  ];
  const fusedEvidence = fuseEvidence({
    session,
    desktopEvents,
    browserEvents: rawBrowserEvents,
    clockSamples: rawClockSamples,
    gaps: rawGaps,
    frames,
  });

  const sensitive = await scanSessionDirectory(sessionDir, session.id);
  const evidence = {
    ...fusedEvidence,
    index: sanitizeEvidenceIndex(fusedEvidence.index, sensitive.values),
  };

  const storedReview = BlueprintReviewSchema.safeParse(
    await readJson(path.join(sessionDir, BLUEPRINT_REVIEW_FILE)),
  );
  const baseReview =
    storedReview.success && storedReview.data.sessionId === session.id
      ? storedReview.data
      : createBlueprintReview(session, projectKind, evidence);
  const review = sanitizeBlueprintReview(baseReview, sensitive.values);
  const generatedBlueprint = buildDeterministicBlueprint(session, evidence, review);
  const builtBlueprint =
    sensitive.values.length > 0
      ? AutomationBlueprintSchema.parse(
          sanitizeJson(
            generatedBlueprint,
            buildRedactor(sensitive.values),
          ),
        )
      : generatedBlueprint;
  const redactions = new Map(
    builtBlueprint.privacy.redactions.map(({ category, count }) => [category, count]),
  );
  for (const [category, count] of Object.entries(sensitive.report.counts)) {
    if (count !== undefined) {
      redactions.set(category, (redactions.get(category) ?? 0) + count);
    }
  }
  const blueprint = AutomationBlueprintSchema.parse({
    ...builtBlueprint,
    privacy: {
      ...builtBlueprint.privacy,
      containsSensitiveData: redactions.size > 0,
      redactions: [...redactions.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([category, count]) => ({ category, count })),
    },
  });

  await Promise.all([
    writeJsonAtomic(path.join(sessionDir, EVIDENCE_INDEX_FILE), evidence.index),
    writeJsonAtomic(
      path.join(sessionDir, EVIDENCE_TIMELINE_FILE),
      evidence.index.timeline,
    ),
    writeJsonAtomic(path.join(sessionDir, BLUEPRINT_REVIEW_FILE), review),
    writeJsonAtomic(path.join(sessionDir, BLUEPRINT_FILE), blueprint),
  ]);
  return {
    session,
    evidence,
    index: evidence.index,
    review,
    blueprint,
    sensitiveValues: sensitive.values,
  };
}

export async function saveBlueprintReview(
  sessionDir: string,
  review: BlueprintReview,
): Promise<void> {
  await writeJsonAtomic(
    path.join(sessionDir, BLUEPRINT_REVIEW_FILE),
    BlueprintReviewSchema.parse(review),
  );
}
