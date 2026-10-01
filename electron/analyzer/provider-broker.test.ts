import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { ProviderBroker } from "./provider-broker";
import { FREE_PROVIDER } from "../../common/analyzer";
import { PersistentSpendBudget } from "./spend-budget";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

test("provider broker confines model/route, keeps keys out of bodies and scrubs leaf text safely", async () => {
  let forwarded = 0; let captured: Record<string, unknown> = {}; let header = "";
  const server = createServer(async (req, res) => {
    let text = ""; for await (const c of req) text += c;
    captured = JSON.parse(text); header = req.headers.authorization ?? ""; forwarded++;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: "Synthetic response" } }], usage: { prompt_tokens: 10, completion_tokens: 10 } }));
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
  const broker = new ProviderBroker({ ...FREE_PROVIDER, modelId: "fixture", baseUrl, budget: { ...FREE_PROVIDER.budget, maxTurns: 2 } },
    "synthetic-model-key", undefined, undefined, async s => s.replaceAll("private@example.test", "[redacted]"));
  await broker.start();
  const request = (model: string, route = "/chat/completions", token = broker.token) => fetch(broker.url + route, { method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ model, stream: false, messages: [{ role: "user", content: 'Nested JSON {"url":"https://fixture.test"} private@example.test' }] }) });
  try {
    assert.equal((await request("other-model")).status, 502); assert.equal(forwarded, 0);
    assert.equal((await request("fixture", "/arbitrary-api")).status, 403);
    assert.equal((await request("fixture", "/chat/completions", "wrong")).status, 401);
    assert.equal((await request("fixture")).status, 200); assert.equal(forwarded, 1);
    assert.equal(header, "Bearer synthetic-model-key");
    assert.ok(!JSON.stringify(captured).includes("synthetic-model-key"));
    assert.ok(!JSON.stringify(captured).includes("private@example.test"));
    assert.equal((await request("fixture")).status, 200);
    assert.equal((await request("fixture")).status, 502); assert.equal(forwarded, 2);
    broker.revoke(); assert.equal((await request("fixture")).status, 401);
  } finally { await broker.stop(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
});

test("total API authorization reserves parallel calls, survives restart and counts unknown usage", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "flowcode-5c-spend-")), file = path.join(root, "spend.jsonl");
  let spend = new PersistentSpendBudget(file, 0.10);
  try {
    const a = await spend.reserve(0.06);
    await assert.rejects(spend.reserve(0.05));
    assert.throws(() => new PersistentSpendBudget(file, 0.10));
    await a.settle(0.01);
    const b = await spend.reserve(0.06); await b.settle(null);
    assert.equal(spend.view().accountedUsd, 0.07);
    await spend.reserve(0.02); // Simulate a crashed request: preserve reservation.
    spend.close(); spend = new PersistentSpendBudget(file, 0.10);
    assert.equal(spend.view().unresolvedRequests, 1);
    await assert.rejects(spend.reserve(0.02));
    spend.close(); assert.throws(() => new PersistentSpendBudget(file, 1));
  } finally { spend.close(); await rm(root, { recursive: true, force: true }); }
});

test("usage beyond a reservation poisons its authorization across restart", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "flowcode-5c-spend-")), file = path.join(root, "spend.jsonl");
  let spend = new PersistentSpendBudget(file, 0.10);
  try {
    const request = await spend.reserve(0.01); await assert.rejects(request.settle(0.02));
    await assert.rejects(spend.reserve(0));
    spend.close(); spend = new PersistentSpendBudget(file, 0.10);
    await assert.rejects(spend.reserve(0));
  } finally { spend.close(); await rm(root, { recursive: true, force: true }); }
});

test("oversized prompt is denied before any model network request", async () => {
  let forwarded = 0;
  const server = createServer((_req, res) => { forwarded++; res.end("{}"); });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const broker = new ProviderBroker({ ...FREE_PROVIDER, modelId: "fixture", baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    budget: { ...FREE_PROVIDER.budget, maxTokens: 1024 } });
  await broker.start();
  try {
    const response = await fetch(broker.url + "/chat/completions", { method: "POST", headers: { authorization: `Bearer ${broker.token}` },
      body: JSON.stringify({ model: "fixture", messages: [{ role: "user", content: "x".repeat(2048) }] }) });
    assert.equal(response.status, 502); assert.equal(forwarded, 0);
  } finally { await broker.stop(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
});

test("SSE usage accepts optional spacing, ignores provisional values and counts final usage once", async () => {
  let requests = 0;
  const server = createServer(async (req, res) => {
    requests++;
    for await (const _ of req) { /* consume bounded fixture body */ }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write('data:{"choices":[],"usage":{}}\n\n');
    res.write('data:{"choices":[],"usage":{"prompt_tokens":null,"completion_tokens":null}}\n\n');
    res.write('data:{"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5}}\n\n');
    res.write(`data: {"choices":[],"usage":{"prompt_tokens":20,"completion_tokens":10,"prompt_cache_hit_tokens":${requests === 1 ? 15 : 200}}}\n\n`);
    res.end('data:[DONE]\n\n');
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const limits: string[] = [];
  const broker = new ProviderBroker({ ...FREE_PROVIDER, modelId: "fixture", pricing: "metered", inputUsdPerMillion: 1, inputCachedUsdPerMillion: 0.1, outputUsdPerMillion: 2,
    budget: { ...FREE_PROVIDER.budget, maxCostUsd: 0.10 }, baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}` }, undefined, c => limits.push(c));
  await broker.start();
  try {
    const response = await fetch(broker.url + "/chat/completions", { method: "POST", headers: { authorization: `Bearer ${broker.token}` },
      body: JSON.stringify({ model: "fixture", stream: true, messages: [{ role: "user", content: "Synthetic usage test" }] }) });
    await response.text();
    assert.equal(broker.usage.inputTokens, 20); assert.equal(broker.usage.outputTokens, 10);
    assert.equal(broker.usage.inputCachedTokens, 15); assert.ok(Math.abs(broker.usage.costUsd! - 0.0000265) < 1e-12);
    const invalidCached = await fetch(broker.url + "/chat/completions", { method: "POST", headers: { authorization: `Bearer ${broker.token}` },
      body: JSON.stringify({ model: "fixture", stream: true, messages: [{ role: "user", content: "Invalid cached counts stay fully metered" }] }) });
    await invalidCached.text();
    assert.equal(broker.usage.inputCachedTokens, 15); assert.equal(broker.usage.inputTokens, 40);
    assert.ok(Math.abs(broker.usage.costUsd! - 0.0000665) < 1e-12);
    assert.deepEqual(limits, []);
  } finally { await broker.stop(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
});
