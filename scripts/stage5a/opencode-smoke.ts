import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  OpenCodeProbeHost,
  OpenCodeSessionSchema,
  restrictedProbeConfig,
} from "../../electron/opencode/probe-host";
import {
  startProtocolFixture,
  ProbeResultSchema,
  probeResult,
} from "./local-protocol-fixture";

const fixture = await startProtocolFixture();
const host = new OpenCodeProbeHost({
  binary: path.resolve(
    ".stage5a/tools/node_modules/opencode-windows-x64/bin/opencode.exe",
  ),
  root: path.resolve(".stage5a/opencode-smoke"),
  config: restrictedProbeConfig(
    fixture.url + "/v1",
    fixture.url + "/mcp",
    fixture.token,
  ),
});
try {
  const binary = await host.start();
  assert.equal((await fetch(host.url + "/global/health")).status, 401);
  const spec = await host.request("/doc");
  const config = (await host.request("/config")) as Record<string, unknown>;
  assert.equal(config.autoupdate, false);
  const mcp = await host.request("/mcp");
  console.log("MCP", mcp);
  const agents = (await host.request("/agent")) as Array<{
    name: string;
    permission: unknown;
  }>;
  const session = OpenCodeSessionSchema.parse(
    await host.request("/session", {
      title: "FlowCode 5A restricted protocol proof",
    }),
  );
  const result = (await host.request(`/session/${session.id}/message`, {
    model: { providerID: "fixture", modelID: "probe" },
    agent: "flowcode-probe",
    parts: [
      {
        type: "text",
        text: "Read the synthetic fixture-session using the probe MCP tool and submit its structured result.",
      },
    ],
    format: {
      type: "json_schema",
      schema: z.toJSONSchema(ProbeResultSchema),
      retryCount: 0,
    },
  })) as { info: Record<string, unknown>; parts: unknown[] };
  if (result.info.error) throw new Error(JSON.stringify(result.info.error));
  console.log(
    "structured",
    result.info.structured,
    "tools",
    fixture.advertisedTools,
  );
  assert.deepEqual(
    ProbeResultSchema.parse(result.info.structured),
    probeResult,
  );
  assert.deepEqual(fixture.calls, ["read_fixture"]);
  for (const tools of fixture.advertisedTools)
    assert.ok(
      tools.every(
        (name) => name.endsWith("read_fixture") || name === "StructuredOutput",
      ),
      `Unexpected tools: ${tools}`,
    );
  await mkdir(path.resolve(".stage5a/evidence"), { recursive: true });
  await writeFile(
    path.resolve(".stage5a/evidence/opencode-openapi.json"),
    JSON.stringify(spec, null, 2) + "\n",
  );
  await host.stop();
  await assert.rejects(
    fetch(host.url + "/global/health", { signal: AbortSignal.timeout(1000) }),
  );
  const report = {
    schemaVersion: 1,
    ...binary,
    os: process.platform,
    auth: "pass",
    mcp,
    structuredResult: probeResult,
    restrictedTools: fixture.advertisedTools,
    actualMcpCalls: fixture.calls,
    agentPermissions: agents.find((a) => a.name === "flowcode-probe")
      ?.permission,
    autoupdate: config.autoupdate,
    shutdown: "pass",
    provider: "local deterministic HTTP fixture; no model inference",
    providerTurns: fixture.providerTurns,
  };
  await writeFile(
    path.resolve(".stage5a/evidence/opencode-smoke.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report));
} catch (error) {
  console.error(String(error));
  console.error(host.output.slice(-8000));
  console.error({
    methods: fixture.methods,
    advertisedTools: fixture.advertisedTools,
  });
  process.exitCode = 1;
} finally {
  await host.stop();
  await fixture.stop();
}
