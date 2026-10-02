import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { BlueprintV2Shape, type AutomationBlueprintV2 } from "../../common/blueprint-v2";
import { ContractIdSchema } from "../../common/execution-primitives";
import { sealBlueprint } from "../evidence/blueprint-contract";
import type { SafeEvidence } from "./safe-evidence";
import { validateCandidate } from "./review";

const Query = z.object({ offset: z.number().int().min(0).max(10000).default(0),
  limit: z.number().int().min(1).max(100).default(40), startMs: z.number().nonnegative().default(0),
  endMs: z.number().nonnegative().optional() }).strict().refine(q => q.endMs === undefined ||
    (q.endMs >= q.startMs && q.endMs - q.startMs <= 120000), "Time window exceeds 120 seconds.");
const Empty = z.object({}).strict();
const Collection = z.object({ section: z.enum(["steps", "cleanup", "pages", "frames", "variables", "preconditions", "assertions", "results", "evidenceRefs", "gaps"]),
  offset: z.number().int().min(0).max(20000).default(0), limit: z.number().int().min(1).max(100).default(40) }).strict();
const Step = z.object({ stepId: z.string().max(128) }).strict();
const Image = z.object({ imageId: z.string().max(128) }).strict();
const CandidatePatch = z.object({
  intent: z.string().trim().min(1).max(4096).optional(),
  stepDescriptions: z.array(z.object({ stepId: ContractIdSchema, description: z.string().trim().min(1).max(4096) }).strict()).max(100).optional(),
  desktopGroups: z.array(z.object({ id: ContractIdSchema, description: z.string().trim().min(1).max(4096), evidenceRefs: z.array(ContractIdSchema).min(1).max(100) }).strict()).max(100).optional(),
}).strict();
const Submit = z.object({ baseHash: z.string().regex(/^[a-f0-9]{64}$/),
  submissionId: z.string().min(1).max(128), blueprint: BlueprintV2Shape.optional(), patch: CandidatePatch.optional() }).strict()
  .refine(s => Boolean(s.blueprint) !== Boolean(s.patch), "Submit exactly one full Blueprint or compact candidate patch.");
const Rpc = z.object({ jsonrpc: z.literal("2.0"), id: z.union([z.string().max(128), z.number()]).optional(),
  method: z.string().max(128), params: z.unknown().optional() }).strict();
type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: "image/jpeg" };
type Result = { content: Content[]; isError: boolean };

