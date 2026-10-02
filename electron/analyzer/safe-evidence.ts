import { buildRedactor, scanSensitiveTexts } from "../sensitive/scanner";
import type { AutomationBlueprintV2 } from "../../common/blueprint-v2";
import { ProjectContextSchema } from "../../common/project-execution";
import type { z } from "zod";

export interface SafeEvidence {
  blueprint: AutomationBlueprintV2;
  timeline: Array<{ id: string; type: string; summary: string; atMs: number; relatedStepId?: string;
    target?: unknown; locatorCandidates: unknown[]; privacyTags: string[] }>;
  projectContext: z.infer<typeof ProjectContextSchema>;
  events: Array<{ id: string; type: string; atMs: number; payload: Record<string, unknown> }>;
  redactionCount: number;
  /** Main-process-only cross-feed for OCR; never serialized by an MCP tool. */
  knownValues: readonly string[];
  redact: (text: string) => Promise<string>;
}
function texts(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(texts);
  if (value && typeof value === "object") return Object.values(value).flatMap(texts);
  return [];
}
function mapText(value: unknown, redact: (text: string) => string, hashes: ReadonlySet<string>, key = ""): unknown {
  if (typeof value === "string") return ["contentHash", "evidenceHash", "baseHash", "blueprintHash"].includes(key) && hashes.has(value) ? value : redact(value);
  if (Array.isArray(value)) return value.map(item => mapText(item, redact, hashes));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mapText(v, redact, hashes, k)]));
  return value;
}
const localMetadata = (text: string) => text
  .replace(/\b(?:[A-Za-z]:[\\/]|\\\\)[^\s"<>]+/g, "[local-path]")
  .replace(/(?:https?|wss?):\/\/[^\s"<>]+/g, value => {
    try { const u = new URL(value); if (u.protocol.startsWith("ws") || u.pathname.startsWith("/devtools/")) return "[private-endpoint]";
      u.username = ""; u.password = ""; u.search = ""; u.hash = ""; return u.toString();
    } catch { return "[invalid-url]"; }
  });

/** Projection first, continuous sensitive scan second. Never send raw payloads,
 * native store/target/endpoint identifiers, local paths or Session directories. */
export async function createSafeEvidence(input: {
  blueprint: AutomationBlueprintV2; timeline: readonly Record<string, unknown>[];
  startedAt: number; projectId?: string; targetId?: string;
  projectContext: z.infer<typeof ProjectContextSchema>;
  sensitiveValues?: readonly string[];
  scan?: typeof scanSensitiveTexts;
  events?: readonly { eventId: string; type: string; epochMs: number; payload: Record<string, unknown> }[];
}): Promise<SafeEvidence> {
  const scan = input.scan ?? scanSensitiveTexts;
  const timeline = input.timeline.map(item => ({
    id: String(item.id), type: String(item.type), summary: String(item.summary),
    atMs: Math.max(0, Number(item.epochMs) - input.startedAt),
    ...(typeof item.relatedStepId === "string" ? { relatedStepId: item.relatedStepId } : {}),
    ...(item.target ? { target: item.target } : {}),
    locatorCandidates: Array.isArray(item.locatorCandidates) ? item.locatorCandidates : [],
    privacyTags: Array.isArray(item.privacyTags) ? item.privacyTags.map(String) : [],
  }));
  // Source references are contract IDs, not filesystem paths; evidence reference
  // locations are never used as an arbitrary file-reading API.
  const events = (input.events ?? []).map(event => ({ id: event.eventId, type: event.type,
    atMs: Math.max(0, event.epochMs - input.startedAt), payload: Object.fromEntries(
      ["app", "title", "url", "preview", "textPreview", "text", "command", "note", "label", "method", "status"].flatMap<[string, string | number | boolean]>(key => {
        const value = event.payload[key];
        return typeof value === "string" ? [[key, value.slice(0, 4096)]] : typeof value === "number" || typeof value === "boolean" ? [[key, value]] : [];
      })) }));
  const projected = { blueprint: input.blueprint, timeline, events, projectContext: ProjectContextSchema.parse(input.projectContext) };
  const finding = await scan(texts(projected)); // failure is fatal, not raw fallback
  const known = [...(input.sensitiveValues ?? []), ...finding.values];
  const hashes = new Set([input.blueprint.contentHash, input.blueprint.parent?.contentHash,
    input.blueprint.source?.evidenceHash, input.blueprint.source?.migratedFrom?.contentHash].filter((v): v is string => Boolean(v)));
  if (known.some(value => hashes.has(value))) throw new Error("Sensitive value aliases a contract hash; model data withheld.");
  const redact = buildRedactor(known);
  const safe = mapText(projected, value => localMetadata(redact(value)), hashes) as typeof projected;
  return {
    ...safe, redactionCount: known.length, knownValues: known,
    redact: async text => {
      const current = await scan([text]);
      const scrub = (value: string) => localMetadata(buildRedactor([...known, ...current.values])(value));
      // Preserve opaque contract hashes even when a short numeric store ID is
      // a substring. Data strings are still scanned/redacted at every leaf.
      try { const parsed = JSON.parse(text); return JSON.stringify(mapText(parsed, scrub, hashes)); }
      catch { return scrub(text); }
    },
  };
}
