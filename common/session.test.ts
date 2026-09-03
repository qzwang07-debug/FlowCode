import assert from "node:assert/strict";
import test from "node:test";

import {
  RecordingSessionLinkSchema,
  migrateSessionMeta,
} from "./session";

test("legacy session metadata migrates in memory without mutating the source", () => {
  const legacy = {
    id: "legacy-session",
    startedAt: 1_000,
    stoppedAt: 2_000,
    platform: "win32",
    appVersion: "0.5.0",
  };
  const snapshot = structuredClone(legacy);

  const migrated = migrateSessionMeta(legacy);

  assert.deepEqual(legacy, snapshot);
  assert.equal(migrated.schemaVersion, 2);
  assert.equal(migrated.eventSchemaVersion, 1);
  assert.equal(migrated.startedAtMonotonicMs, legacy.startedAt);
  assert.deepEqual(migrated.link, {
    mode: "analyze-only",
    browserEnhancement: "none",
  });
});

test("session links require a project before analyze-and-build", () => {
  assert.equal(
    RecordingSessionLinkSchema.safeParse({
      mode: "analyze-and-build",
      browserEnhancement: "semantic",
    }).success,
    false,
  );
  assert.deepEqual(
    RecordingSessionLinkSchema.parse({
      projectId: "project-one",
      targetId: "checkout-flow",
      mode: "analyze-and-build",
      browserEnhancement: "semantic",
    }),
    {
      projectId: "project-one",
      targetId: "checkout-flow",
      mode: "analyze-and-build",
      browserEnhancement: "semantic",
    },
  );
});
