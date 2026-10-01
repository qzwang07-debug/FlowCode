import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { FREE_PROVIDER, type ProviderSettings } from "../../common/analyzer";
import type { AutomationBlueprintV2 } from "../../common/blueprint-v2";
import type { EvidenceReviewSnapshot } from "../../common/evidence";
import { contractHash } from "../../electron/evidence/blueprint-contract";
import { AnalyzerService } from "../../electron/analyzer/service";
import { ProviderStore } from "../../electron/analyzer/provider-store";
import { makeSessionMeta } from "../../evals/scenario";

const root = path.resolve(".stage5c", "protocol", String(Date.now()));
const sessionRoot = path.join(root, "sessions");
process.env.SKILL_RECORDER_SESSIONS_DIR = sessionRoot;
const base: AutomationBlueprintV2 = JSON.parse(await readFile("fixtures/stage5a/blueprint-v2.json", "utf8"));
await mkdir(path.join(sessionRoot, base.source.sessionId), { recursive: true });
await writeFile(path.join(sessionRoot, base.source.sessionId, "session.json"), JSON.stringify(makeSessionMeta(base.source.sessionId, 1000, 8000, "win32")));
const safeSnapshot = {
  session: { ...makeSessionMeta(base.source.sessionId, 1000, 8000, "win32"), link: { mode: "analyze-only" } },
  blueprintV2: base,
  index: { timeline: base.steps.map((s, i) => ({ id: `timeline-${i}`, eventId: base.evidenceRefs.find(e => e.id === s.evidenceRefs[0])?.reference ?? `event-${i}`,
    type: `browser.${s.action}`, epochMs: 1000 + i * 500, summary: s.description, relatedStepId: s.id,
    locatorCandidates: [], screenshotRefs: [], privacyTags: [] })), gaps: [] },
} as unknown as EvidenceReviewSnapshot;
let turns = 0; const advertised: string[][] = [];
const realModel = process.argv.includes("--real-model");
const cancelMode = process.argv.includes("--cancel");
const server = createServer(async (req, res) => {
  try {
    let text = ""; for await (const c of req) { text += c; if (text.length > 1024 * 1024) throw new Error("quota"); }
    const input = JSON.parse(text); turns++;
    const tools: string[] = input.tools?.map((t: { function: { name: string } }) => t.function.name) ?? [];
    advertised.push(tools);
    const probe = input.tools?.find((t: { function: { name: string } }) => t.function.name === "flowcode_probe");
    if (probe) {
      const nonce = /nonce ([a-f0-9]+)/.exec(input.messages[0].content)?.[1];
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ choices: [{ message: { tool_calls: [{ function: { name: "flowcode_probe", arguments: JSON.stringify({ nonce, revision: 1 }) } }] } }] }));
    }
    const toolMessages = input.messages.filter((m: { role: string }) => m.role === "tool");
    if (!tools.length && input.messages.some((m: { content: unknown }) => Array.isArray(m.content) && m.content.some(c => c.type === "image_url"))) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ choices: [{ message: { content: "unavailable" } }], usage: { prompt_tokens: 2, completion_tokens: 2 } }));
    }
    if (cancelMode) {
      res.writeHead(200, { "content-type": "text/event-stream" }); res.write(": fixture waits for cancellation\n\n");
      return;
    }
    const read = tools.find(n => n.endsWith("recording_get_timeline"));
    const submit = tools.find(n => n.endsWith("recording_submit_blueprint"));
    assert.ok(read && submit);
    assert.ok(tools.every(n => n.startsWith("evidence_") && !/shell|edit|webfetch|subagent|StructuredOutput/i.test(n)));
    if (toolMessages.some((m: { content: string }) => m.content.includes('"isError":true'))) throw new Error("MCP rejected fixture call");
    const candidate = { ...base, revision: base.revision + 1, parent: { revision: base.revision, contentHash: base.contentHash } };
    const call = toolMessages.length === 0 ? { name: read, args: {} } :
      toolMessages.length === 1 ? { name: submit, args: { baseHash: base.contentHash, submissionId: "protocol-once", blueprint: candidate } } : null;
    res.writeHead(200, { "content-type": "text/event-stream" });
    const emit = (delta: unknown, finish: string | null = null) => res.write(`data: ${JSON.stringify({ id: `chatcmpl-${turns}`, object: "chat.completion.chunk", created: 1, model: input.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
    if (call) { emit({ role: "assistant", tool_calls: [{ index: 0, id: `call-${turns}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args) } }] }); emit({}, "tool_calls"); }
    else { emit({ role: "assistant", content: "Candidate submitted for user review. No project code written." }); emit({}, "stop"); }
    res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 100 } })}\n\n`);
    res.end("data: [DONE]\n\n");
  } catch { res.writeHead(500); res.end(); }
});
await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
const localUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
const settings: ProviderSettings = { ...FREE_PROVIDER, ...(realModel ? {} : { baseUrl: localUrl, modelId: "protocol-fixture" }) };
const providers = new ProviderStore(path.join(root, "settings"), { read: async () => undefined, write: async () => { throw new Error("No real key used"); }, remove: async () => {} });
await providers.save({ settings });
const service = new AnalyzerService({ root, providers, evidence: { get: async () => safeSnapshot },
  binary: async () => path.resolve(".stage5a/tools/node_modules/opencode-windows-x64/bin/opencode.exe") });
try {
  await service.initialize();
  const capabilities = await service.testProvider();
  assert.equal(capabilities.toolCalling, "supported", capabilities.detail);
  const preview = await service.preview({ sessionId: base.source.sessionId, screenshots: false });
  const run = await service.start({ sessionId: base.source.sessionId, previewId: preview.id, expectedHash: base.contentHash });
  if (cancelMode) {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline && (await service.snapshot(base.source.sessionId)).runs[0]?.phase !== "analysis") await new Promise(r => setTimeout(r, 100));
    const canceled = await service.cancel(run.id);
    assert.equal(canceled?.phase, "canceled");
    assert.equal((await service.snapshot(base.source.sessionId)).blueprint.contentHash, base.contentHash);
    await assert.rejects(service.start({ sessionId: base.source.sessionId, previewId: preview.id, expectedHash: base.contentHash }));
    await mkdir(".stage5c/evidence", { recursive: true });
    await writeFile(".stage5c/evidence/cancel.json", JSON.stringify({ runtime: "1.18.29", actualRuntimeCancellation: "pass", previewTokenInvalidated: true,
      originalBlueprintRetained: true, result: canceled }, null, 2));
    console.log(JSON.stringify({ actualRuntimeCancellation: "pass", originalBlueprintRetained: true }));
  } else {
  const result = await service.wait(run.id);
  console.log(JSON.stringify(result));
  assert.equal(result?.phase, "review-ready");
  const reviewed = await service.snapshot(base.source.sessionId);
  assert.equal(reviewed.blueprint.revision, 2);
  assert.deepEqual(reviewed.blueprint.assertions.filter(a => a.confirmed), base.assertions.filter(a => a.confirmed));
  assert.equal(reviewed.flags.privacyReviewed, false);
  assert.equal(contractHash(safeSnapshot.blueprintV2), contractHash(base));
  const audit = await readFile(path.join(root, "agent-runs", run.id, "audit.jsonl"), "utf8");
  assert.ok(!/Bearer |apiKey|private-store|devtools\/browser/.test(audit));
  const receipt = { type: realModel ? "real-free-model-smoke" : "real-fixed-runtime-protocol", model: settings.modelId,
    runtime: "1.18.29", phase: result?.phase, confirmedAssertionsPreserved: true, originalEvidenceUnchanged: true,
    auditNoSecrets: true, tools: realModel ? "see bounded tool audit" : advertised, turns, result,
    notQualityEval: true };
  await mkdir(".stage5c/evidence", { recursive: true });
  await writeFile(path.resolve(".stage5c/evidence", realModel ? "real-model-smoke.json" : "protocol.json"), JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify(receipt));
  }
} finally { await service.dispose(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