export class EvidenceMcp {
  readonly token = randomBytes(32).toString("hex");
  private server?: Server;
  private origin = "";
  private active = true;
  private calls = 0;
  private bytes = 0;
  private images = 0;
  private readonly startedAt = Date.now();
  private submitted?: { id: string; result: AutomationBlueprintV2 };
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private readonly options: { data: SafeEvidence; intentConfirmed?: boolean;
    screenshots?: ReadonlyMap<string, () => Promise<Buffer | null>>;
    onSubmit: (bp: AutomationBlueprintV2) => Promise<AutomationBlueprintV2>;
    audit: (entry: { tool: string; outcome: string; bytes: number }) => Promise<void>;
    maxSeconds?: number }) {}
  get url() { return `${this.origin}/mcp`; }
  revoke() { this.active = false; }
  tools() {
    const list = [
      ["recording_get_timeline", "Read the deterministic, paginated timeline first.", Query],
      ["recording_get_blueprint", "Read one bounded Blueprint collection when the base document requires pagination.", Collection],
      ["recording_get_events", "Read bounded sanitized event summaries, not raw payloads.", Query],
      ["recording_get_browser_actions", "Read logical browser steps and stable Locators.", Query],
      ["recording_get_step", "Read one evidence-backed step by logical ID.", Step],
      ["recording_get_dom_summary", "Read minimal recorded target/Locator summaries; no live DOM access.", Step],
      ["recording_get_assertion_markers", "Read bounded user assertions and explicit execution anchors.", Query],
      ["project_get_context", "Read ONLY the bound target context. not-indexed means no precise existing-target alignment.", Empty],
      ["recording_submit_blueprint", "Submit a candidate against the exact base hash. Never confirms assertions or writes project code.", Submit],
    ] as const;
    const tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown>; annotations: { readOnlyHint: boolean; destructiveHint: boolean; openWorldHint: boolean } }> = list.map(([name, description, schema]) => ({ name, description,
      inputSchema: z.toJSONSchema(schema, { unrepresentable: "any", io: "input" }), annotations: { readOnlyHint: name !== "recording_submit_blueprint", destructiveHint: false, openWorldHint: false } }));
    if (this.options.screenshots?.size) tools.push({ name: "recording_get_screenshot", description: "Read a user-approved OCR-protected image by opaque image ID.",
      inputSchema: z.toJSONSchema(Image), annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } });
    return tools;
  }
  async start() {
    this.server = createServer((req, res) => { void this.handle(req, res); });
    this.server.requestTimeout = 15000;
    this.server.headersTimeout = 10000;
    await new Promise<void>((resolve, reject) => this.server!.once("error", reject).listen(0, "127.0.0.1", resolve));
    this.origin = `http://127.0.0.1:${(this.server.address() as { port: number }).port}`;
  }
  async stop() {
    this.revoke(); this.server?.closeAllConnections();
    if (this.server) await new Promise<void>(resolve => this.server!.close(() => resolve()));
  }
  call(name: string, args: unknown): Promise<Result> {
    const execute = () => this.callUnlocked(name, args);
    const result = this.tail.then(execute, execute);
    this.tail = result.catch(() => {}); return result;
  }
  private async callUnlocked(name: string, args: unknown): Promise<Result> {
    let byteCount = 0;
    try {
      if (!this.active || Date.now() - this.startedAt > (this.options.maxSeconds ?? 300) * 1000 || ++this.calls > 100)
        throw new Error("Evidence authorization expired or exceeded the run quota.");
      if (!this.tools().some(tool => tool.name === name)) throw new Error("Tool unavailable at the authorized Standard evidence level.");
      const data = this.options.data;
      const inWindow = (references: readonly string[], start: number, end: number) => references.some(id => {
        const eventId = data.blueprint.evidenceRefs.find(r => r.id === id)?.reference;
        return data.events.some(e => e.id === eventId && e.atMs >= start && e.atMs <= end);
      });
      let value: unknown;
      let image: Buffer | null = null;
      if (["recording_get_timeline", "recording_get_events", "recording_get_browser_actions"].includes(name)) {
        const q = Query.parse(args); const end = q.endMs ?? q.startMs + 120000;
        const rows = name === "recording_get_browser_actions" ? data.blueprint.steps.filter(s =>
          data.timeline.some(t => t.relatedStepId === s.id && t.atMs >= q.startMs && t.atMs <= end) || inWindow(s.evidenceRefs, q.startMs, end)) :
          (name === "recording_get_events" && data.events.length ? data.events : data.timeline).filter(t => t.atMs >= q.startMs && t.atMs <= end);
        const large = ["steps", "cleanup", "pages", "frames", "variables", "preconditions", "assertions", "results", "evidenceRefs", "gaps"].some(k => (data.blueprint[k as keyof AutomationBlueprintV2] as unknown[])?.length > 100);
        const { steps: _steps, cleanup: _cleanup, pages: _pages, frames: _frames, variables: _variables, preconditions: _preconditions,
          assertions: _assertions, results: _results, evidenceRefs: _evidence, gaps: _gaps, ...metadata } = data.blueprint;
        value = { items: rows.slice(q.offset, q.offset + q.limit), total: rows.length,
          nextOffset: q.offset + q.limit < rows.length ? q.offset + q.limit : null,
          ...(name === "recording_get_timeline" ? { blueprint: large ? metadata : data.blueprint, paginatedBlueprint: large,
            imageIds: [...(this.options.screenshots?.keys() ?? [])] } : {}) };
      } else if (name === "recording_get_blueprint") {
        const q = Collection.parse(args); const rows = data.blueprint[q.section];
        value = { section: q.section, items: rows.slice(q.offset, q.offset + q.limit), total: rows.length,
          nextOffset: q.offset + q.limit < rows.length ? q.offset + q.limit : null };
      } else if (name === "recording_get_step" || name === "recording_get_dom_summary") {
        const step = data.blueprint.steps.find(s => s.id === Step.parse(args).stepId);
        if (!step) throw new Error("Step is outside the bound Blueprint.");
        value = name === "recording_get_step" ? step : { status: "recorded-summary", target: step.target ?? null, pageRef: step.pageRef ?? null, frameRef: step.frameRef ?? null };
      } else if (name === "project_get_context") { Empty.parse(args); value = data.projectContext; }
      else if (name === "recording_get_assertion_markers") {
        const q = Query.parse(args), end = q.endMs ?? q.startMs + 120000;
        const rows = data.blueprint.assertions.filter(a => inWindow(a.evidenceRefs, q.startMs, end));
        value = { items: rows.slice(q.offset, q.offset + q.limit), total: rows.length,
          nextOffset: q.offset + q.limit < rows.length ? q.offset + q.limit : null };
      }
      else if (name === "recording_get_screenshot") {
        const id = Image.parse(args).imageId;
        if (++this.images > 2) throw new Error("Image quota exceeded.");
        image = await this.options.screenshots?.get(id)?.() ?? null;
        if (!image || image.length > 256 * 1024) throw new Error("Protected image unavailable or exceeds quota; raw pixels are withheld.");
      } else if (name === "recording_submit_blueprint") {
        const submission = Submit.parse(args);
        if (submission.baseHash !== data.blueprint.contentHash) throw new Error("Stale Blueprint base.");
        if (this.submitted) {
          if (this.submitted.id !== submission.submissionId) throw new Error("A candidate was already submitted; start an explicit feedback revision.");
          value = { revision: this.submitted.result.revision, contentHash: this.submitted.result.contentHash, duplicate: true };
        } else {
          let candidate = submission.blueprint;
          if (submission.patch) {
            const patch = submission.patch;
            candidate = structuredClone(data.blueprint);
            if (patch.intent) candidate.intent = patch.intent;
            for (const description of patch.stepDescriptions ?? []) {
              const step = candidate.steps.find(s => s.id === description.stepId);
              if (!step) throw new Error("Unknown step description reference.");
              step.description = description.description;
            }
            if (patch.desktopGroups) {
              if (candidate.steps.length || candidate.pages.length || candidate.assertions.length)
                throw new Error("Desktop grouping is only available when no browser execution steps or assertions exist.");
              for (const group of patch.desktopGroups) {
                const min = data.events.reduce((n, e) => Math.min(n, e.atMs), Infinity), max = data.events.reduce((n, e) => Math.max(n, e.atMs), -Infinity);
                const controls = group.evidenceRefs.filter(id => {
                  const reference = candidate!.evidenceRefs.find(r => r.id === id)?.reference;
                  const event = data.events.find(e => e.id === reference);
                  // Legacy recorder opening/closing its own capture window is
                  // source metadata, not task grounding. Keep the raw refs and
                  // events; reject their use as a business operation's evidence.
                  return event?.type === "app.activate" && event.payload.app === "Skill Recorder" && event.payload.title === "Skill Recorder" &&
                    (event.atMs === min || event.atMs === max);
                });
                if (controls.length) throw new Error(`Candidate includes recorder-control refs: ${controls.slice(0, 3).join(", ")}. Omit them from task groups; raw metadata is retained.`);
                candidate.steps.push({ ...group, action: "manual", handling: "manual", contextStatus: "unresolved", outputs: [] });
                candidate.gaps.push({ id: `desktop-context-${group.id}`, ownerId: group.id, field: "context",
                  reason: "Desktop analysis group has no recorded logical browser page/frame execution context. Manual review required." });
              }
            }
            candidate.revision = data.blueprint.revision + 1;
            candidate.parent = { revision: data.blueprint.revision, contentHash: data.blueprint.contentHash };
            candidate = sealBlueprint(candidate);
          }
          const checked = validateCandidate(data.blueprint, candidate, this.options.intentConfirmed);
          // Candidate text is not trusted. Do not silently mask a semantically different
          // assertion or accept model-invented sensitive values.
          // The new content hash was computed by the host, not supplied by the
          // model. Scan all data fields, without masking digits inside this hash.
          const { contentHash: _validatedHash, ...candidateData } = checked;
          const serialized = JSON.stringify(candidateData);
          if (await data.redact(serialized) !== serialized) throw new Error("Candidate contains sensitive or private local metadata.");
          if (!this.active) throw new Error("Authorization revoked.");
          const saved = await this.options.onSubmit(checked);
          this.submitted = { id: submission.submissionId, result: saved };
          value = { revision: saved.revision, contentHash: saved.contentHash, candidate: true };
        }
      }
      const text = await data.redact(JSON.stringify({ trust: "untrusted-evidence", data: value ?? null }));
      byteCount = image ? image.length : Buffer.byteLength(text);
      this.bytes += byteCount;
      if (byteCount > 512 * 1024 || this.bytes > 2 * 1024 * 1024 || !this.active) throw new Error("Evidence byte quota exceeded or authorization revoked.");
      await this.options.audit({ tool: name, outcome: "allowed", bytes: byteCount });
      return { isError: false, content: image ? [{ type: "image", mimeType: "image/jpeg", data: image.toString("base64") }] : [{ type: "text", text }] };
    } catch (error) {
      await this.options.audit({ tool: this.tools().some(t => t.name === name) ? name : "unknown-tool", outcome: "denied", bytes: byteCount });
      const detail = error instanceof z.ZodError ? error.issues.slice(0, 8).map(issue => ({
        field: issue.path.filter(part => typeof part === "number" || /^[A-Za-z][A-Za-z0-9_-]{0,64}$/.test(String(part))).join("."),
        code: issue.code, ...(issue.code === "custom" ? { message: issue.message.slice(0, 200) } : {}),
      })) : error instanceof Error && /^(Candidate|Confirmed|An Analyzer|Evidence gaps|Analysis steps|Stale Blueprint|Step is outside|A candidate|Authorization|Upload|Unknown|Page|Frame|Variable)/.test(error.message)
        ? error.message.slice(0, 200) : "Invalid scope, privacy authorization, base revision, or quota.";
      return { isError: true, content: [{ type: "text", text: JSON.stringify({ rejected: true, detail, noRawDataReturned: true }) }] };
    }
  }
  private async handle(req: IncomingMessage, res: ServerResponse) {
    const json = (status: number, value: unknown) => { res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" }); res.end(JSON.stringify(value)); };
    try {
      const expected = Buffer.from(`Bearer ${this.token}`), actual = Buffer.from(req.headers.authorization ?? "");
      if (!this.active || actual.length !== expected.length || !timingSafeEqual(actual, expected)) return json(401, { error: "unauthorized" });
      if (req.headers.origin || req.headers.host !== new URL(this.origin).host || req.url !== "/mcp") return json(403, { error: "origin/scope rejected" });
      if (req.method !== "POST") return json(405, { error: "method unavailable" });
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > 1024 * 1024) return json(413, { error: "quota" }); chunks.push(chunk); }
      const rpc = Rpc.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      if (rpc.id === undefined) { res.writeHead(202); return res.end(); }
      let result: unknown;
      if (rpc.method === "initialize") result = { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "flowcode-evidence", version: "5c.1" } };
      else if (rpc.method === "ping") result = {};
      else if (rpc.method === "tools/list") result = { tools: this.tools() };
      else if (rpc.method === "tools/call") {
        const input = z.object({ name: z.string().max(128), arguments: z.unknown(), _meta: z.record(z.string(), z.unknown()).optional() }).strict().parse(rpc.params);
        result = await this.call(input.name, input.arguments);
      } else return json(200, { jsonrpc: "2.0", id: rpc.id, error: { code: -32601, message: "Method unavailable" } });
      json(200, { jsonrpc: "2.0", id: rpc.id, result });
    } catch { json(400, { error: "invalid bounded MCP request" }); }
  }
}
