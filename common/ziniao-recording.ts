import { z } from "zod";

import {
  BrowserProviderSchema,
  BrowserSiteScopeSchema,
} from "./browser-environment";
import {
  ContractIdSchema as Id,
  ContractTextSchema as Text,
  ContractTimeSchema as Time,
} from "./execution-primitives";
import { RecordingSessionLinkSchema } from "./session";

const StoreId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,191}$/);
const StoreName = z.string().trim().min(1).max(256);

export const ZiniaoStoreSummarySchema = z
  .object({
    storeId: StoreId,
    storeName: StoreName,
    platformName: z.string().max(256),
  })
  .strict();
export type ZiniaoStoreSummary = z.infer<typeof ZiniaoStoreSummarySchema>;

export const ZiniaoStoreSearchRequestSchema = z
  .object({
    page: z.number().int().positive(),
    limit: z.number().int().min(1).max(100),
    keyword: StoreName.optional(),
  })
  .strict();
export const ZiniaoStoreSearchResultSchema = z.discriminatedUnion("ok", [
  z
    .object({
      ok: z.literal(true),
      page: z.number().int().positive(),
      limit: z.number().int().positive(),
      total: z.number().int().nonnegative(),
      stores: z.array(ZiniaoStoreSummarySchema),
    })
    .strict(),
  z.object({ ok: z.literal(false), error: Text }).strict(),
]);

export const ZiniaoPublicProfileSchema = z
  .object({
    id: Id,
    revision: z.number().int().positive(),
    provider: z.literal("ziniao"),
    storeId: StoreId,
    storeName: StoreName,
    siteScopes: z.array(z.string().url()).min(1).max(100),
    capabilityState: z.enum(["supported", "degraded", "unsupported"]),
    updatedAt: Time,
  })
  .strict();
export type ZiniaoPublicProfile = z.infer<typeof ZiniaoPublicProfileSchema>;

export const ZiniaoPageSummarySchema = z
  .object({
    id: Id,
    title: z.string().max(1024),
    url: z.string().url().max(4096),
    origin: BrowserSiteScopeSchema,
    frameOrigins: z.array(BrowserSiteScopeSchema).max(100),
  })
  .strict();
export type ZiniaoPageSummary = z.infer<typeof ZiniaoPageSummarySchema>;

export const ZiniaoPrepareRequestSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("store"),
      storeId: StoreId,
      expectedName: StoreName,
    })
    .strict(),
  z.object({ kind: z.literal("profile"), profileId: Id }).strict(),
]);
export const ZiniaoPrepareResultSchema = z.discriminatedUnion("ok", [
  z
    .object({
      ok: z.literal(true),
      preparationId: Id,
      profileId: Id.optional(),
      storeName: StoreName,
      launchOwnership: z.enum(["borrowed", "flowcode"]),
      pages: z.array(ZiniaoPageSummarySchema).min(1),
      capabilityWarnings: z.array(Text),
    })
    .strict(),
  z.object({ ok: z.literal(false), error: Text }).strict(),
]);

export const ZiniaoPageSelectionRequestSchema = z
  .object({
    preparationId: Id,
    pageId: Id,
    allowAssociatedPopups: z.boolean(),
    approvedFrameOrigins: z.array(BrowserSiteScopeSchema).max(100),
  })
  .strict();

export const RecordingBrowserSelectionSchema = z.discriminatedUnion(
  "provider",
  [
    z.object({ provider: z.literal("chrome") }).strict(),
    z.object({ provider: z.literal("edge") }).strict(),
    z
      .object({
        provider: z.literal("ziniao"),
        environmentProfileId: Id,
        preparationId: Id,
        pageId: Id,
        allowAssociatedPopups: z.boolean(),
      })
      .strict(),
  ],
);
export type RecordingBrowserSelection = z.infer<
  typeof RecordingBrowserSelectionSchema
>;

export const ZiniaoPageSelectionResultSchema = z.discriminatedUnion("ok", [
  z
    .object({
      ok: z.literal(true),
      selection: RecordingBrowserSelectionSchema,
      profile: ZiniaoPublicProfileSchema,
    })
    .strict(),
  z.object({ ok: z.literal(false), error: Text }).strict(),
]);

export const RecordingStartRequestSchema = z
  .object({
    link: RecordingSessionLinkSchema,
    browser: RecordingBrowserSelectionSchema.optional(),
  })
  .strict();
export type RecordingStartRequest = z.infer<typeof RecordingStartRequestSchema>;

export const ZiniaoRecordingStatusSchema = z
  .object({
    schemaVersion: z.literal(1),
    provider: z.literal("ziniao"),
    state: z.enum([
      "unavailable",
      "idle",
      "preparing",
      "ready",
      "recording",
      "flushing",
      "degraded",
      "error",
    ]),
    cliVersion: z.string().max(64).nullable(),
    clientVersion: z.string().max(64).nullable(),
    kernelVersion: z.string().max(64).nullable(),
    selectedProfileId: Id.nullable(),
    selectedStoreName: StoreName.nullable(),
    selectedPageTitle: z.string().max(1024).nullable(),
    eventCount: z.number().int().nonnegative(),
    gapCount: z.number().int().nonnegative(),
    error: z.string().max(2000).nullable(),
  })
  .strict();
export type ZiniaoRecordingStatus = z.infer<
  typeof ZiniaoRecordingStatusSchema
>;

export const ZiniaoEnvironmentSnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    provider: BrowserProviderSchema.extract(["ziniao"]),
    available: z.boolean(),
    profiles: z.array(ZiniaoPublicProfileSchema),
    status: ZiniaoRecordingStatusSchema,
  })
  .strict();
export type ZiniaoEnvironmentSnapshot = z.infer<
  typeof ZiniaoEnvironmentSnapshotSchema
>;

export const ZiniaoActionResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true) }).strict(),
  z.object({ ok: z.literal(false), error: Text }).strict(),
]);
