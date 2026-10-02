import { z } from "zod";
import { AutomationBlueprintV2Schema } from "./blueprint-v2";
import { BlueprintBindingSchema } from "./blueprint-v2";
import { BlueprintLocatorSchema } from "./blueprint";
import { ContractIdSchema as Id, ContentHashSchema as Hash } from "./execution-primitives";

export const ANALYZER_PROMPT_VERSION = "flowcode-analyzer-5c.9";
export const ANALYZER_SCHEMA_VERSION = "blueprint-v2.5c.4";
const SafeUrl = z.string().url().max(2048).refine(value => {
  const u = new URL(value);
  return !u.username && !u.password && !u.search && !u.hash &&
    (u.protocol === "https:" || (u.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname)));
}, "Use HTTPS or an explicit local model origin, without credentials/query/fragment.");
export const AnalyzerBudgetSchema = z.object({
  maxSeconds: z.number().int().min(10).max(1800),
  maxTokens: z.number().int().min(1024).max(200000),
  maxCostUsd: z.number().nonnegative().max(100),
  maxTurns: z.number().int().min(2).max(60),
}).strict();
export const ProviderSettingsSchema = z.object({
  schemaVersion: z.literal(1),
  providerId: Id,
  baseUrl: SafeUrl,
  modelId: z.string().min(1).max(192).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
  authentication: z.enum(["none", "credential-manager"]),
  pricing: z.enum(["free", "unknown", "metered"]),
  inputUsdPerMillion: z.number().nonnegative().optional(),
  inputCachedUsdPerMillion: z.number().nonnegative().optional(),
  outputUsdPerMillion: z.number().nonnegative().optional(),
  budget: AnalyzerBudgetSchema,
}).strict().superRefine((p, ctx) => {
  if (p.pricing === "metered" && (p.inputUsdPerMillion === undefined || p.outputUsdPerMillion === undefined))
    ctx.addIssue({ code: "custom", message: "Metered models require an explicit price ceiling." });
  if (p.inputCachedUsdPerMillion !== undefined && p.inputCachedUsdPerMillion > (p.inputUsdPerMillion ?? 0))
    ctx.addIssue({ code: "custom", message: "Cached input price must not exceed the regular input ceiling." });
  if (new URL(p.baseUrl).origin === "https://api.deepseek.com" && p.pricing !== "metered")
    ctx.addIssue({ code: "custom", message: "The official DeepSeek endpoint requires metered prices and a cost authorization." });
});
export type ProviderSettings = z.infer<typeof ProviderSettingsSchema>;
export const FREE_PROVIDER: ProviderSettings = {
  schemaVersion: 1, providerId: "flowcode-provider", baseUrl: "https://opencode.ai/zen/v1",
  modelId: "space-bunny-free", authentication: "none", pricing: "free",
  budget: { maxSeconds: 600, maxTokens: 120000, maxCostUsd: 0, maxTurns: 12 },
};
export const ProviderCapabilitiesSchema = z.object({
  settingsHash: Hash, checkedAt: z.number().nonnegative(),
  toolCalling: z.enum(["supported", "unsupported", "unknown"]),
  structuredOutput: z.enum(["supported", "unsupported", "unknown"]),
  vision: z.enum(["supported", "unsupported", "unknown"]),
  detail: z.string().max(2048),
}).strict();
export type ProviderCapabilities = z.infer<typeof ProviderCapabilitiesSchema>;
export const ProviderSaveSchema = z.object({ settings: ProviderSettingsSchema,
  apiKey: z.string().min(1).max(2500).optional(), clearKey: z.boolean().optional(),
}).strict();
export const BlueprintEditSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("delete"), stepId: Id }).strict(),
  z.object({ kind: z.literal("merge-inputs"), stepIds: z.array(Id).min(2).max(100) }).strict(),
  z.object({ kind: z.literal("manual"), stepId: Id, description: z.string().trim().min(1).max(4096) }).strict(),
  z.object({ kind: z.literal("input"), stepId: Id, input: BlueprintBindingSchema }).strict(),
  z.object({ kind: z.literal("intent"), intent: z.string().trim().min(1).max(4096) }).strict(),
  z.object({ kind: z.literal("confirm-assertion"), assertionId: Id }).strict(),
  z.object({ kind: z.literal("edit-assertion"), assertionId: Id,
    matcher: z.enum(["toBeVisible", "toContainText", "toHaveText", "toHaveURL", "toHaveCount", "toBeChecked"]),
    expected: BlueprintBindingSchema.optional(), beforeStepId: Id.optional(), afterStepId: Id.optional(),
    target: BlueprintLocatorSchema.optional(), pageRef: Id.optional(), frameRef: Id.optional(),
  }).strict(),
]);
export type BlueprintEdit = z.infer<typeof BlueprintEditSchema>;
export const BlueprintReviewFlagsSchema = z.object({
  intentConfirmed: z.boolean(), privacyReviewed: z.boolean(),
  approvedVariableIds: z.array(Id).max(500), approvedManualStepIds: z.array(Id).max(10000),
}).strict();
export type BlueprintReviewFlags = z.infer<typeof BlueprintReviewFlagsSchema>;
export const EMPTY_REVIEW_FLAGS: BlueprintReviewFlags = {
  intentConfirmed: false, privacyReviewed: false, approvedVariableIds: [], approvedManualStepIds: [],
};
export const AnalyzerPreviewRequestSchema = z.object({ sessionId: Id, screenshots: z.boolean(), feedback: z.string().trim().max(8000).optional() }).strict();
export const AnalyzerStartSchema = z.object({ sessionId: Id, previewId: z.uuid(), expectedHash: Hash,
  feedback: z.string().trim().max(8000).optional(),
}).strict();
export const AnalyzerControlSchema = z.object({ runId: z.uuid() }).strict();
export const BlueprintCompareSchema = z.object({ sessionId: Id, priorHash: Hash }).strict();
export interface BlueprintComparison { beforeRevision: number; afterRevision: number;
  differences: Array<{ field: string; before: string; after: string }> }
