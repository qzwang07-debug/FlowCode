import assert from "node:assert/strict";
import test from "node:test";

import {
  RecordingBrowserSelectionSchema,
  RecordingStartRequestSchema,
  ZiniaoPageSelectionRequestSchema,
  ZiniaoPrepareRequestSchema,
  ZiniaoRecordingStatusSchema,
  ZiniaoStoreSearchRequestSchema,
} from "./ziniao-recording";

test("5B renderer contracts accept controlled ids and reject endpoints or arbitrary paths", () => {
  const selection = {
    provider: "ziniao" as const,
    environmentProfileId: "env-1",
    preparationId: "prep-1",
    pageId: "page-1",
    allowAssociatedPopups: true,
  };
  assert.deepEqual(RecordingBrowserSelectionSchema.parse(selection), selection);
  assert.equal(
    RecordingStartRequestSchema.safeParse({
      link: { mode: "analyze-only", browserEnhancement: "semantic" },
      browser: selection,
    }).success,
    true,
  );
  for (const extra of [
    { cdpUrl: "ws://127.0.0.1:9222" },
    { storeId: "raw-store" },
    { executable: "C:\\outside\\browser.exe" },
  ])
    assert.equal(
      RecordingBrowserSelectionSchema.safeParse({ ...selection, ...extra })
        .success,
      false,
    );
  assert.equal(
    ZiniaoPageSelectionRequestSchema.safeParse({
      preparationId: "prep",
      pageId: "page",
      allowAssociatedPopups: false,
      approvedFrameOrigins: [],
      targetId: "raw-target",
    }).success,
    false,
  );
});

test("5B store search, preparation and status contracts preserve explicit states", () => {
  assert.equal(
    ZiniaoStoreSearchRequestSchema.safeParse({
      page: 1,
      limit: 10,
      keyword: "Fixture store",
    }).success,
    true,
  );
  assert.equal(
    ZiniaoStoreSearchRequestSchema.safeParse({ page: 0, limit: 1000 }).success,
    false,
  );
  assert.equal(
    ZiniaoPrepareRequestSchema.safeParse({
      kind: "store",
      storeId: "store-1",
      expectedName: "Fixture store",
    }).success,
    true,
  );
  assert.equal(
    ZiniaoRecordingStatusSchema.safeParse({
      schemaVersion: 1,
      provider: "ziniao",
      state: "degraded",
      cliVersion: "1.0.8",
      clientVersion: "6.26.6.7",
      kernelVersion: "142.0.7444.168",
      selectedProfileId: "env-1",
      selectedStoreName: "Fixture store",
      selectedPageTitle: "Fixture page",
      eventCount: 7,
      gapCount: 1,
      error: "One explicit gap",
    }).success,
    true,
  );
});
