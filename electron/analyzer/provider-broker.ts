import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import type { ProviderCapabilities, ProviderSettings } from "../../common/analyzer";
import { contractHash } from "../evidence/blueprint-contract";
import type { SpendAuthorization } from "./spend-budget";

function compatibleBody(settings: ProviderSettings, body: Record<string, unknown>) {
  // The fixed compatible SDK does not replay DeepSeek reasoning_content. Only
  // the exact official endpoint uses its documented non-thinking tool mode.
  return new URL(settings.baseUrl).origin === "https://api.deepseek.com"
    ? { ...body, thinking: { type: "disabled" }, reasoning_effort: "none" } : body;
}
function upperCost(settings: ProviderSettings, inputTokens: number, outputTokens: number, cachedTokens = 0) {
  const cached = settings.inputCachedUsdPerMillion === undefined ? 0 : cachedTokens;
  return settings.pricing === "free" ? 0 : (inputTokens - cached) * (settings.inputUsdPerMillion ?? 0) / 1e6 +
    cached * (settings.inputCachedUsdPerMillion ?? 0) / 1e6 + outputTokens * (settings.outputUsdPerMillion ?? 0) / 1e6;
}
function cachedUsage(raw: Record<string, unknown>, total: number) {
  const details = raw.prompt_tokens_details as { cached_tokens?: unknown } | undefined;
  const value = raw.prompt_cache_hit_tokens ?? details?.cached_tokens;
  if (raw.prompt_cache_miss_tokens !== undefined && (typeof value !== "number" || typeof raw.prompt_cache_miss_tokens !== "number" ||
    !Number.isInteger(raw.prompt_cache_miss_tokens) || raw.prompt_cache_miss_tokens < 0 || value + raw.prompt_cache_miss_tokens !== total)) return 0;
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= total ? value : 0;
}

interface Usage { inputTokens: number; inputCachedTokens: number; outputTokens: number; costUsd: number | null; turns: number }
/** Fixed network broker: the model key remains outside OpenCode's config/cache,
 * and only the configured model's chat-completion endpoint is reachable here.
 * This is a scoped API boundary, NOT an OS sandbox. */