export const BlueprintEditRequestSchema = z.object({ sessionId: Id, expectedHash: Hash,
  edit: BlueprintEditSchema.optional(), flags: BlueprintReviewFlagsSchema.optional(),
  feedback: z.string().trim().max(8000).optional(),
}).strict().refine(v => v.edit || v.flags, "An edit or review decision is required.");
export const PreflightSchema = z.object({
  schemaValid: z.boolean(), reviewable: z.boolean(), generationReady: z.boolean(),
  todos: z.array(z.object({ code: z.string(), ownerId: Id.optional(),
    severity: z.enum(["blocker", "warning"]), message: z.string(), }).strict()),
}).strict();
export type GenerationPreflight = z.infer<typeof PreflightSchema>;
export const AnalyzerPreviewSchema = z.object({
  id: z.uuid(), sessionId: Id, blueprintHash: Hash, settingsHash: Hash, feedbackHash: Hash, scopeHash: Hash,
  categories: z.array(z.string()), redactionCount: z.number().int().nonnegative(),
  screenshots: z.boolean(), visionDegraded: z.boolean(), expiresAt: z.number(),
  sample: z.string().max(6000), tools: z.array(z.string()),
}).strict();
export type AnalyzerPreview = z.infer<typeof AnalyzerPreviewSchema>;
export const AnalyzerRunSchema = z.object({
  schemaVersion: z.literal(1), id: z.uuid(), sessionId: Id,
  phase: z.enum(["preparing", "analysis", "review-ready", "failed", "canceled", "interrupted"]),
  startedAt: z.number(), finishedAt: z.number().optional(), elapsedMs: z.number().optional(),
  provider: z.string(), model: z.string(), promptVersion: z.string(), schemaVersionName: z.string(),
  baseHash: Hash, settingsHash: Hash, candidateHash: Hash.optional(),
  inputTokens: z.number().optional(), outputTokens: z.number().optional(), costUsd: z.number().optional(),
  inputCachedTokens: z.number().optional(),
  error: z.string().max(2048).optional(),
}).strict();
export type AnalyzerRun = z.infer<typeof AnalyzerRunSchema>;
export const AnalyzerSnapshotSchema = z.object({
  blueprint: AutomationBlueprintV2Schema, flags: BlueprintReviewFlagsSchema,
  preflight: PreflightSchema, history: z.array(z.object({ revision: z.number(), contentHash: Hash,
    author: z.enum(["deterministic", "user", "analyzer"]), at: z.number(), feedback: z.string(),
    changedStepIds: z.array(Id), }).strict()),
  runs: z.array(AnalyzerRunSchema),
}).strict();
export type AnalyzerSnapshot = z.infer<typeof AnalyzerSnapshotSchema>;
export type AnalyzerResult<T> = { ok: true; value: T } | { ok: false; error: string };
