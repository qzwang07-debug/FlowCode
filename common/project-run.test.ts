import assert from "node:assert/strict";
import test from "node:test";

import { AgentRunSchema, ProjectRunSchema } from "./project-run";

test("AgentRun and ProjectRun survive JSON round-trips", () => {
  const agentRun = {
    schemaVersion: 1,
    id: "agent-run-one",
    kind: "analysis",
    status: "succeeded",
    projectId: "project-one",
    recordingId: "recording-one",
    blueprintId: "blueprint-one",
    gitCommit: "a".repeat(40),
    promptVersion: "analyzer-v1",
    provider: "custom",
    model: "example-model",
    startedAt: 100,
    completedAt: 200,
    toolCalls: [],
    testResults: [],
  };
  assert.deepEqual(
    AgentRunSchema.parse(JSON.parse(JSON.stringify(agentRun)) as unknown),
    agentRun,
  );

  const projectRun = {
    schemaVersion: 1,
    id: "project-run-one",
    projectId: "project-one",
    kind: "web-test",
    status: "failed",
    startedAt: 300,
    completedAt: 400,
    exitCode: 1,
    artifacts: [
      {
        kind: "trace",
        path: "artifacts/trace.zip",
        mediaType: "application/zip",
      },
    ],
  };
  assert.deepEqual(
    ProjectRunSchema.parse(JSON.parse(JSON.stringify(projectRun)) as unknown),
    projectRun,
  );
});

test("run schemas reject completion before start", () => {
  assert.equal(
    ProjectRunSchema.safeParse({
      schemaVersion: 1,
      id: "project-run-one",
      projectId: "project-one",
      kind: "web-test",
      status: "succeeded",
      startedAt: 200,
      completedAt: 100,
      artifacts: [],
    }).success,
    false,
  );
});
