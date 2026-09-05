import assert from "node:assert/strict";
import test from "node:test";
import { BrowserKindSchema } from "./browser";
import {
  BrowserCapabilitiesSchema,
  BrowserSourceIdentitySchema,
  BrowserSessionLeaseSchema,
  capabilitySupported,
} from "./browser-environment";
import {
  ProjectContextSchema,
  ProjectRunRequestV2Schema,
  RunParametersSchema,
  RunCheckpointSchema,
  RecordingSourceStateSchema,
} from "./project-execution";

test("new provider identity is additive and unknown capabilities cannot become supported", () => {
  assert.equal(BrowserKindSchema.safeParse("ziniao").success, false);
  const source = {
    schemaVersion: 2,
    sourceId: "ziniao:fixture",
    sessionId: "fixture",
    provider: "ziniao",
    environmentProfileId: "env",
    leaseId: "lease",
    actor: "human",
    transport: "cdp-adapter",
  };
  assert.deepEqual(BrowserSourceIdentitySchema.parse(source), source);
  assert.equal(
    RecordingSourceStateSchema.safeParse({
      schemaVersion: 1,
      sessionId: source.sessionId,
      sourceId: source.sourceId,
      environmentProfileId: source.environmentProfileId,
      leaseId: source.leaseId,
      phase: "recording",
      updatedAt: 1,
      gapRefs: [],
    }).success,
    true,
  );
  const caps = BrowserCapabilitiesSchema.parse({
    schemaVersion: 1,
    id: "caps",
    provider: "ziniao",
    checkedAt: 1,
    versions: { cli: "1.0.8", client: "6.26.6.7", kernel: "142.0.7444.168" },
    transport: "undecided",
    results: [
      {
        feature: "trace",
        status: "unknown",
        detail: "Not verified",
        evidenceRefs: [],
      },
    ],
  });
  assert.equal(capabilitySupported(caps, "trace"), false);
  assert.equal(capabilitySupported(caps, "upload"), false);
  caps.results[0].status = "supported";
  assert.equal(BrowserCapabilitiesSchema.safeParse(caps).success, false);
});
test("leases and run requests contain IDs and controlled references, never raw endpoints or commands", () => {
  const lease = {
    schemaVersion: 1,
    id: "lease",
    environmentProfileId: "env",
    environmentHash: "a".repeat(64),
    provider: "ziniao",
    binding: {
      accountRef: "b".repeat(64),
      storeId: "synthetic-store",
      expectedName: "Fixture store",
    },
    owner: { kind: "recording", sessionId: "session" },
    pages: [{ id: "main", ownership: "borrowed", allowAssociatedPopups: true }],
    launchOwnership: "borrowed",
    issuedAt: 1,
    expiresAt: 100,
    state: "active",
  };
  assert.equal(BrowserSessionLeaseSchema.safeParse(lease).success, true);
  for (const changes of [
    { binding: undefined },
    { expiresAt: 0 },
    { endpoint: "http://localhost:1" },
    { state: "released" },
  ])
    assert.equal(
      BrowserSessionLeaseSchema.safeParse({ ...lease, ...changes }).success,
      false,
    );
  const request = {
    schemaVersion: 2,
    requestId: "request",
    projectId: "project",
    targetId: "target",
    worktreeId: "worktree",
    environmentProfileId: "env",
    blueprint: { id: "bp", revision: 1, contentHash: "c".repeat(64) },
    mode: "agent-validation",
    confirmationId: "confirmed",
    parameters: {
      password: { kind: "secret-ref", ref: "secret", revision: 1 },
      input: {
        kind: "file-ref",
        ref: "selected-file",
        contentHash: "d".repeat(64),
      },
    },
  };
  assert.equal(ProjectRunRequestV2Schema.safeParse(request).success, true);
  for (const changes of [
    { worktreeId: undefined },
    { cwd: "C:\\outside" },
    { command: ["cmd.exe"] },
    { cdpUrl: "http://localhost:1" },
  ])
    assert.equal(
      ProjectRunRequestV2Schema.safeParse({ ...request, ...changes }).success,
      false,
    );
  assert.equal(
    RunParametersSchema.safeParse({
      count: { kind: "value", type: "number", value: "123" },
    }).success,
    false,
  );
});
test("not-yet-indexed context and unknown business results are explicit contract states", () => {
  assert.equal(
    ProjectContextSchema.safeParse({
      schemaVersion: 1,
      status: "unavailable",
      projectId: "project",
      reason: "not-indexed",
      readOnly: true,
    }).success,
    true,
  );
  assert.equal(
    RunCheckpointSchema.safeParse({
      schemaVersion: 1,
      id: "cp",
      runId: "run",
      leaseId: "lease",
      updatedAt: 1,
      phase: "interrupted",
      binding: {
        schemaVersion: 1,
        projectId: "project",
        targetId: "target",
        environmentProfileId: "env",
        environmentHash: "a".repeat(64),
        blueprint: { id: "bp", revision: 1, contentHash: "a".repeat(64) },
        codeHash: "b".repeat(64),
        planHash: "c".repeat(64),
        parametersHash: "d".repeat(64),
      },
      steps: [
        { id: "submit", state: "unknown-result", effect: "business-submit" },
      ],
    }).success,
    true,
  );
});
