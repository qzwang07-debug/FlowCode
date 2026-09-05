import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import {
  OpenCodeContractClient,
  OpenCodePromptSchema,
} from "./contract-client";
import { probeEnvironment, restrictedProbeConfig } from "./probe-host";
import path from "node:path";

test("fake OpenCode server validates authentication, session, structured result and version drift", async () => {
  let version = "1.18.29";
  const server = createServer(async (req, res) => {
    if (
      req.headers.authorization !==
      `Basic ${Buffer.from("fixture:synthetic-password").toString("base64")}`
    ) {
      res.writeHead(401);
      res.end();
      return;
    }
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/global/health")
      res.end(JSON.stringify({ healthy: true, version }));
    else if (req.url === "/session")
      res.end(JSON.stringify({ id: "ses_fixture" }));
    else if (req.url === "/session/ses_fixture/message") {
      let content = "";
      for await (const c of req) content += c;
      const input = OpenCodePromptSchema.parse(JSON.parse(content));
      assert.equal(input.agent, "flowcode-probe");
      res.end(
        JSON.stringify({
          info: { structured: { result: "fixture" } },
          parts: [],
        }),
      );
    } else res.end("not-json");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const client = new OpenCodeContractClient(
    base,
    "fixture",
    "synthetic-password",
  );
  try {
    assert.equal((await client.health()).version, "1.18.29");
    await assert.rejects(
      new OpenCodeContractClient(base, "fixture", "wrong").health(),
      /401/,
    );
    const session = await client.createSession("Fake fixture");
    const result = await client.prompt(session.id, {
      agent: "flowcode-probe",
      model: { providerID: "fixture", modelID: "probe" },
      parts: [{ type: "text", text: "fixture" }],
      format: {
        type: "json_schema",
        schema: { type: "object" },
        retryCount: 0,
      },
    });
    assert.deepEqual(result, {
      info: { structured: { result: "fixture" } },
      parts: [],
    });
    version = "future-version";
    await assert.rejects(client.health());
    await assert.rejects(client.request("/malformed"), /malformed/);
    await assert.rejects(client.request("//outside.example"), /Invalid/);
    assert.throws(
      () =>
        new OpenCodeContractClient(
          "https://outside.example",
          "fixture",
          "secret",
        ),
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
test("probe environment drops ambient keys and denies every non-fixture model tool", () => {
  const old = process.env.FLOWCODE_TEST_KEY;
  process.env.FLOWCODE_TEST_KEY = "must-not-inherit";
  try {
    const config = restrictedProbeConfig(
      "http://127.0.0.1:1234/v1",
      "http://127.0.0.1:1234/mcp",
      "synthetic",
    );
    const env = probeEnvironment(path.resolve(".stage5a/test-only"), config);
    assert.equal(env.FLOWCODE_TEST_KEY, undefined);
    assert.equal(env.OPENCODE_DISABLE_AUTOUPDATE, "true");
    assert.equal(env.OPENCODE_DISABLE_PROJECT_CONFIG, "true");
    assert.equal(config.autoupdate, false);
    assert.deepEqual(config.agent["flowcode-probe"].permission, {
      "*": "deny",
      "probe_*": "allow",
      StructuredOutput: "allow",
    });
  } finally {
    if (old === undefined) delete process.env.FLOWCODE_TEST_KEY;
    else process.env.FLOWCODE_TEST_KEY = old;
  }
});
