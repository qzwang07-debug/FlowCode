import { z } from "zod";
import { BrowserKindSchema, BrowserSemanticEventTypeSchema } from "./browser";
import {
  ContractIdSchema as Id,
  ContractTextSchema as Text,
  ContentHashSchema as Hash,
  ContractTimeSchema as Time,
  ContractSourceIdSchema,
  uniqueIds,
} from "./execution-primitives";

// Additive provider contract. The v1 Chrome/Edge bridge enum and registration
// remain unchanged; a Ziniao adapter must use its own source identity.
export const BrowserProviderSchema = z.enum([
  ...BrowserKindSchema.options,
  "ziniao",
]);
export const BrowserCapabilityFeatureSchema = z.enum([
  "cli-query",
  "exact-store-binding",
  "account-binding",
  "store-launch",
  "kernel-preparation",
  "extension-load",
  "site-permission",
  "native-messaging",
  "endpoint-identity",
  "semantic-capture",
  ...BrowserSemanticEventTypeSchema.options,
  "iframe",
  "shadow-dom",
  "spa",
  "flush",
  "reconnect",
  "trusted-origin",
  "cross-store-isolation",
  "playwright-cdp",
  "existing-context",
  "trace",
  "video",
  "upload",
  "download",
  "login-expired",
  "pause-resume",
  "side-effect-retry",
]);
export const BrowserVersionSnapshotSchema = z
  .object({
    cli: Text.optional(),
    client: Text.optional(),
    kernel: Text.optional(),
    playwright: Text.optional(),
  })
  .strict();
export const BrowserCapabilityResultSchema = z
  .object({
    feature: BrowserCapabilityFeatureSchema,
    status: z.enum(["supported", "unsupported", "unknown"]),
    evidenceRefs: z.array(Id),
    detail: Text,
  })
  .strict()
  .refine(
    (c) => c.status !== "supported" || c.evidenceRefs.length > 0,
    "Supported capabilities require actual evidence.",
  );
export const BrowserCapabilitiesSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: Id,
    provider: BrowserProviderSchema,
    checkedAt: Time,
    versions: BrowserVersionSnapshotSchema,
    transport: z.enum(["extension-native", "cdp-adapter", "undecided"]),
    results: z.array(BrowserCapabilityResultSchema),
  })
  .strict()
  .superRefine((c, ctx) => {
    if (new Set(c.results.map((r) => r.feature)).size !== c.results.length)
      ctx.addIssue({ code: "custom", message: "Duplicate capability." });
  });
export type BrowserCapabilities = z.infer<typeof BrowserCapabilitiesSchema>;
export function capabilitySupported(
  c: BrowserCapabilities,
  feature: z.infer<typeof BrowserCapabilityFeatureSchema>,
): boolean {
  return BrowserCapabilitiesSchema.parse(c).results.some(
    (r) => r.feature === feature && r.status === "supported",
  );
}

export const BrowserSiteScopeSchema = z
  .string()
  .url()
  .refine((value) => {
    const u = new URL(value);
    return (
      ["http:", "https:"].includes(u.protocol) &&
      !u.username &&
      !u.password &&
      value === u.origin
    );
  }, "Scope must be an exact HTTP(S) origin.");
export const ZiniaoStoreBindingSchema = z
  .object({
    accountRef: Hash,
    storeId: z.string().min(1).max(192),
    expectedName: z.string().min(1).max(256),
  })
  .strict();
const profile = {
  schemaVersion: z.literal(1),
  id: Id,
  revision: z.number().int().positive(),
  siteScopes: z.array(BrowserSiteScopeSchema).min(1).max(100),
  displayMode: z.enum(["visible", "headless"]),
  loginMode: z.enum(["manual", "existing-context", "none"]),
  capabilities: BrowserCapabilitiesSchema,
};
export const BrowserEnvironmentProfileSchema = z
  .discriminatedUnion("provider", [
    z.object({ ...profile, provider: z.literal("chrome") }).strict(),
    z.object({ ...profile, provider: z.literal("edge") }).strict(),
    z
      .object({
        ...profile,
        provider: z.literal("ziniao"),
        binding: ZiniaoStoreBindingSchema,
      })
      .strict(),
  ])
  .refine(
    (p) => p.provider === p.capabilities.provider,
    "Capability snapshot belongs to another provider.",
  );
export type BrowserEnvironmentProfile = z.infer<
  typeof BrowserEnvironmentProfileSchema
>;

export const BrowserSourceIdentitySchema = z
  .object({
    schemaVersion: z.literal(2),
    sourceId: ContractSourceIdSchema,
    sessionId: Id,
    provider: BrowserProviderSchema,
    environmentProfileId: Id,
    leaseId: Id,
    actor: z.enum(["human", "automation", "unknown"]),
    transport: z.enum(["extension-native", "cdp-adapter"]),
  })
  .strict();
export const BrowserSessionLeaseSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: Id,
    environmentProfileId: Id,
    environmentHash: Hash,
    provider: BrowserProviderSchema,
    binding: ZiniaoStoreBindingSchema.optional(),
    owner: z.discriminatedUnion("kind", [
      z
        .object({
          kind: z.literal("recording"),
          sessionId: Id,
          projectId: Id.optional(),
        })
        .strict(),
      z
        .object({
          kind: z.literal("run"),
          runId: Id,
          projectId: Id,
          targetId: Id,
        })
        .strict(),
    ]),
    pages: z.array(
      z
        .object({
          id: Id,
          ownership: z.enum(["borrowed", "created"]),
          allowAssociatedPopups: z.boolean(),
        })
        .strict(),
    ),
    launchOwnership: z.enum(["borrowed", "flowcode"]),
    issuedAt: Time,
    expiresAt: Time,
    state: z.enum([
      "preparing",
      "active",
      "paused",
      "released",
      "expired",
      "revoked",
    ]),
    releasedAt: Time.optional(),
  })
  .strict()
  .superRefine((l, ctx) => {
    uniqueIds(l.pages, ctx, "pages");
    if ((l.provider === "ziniao") !== Boolean(l.binding))
      ctx.addIssue({
        code: "custom",
        message: "Ziniao requires an exact local store binding.",
      });
    if (l.expiresAt <= l.issuedAt)
      ctx.addIssue({
        code: "custom",
        message: "Lease must have a positive lifetime.",
      });
    if (
      (l.state === "released") !== (l.releasedAt !== undefined) ||
      (l.releasedAt !== undefined && l.releasedAt < l.issuedAt)
    )
      ctx.addIssue({ code: "custom", message: "Invalid lease release time." });
  });
export type BrowserSessionLease = z.infer<typeof BrowserSessionLeaseSchema>;