export class ProviderBroker {
  readonly token = randomBytes(32).toString("hex");
  readonly usage: Usage = { inputTokens: 0, inputCachedTokens: 0, outputTokens: 0, costUsd: null, turns: 0 };
  private server?: Server;
  private origin = "";
  private controller = new AbortController();
  private startedAt = Date.now();
  private active = true;
  private unknownUsage = false;
  constructor(private readonly settings: ProviderSettings, private readonly apiKey?: string,
    private readonly onLimit?: (category: string) => void, private readonly onUsage?: (usage: Usage) => Promise<void>,
    private readonly sanitizeMessages?: (text: string) => Promise<string>, private readonly spend?: SpendAuthorization) {}
  get url() { return `${this.origin}/v1`; }
  revoke() { this.active = false; this.controller.abort(); }
  async start() {
    this.server = createServer((req, res) => { void (async () => {
      let reservation: Awaited<ReturnType<SpendAuthorization["reserve"]>> | undefined;
      let requestCost: number | null = null;
      let observed: { prompt_tokens: number; completion_tokens: number; prompt_cache_hit_tokens: number } | undefined;
      try {
        if (!this.active || req.headers.authorization !== `Bearer ${this.token}` || req.headers.origin ||
          req.headers.host !== new URL(this.origin).host) { res.writeHead(401); return res.end(); }
        if (req.method !== "POST" || req.url !== "/v1/chat/completions") { res.writeHead(403); return res.end(); }
        const chunks: Buffer[] = []; let size = 0;
        for await (const chunk of req) { size += chunk.length; if (size > 1024 * 1024) throw new Error("quota"); chunks.push(chunk); }
        const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (input.model !== this.settings.modelId) throw new Error("model-scope");
        if (this.sanitizeMessages) {
          const scrub = async (value: unknown): Promise<unknown> => {
            if (typeof value === "string") return this.sanitizeMessages!(value);
            if (Array.isArray(value)) return Promise.all(value.map(scrub));
            if (value && typeof value === "object") return Object.fromEntries(await Promise.all(Object.entries(value).map(async ([k, v]) => [k, await scrub(v)])));
            return value;
          };
          input.messages = await scrub(input.messages);
        }
        // Cap requested output before forwarding; never let OpenCode's defaults
        // turn a user-selected free/limited analysis into an unbounded request.
        input.max_tokens = Math.min(Number(input.max_tokens) || 4096, 8192,
          this.settings.budget.maxTokens - this.usage.inputTokens - this.usage.outputTokens);
        if (input.stream) input.stream_options = { include_usage: true };
        const promptUpper = Buffer.byteLength(JSON.stringify(compatibleBody(this.settings, input))) + 64;
        input.max_tokens = Math.min(input.max_tokens, this.settings.budget.maxTokens - this.usage.inputTokens - this.usage.outputTokens - promptUpper);
        if (input.max_tokens < 1) throw new Error("quota");
        const serialized = JSON.stringify(compatibleBody(this.settings, input));
        const worst = this.checkBudget(Buffer.byteLength(serialized), input.max_tokens);
        reservation = await this.spend?.reserve(worst);
        this.usage.turns++;
        const captureUsage = (raw: unknown) => {
          if (!raw || typeof raw !== "object") return;
          const u = raw as Record<string, unknown>;
          // Provisional empty/null usage is not the final receipt. SSE may report
          // cumulative usage repeatedly: retain the last valid numeric receipt,
          // and account it exactly once only after the response completes.
          if (typeof u.prompt_tokens === "number" && Number.isFinite(u.prompt_tokens) && u.prompt_tokens >= 0 &&
            typeof u.completion_tokens === "number" && Number.isFinite(u.completion_tokens) && u.completion_tokens >= 0)
            observed = { prompt_tokens: u.prompt_tokens, completion_tokens: u.completion_tokens, prompt_cache_hit_tokens: cachedUsage(u, u.prompt_tokens) };
        };
        const response = await fetch(`${this.settings.baseUrl.replace(/\/$/, "")}/chat/completions`, {
          method: "POST", redirect: "error", headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey ?? "public"}` },
          body: serialized, signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(this.settings.budget.maxSeconds * 1000)]),
        });
        if (!response.ok) { await response.body?.cancel(); res.writeHead(502, { "content-type": "application/json" }); return res.end(JSON.stringify({ error: { message: `Provider HTTP ${response.status}; no private response body logged.` } })); }
        if (!response.body) throw new Error("no-body");
        res.writeHead(200, { "content-type": input.stream ? "text/event-stream" : "application/json", "cache-control": "no-store" });
        let received = 0, pending = "", all = "";
        const decoder = new TextDecoder();
        for await (const chunk of response.body) {
          received += chunk.length;
          if (received > 4 * 1024 * 1024 || !this.active) throw new Error("quota");
          const text = decoder.decode(chunk, { stream: true });
          if (input.stream) {
            pending += text;
            const lines = pending.split("\n"); pending = lines.pop() ?? "";
            for (const line of lines) if (line.startsWith("data:") && line.slice(5).trim() !== "[DONE]") {
              try { captureUsage(JSON.parse(line.slice(5).trim()).usage); } catch { /* partial/provider-specific frame; no raw logging */ }
            }
          } else all += text;
          res.write(chunk);
        }
        if (input.stream && pending.startsWith("data:") && pending.slice(5).trim() !== "[DONE]") { try { captureUsage(JSON.parse(pending.slice(5).trim()).usage); } catch { /* withheld */ } }
        if (!input.stream) { try { captureUsage(JSON.parse(all).usage); } catch { /* withheld */ } }
        if (observed) { const before = this.usage.costUsd ?? 0; this.observe(observed);
          if (!this.unknownUsage) requestCost = (this.usage.costUsd ?? 0) - before;
        } else this.unknownUsage = true;
        if (this.unknownUsage) this.onLimit?.("usage-unavailable");
        await this.onUsage?.({ ...this.usage });
        res.end();
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        const category = ["quota", "model-scope", "cost-limit"].includes(message) ? message :
          message.startsWith("Total authorized API spend") ? "aggregate-cost-limit" : "privacy-or-provider-failure";
        this.onLimit?.(category);
        if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "Provider request blocked by scope, time, usage, or network boundary." } }));
      } finally { try { await reservation?.settle(requestCost); } catch { this.revoke(); this.onLimit?.("aggregate-usage-limit"); } }
    })(); });
    this.server.requestTimeout = 15000;
    await new Promise<void>((resolve, reject) => this.server!.once("error", reject).listen(0, "127.0.0.1", resolve));
    this.origin = `http://127.0.0.1:${(this.server.address() as { port: number }).port}`;
  }
  async stop() { this.revoke(); this.server?.closeAllConnections(); if (this.server) await new Promise<void>(r => this.server!.close(() => r())); }
  private checkBudget(inputBytes: number, maxOutput: number) {
    const { budget, pricing } = this.settings;
    if (pricing === "unknown" || this.unknownUsage || this.usage.turns >= budget.maxTurns ||
      Date.now() - this.startedAt > budget.maxSeconds * 1000 ||
      this.usage.inputTokens + this.usage.outputTokens + inputBytes + maxOutput > budget.maxTokens) throw new Error("quota");
    // Byte count is a conservative upper bound for a UTF-8 prompt token budget;
    // include max output for pre-request cost authorization.
    // Include bounded image processing and wire/tool overhead conservatively.
    const worst = upperCost(this.settings, inputBytes + 65536, maxOutput);
    if (pricing === "metered") {
      if ((this.usage.costUsd ?? 0) + worst > budget.maxCostUsd) throw new Error("cost-limit");
    }
    return worst;
  }
  private observe(raw: unknown) {
    if (!raw || typeof raw !== "object") return;
    const u = raw as Record<string, unknown>;
    const input = Number(u.prompt_tokens), output = Number(u.completion_tokens);
    if (!Number.isFinite(input) || !Number.isFinite(output) || input < 0 || output < 0) { this.unknownUsage = true; return; }
    this.usage.inputTokens += input; this.usage.outputTokens += output;
    this.usage.inputCachedTokens += cachedUsage(u, input);
    this.usage.costUsd = upperCost(this.settings, this.usage.inputTokens, this.usage.outputTokens, this.usage.inputCachedTokens);
    if (this.usage.inputTokens + this.usage.outputTokens > this.settings.budget.maxTokens ||
      (this.usage.costUsd ?? 0) > this.settings.budget.maxCostUsd) { this.revoke(); this.onLimit?.("reported-usage-limit"); }
  }
}

async function completion(settings: ProviderSettings, key: string | undefined, body: Record<string, unknown>, spend?: SpendAuthorization): Promise<Record<string, unknown>> {
  const serialized = JSON.stringify(compatibleBody(settings, body));
  const worst = upperCost(settings, Buffer.byteLength(serialized) + 65536, Number(body.max_tokens));
  if (settings.pricing === "metered" && worst > settings.budget.maxCostUsd) throw new Error("Probe cost exceeds its authorized limit.");
  const reservation = await spend?.reserve(worst);
  let cost: number | null = null;
  try {
  const response = await fetch(`${settings.baseUrl.replace(/\/$/, "")}/chat/completions`, { method: "POST", redirect: "error",
    headers: { "content-type": "application/json", authorization: `Bearer ${key ?? "public"}` },
    body: serialized, signal: AbortSignal.timeout(45000) });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`Provider HTTP ${response.status}.`); }
  const text = await response.text(); if (Buffer.byteLength(text) > 65536) throw new Error("Provider probe response exceeds quota.");
  const result = JSON.parse(text);
  const input = result.usage?.prompt_tokens, output = result.usage?.completion_tokens;
  if (typeof input === "number" && typeof output === "number" && Number.isFinite(input) && Number.isFinite(output) && input >= 0 && output >= 0)
    cost = upperCost(settings, input, output, cachedUsage(result.usage, input));
  else if (settings.pricing === "metered") throw new Error("Probe usage missing; request counted at the reserved ceiling.");
  return result;
  } finally { await reservation?.settle(cost); }
}
/** Actual tool + structured argument probe, not a checkbox or inferred model name.
 * Vision stays unknown until an actual protected-image probe succeeds. */
export async function probeProvider(settings: ProviderSettings, key?: string, spend?: SpendAuthorization): Promise<ProviderCapabilities> {
  const result: ProviderCapabilities = { settingsHash: contractHash(settings), checkedAt: Date.now(),
    toolCalling: "unknown", structuredOutput: "unknown", vision: "unknown", detail: "Probe has not succeeded." };
  if (settings.pricing === "unknown" || settings.pricing === "metered" && settings.budget.maxCostUsd === 0)
    return { ...result, detail: "Explicit price and cost authorization required before a connection test." };
  const nonce = randomBytes(8).toString("hex");
  try {
    const response = await completion(settings, key, { model: settings.modelId, stream: false, max_tokens: 512, temperature: 0,
      messages: [{ role: "user", content: `Call flowcode_probe with the exact nonce ${nonce} and revision 1. This is synthetic capability data only.` }],
      tools: [{ type: "function", function: { name: "flowcode_probe", description: "Return synthetic capability data", parameters: { type: "object", properties: { nonce: { type: "string" }, revision: { type: "integer" } }, required: ["nonce", "revision"], additionalProperties: false } } }],
      tool_choice: { type: "function", function: { name: "flowcode_probe" } } }, spend);
    const choice = (response.choices as Array<{ message?: { tool_calls?: Array<{ function?: { name?: string; arguments?: string } }> } }>)?.[0];
    const call = choice?.message?.tool_calls?.[0]?.function;
    if (call?.name !== "flowcode_probe") return { ...result, toolCalling: "unsupported", detail: "Provider did not return the requested tool call." };
    result.toolCalling = "supported";
    const args = JSON.parse(call.arguments ?? "{}");
    result.structuredOutput = args.nonce === nonce && args.revision === 1 && Object.keys(args).length === 2 ? "supported" : "unsupported";
    result.detail = "Real synthetic tool/structured-argument probe completed. Vision unverified; analysis is text/recorded DOM only.";
    if (result.structuredOutput === "supported") {
      try {
        const colors = ["red", "blue", "green", "yellow"];
        for (let i = colors.length - 1; i > 0; i--) { const j = randomBytes(1)[0]! % (i + 1); [colors[i], colors[j]] = [colors[j]!, colors[i]!]; }
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64">${colors.map((color, i) => `<rect x="${i % 2 * 32}" y="${Math.floor(i / 2) * 32}" width="32" height="32" fill="${color}"/>`).join("")}</svg>`;
        const sharp = (await import("sharp")).default;
        const png = await sharp(Buffer.from(svg)).png().toBuffer();
        const vision = await completion(settings, key, { model: settings.modelId, stream: false, max_tokens: 128,
          messages: [{ role: "user", content: [{ type: "text", text: "Identify the solid colors of this image's four quadrants, ordered top-left, top-right, bottom-left, bottom-right. Return ONLY a JSON array of lowercase color names (red, blue, green, yellow). If you cannot see the image, say unavailable." },
            { type: "image_url", image_url: { url: `data:image/png;base64,${png.toString("base64")}` } }] }] }, spend);
        const answer = (vision.choices as Array<{ message?: { content?: string } }>)?.[0]?.message?.content ?? "";
        const decoded = JSON.parse(/\[[^\]]+\]/.exec(answer)?.[0] ?? "null");
        result.vision = JSON.stringify(decoded) === JSON.stringify(colors) ? "supported" : "unsupported";
        result.detail = `Actual tool, structured argument, and synthetic image probes completed. Vision: ${result.vision}. No recording or store data used.`;
      } catch { result.detail = "Actual tool/structured probe succeeded; synthetic image probe did not validate Vision. Image tools remain withheld."; }
    }
  } catch (e) { result.detail = e instanceof Error && /^Provider HTTP \d+\.$/.test(e.message) ? e.message : "Provider connection/tool probe failed; no credentials or private response body logged."; }
  return result;
}
