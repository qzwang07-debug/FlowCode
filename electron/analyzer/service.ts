import { randomUUID } from "node:crypto";
import { readFile, lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { AnalyzerStartSchema, AnalyzerPreviewRequestSchema, BlueprintEditRequestSchema,
  BlueprintCompareSchema, type BlueprintComparison,
  ANALYZER_PROMPT_VERSION, ANALYZER_SCHEMA_VERSION, type AnalyzerRun, type AnalyzerPreview,
  type AnalyzerSnapshot, type ProviderSettings } from "../../common/analyzer";
import { BrowserSourceIdentitySchema, type BrowserCapabilities } from "../../common/browser-environment";
import type { EvidenceReviewSnapshot } from "../../common/evidence";
import type { AutomationBlueprintV2 } from "../../common/blueprint-v2";
import type { FlowEvent } from "../../common/evidence";
import { sessionDir, sessionsRoot } from "../recorder/session-store";
import type { EvidenceService } from "../evidence/service";
import { contractHash, sealBlueprint } from "../evidence/blueprint-contract";
import { OcrFrameRedactor } from "../sensitive/frame-redact";
import type { Ocr } from "../sensitive/ocr";
import { scanSessionDirectory, scanSensitiveTexts } from "../sensitive/scanner";
import { OpenCodeService, analyzerConfig } from "../opencode/service";
import { ProviderStore } from "./provider-store";
import { ProviderBroker, probeProvider } from "./provider-broker";
import { AnalyzerRunStore } from "./run-store";
import { BlueprintRevisionStore, changedSteps, nextReviewVersion } from "./revision-store";
import { applyBlueprintEdit, generationPreflight, validateCandidate } from "./review";
import { createSafeEvidence, type SafeEvidence } from "./safe-evidence";
import { EvidenceMcp } from "./evidence-mcp";
import type { SpendAuthorization } from "./spend-budget";

interface Active { run: AnalyzerRun; scopeHash: string; canceled: boolean; failureCategory?: string; host?: OpenCodeService; mcp?: EvidenceMcp; broker?: ProviderBroker; task?: Promise<void> }
export interface AnalyzerServiceOptions {
  root: string; binary: () => Promise<string>; providers: ProviderStore;
  evidence: Pick<EvidenceService, "get">; emit?: (run: AnalyzerRun) => void;
  getOcr?: () => Ocr | null;
  getCapabilities?: (source: z.infer<typeof BrowserSourceIdentitySchema>) => Promise<BrowserCapabilities | null>;
  getEvents?: (sessionId: string, projectKind: AutomationBlueprintV2["projectKind"]) => Promise<readonly FlowEvent[]>;
  getPrivateValues?: (sessionId: string) => Promise<string[]>;
  getEnvironmentScope?: (sessionId: string) => Promise<string>;
  spendAuthorization?: SpendAuthorization;
}
export class AnalyzerService {
  private readonly runs: AnalyzerRunStore;
  private readonly active = new Map<string, Active>();
  private readonly previews = new Map<string, AnalyzerPreview>();
  private readonly queues = new Map<string, Promise<unknown>>();
  constructor(private readonly options: AnalyzerServiceOptions) { this.runs = new AnalyzerRunStore(path.join(options.root, "agent-runs")); }
  async initialize() { await this.runs.recover(); }
  providerView() { return this.options.providers.view(); }
  async saveProvider(raw: unknown) {
    if (this.active.size) throw new Error("Stop active analysis before changing model settings.");
    this.previews.clear(); return this.options.providers.save(raw);
  }
  async testProvider() {
    if (this.active.size) throw new Error("Stop active analysis before testing a provider.");
    const settings = await this.options.providers.settings();
    const result = await probeProvider(settings, await this.options.providers.credential(settings), this.options.spendAuthorization);
    await this.options.providers.setCapabilities(result); return result;
  }
  private async load(sessionId: string) {
    const directory = sessionDir(sessionId);
    const root = await realpath(sessionsRoot());
    const info = await lstat(directory);
    const canonical = await realpath(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || path.relative(root, canonical).startsWith("..") || path.isAbsolute(path.relative(root, canonical)))
      throw new Error("Recording directory is outside the trusted Session store.");
    for (const name of ["session.json", "events.jsonl", "browser-events.jsonl", "browser-clock.jsonl", "browser-gaps.jsonl", "browser-source.json", "browser-lease.json", "bundle.json", "narration.json", "blueprint-review.json"]) {
      const file = await lstat(path.join(directory, name)).catch(e => { if (e.code === "ENOENT") return null; throw e; });
      if (file?.isSymbolicLink() || file && !file.isFile()) throw new Error("Recording evidence must use owned regular files, not external links.");
    }
    const snapshot = await this.options.evidence.get(sessionId);
    if (!snapshot.session.stoppedAt) throw new Error("Stop recording before analysis or derived review.");
    if (!snapshot.blueprintV2) throw new Error("No versioned Blueprint is available.");
    const scopeHash = contractHash({ recordingLink: snapshot.session.link,
      provider: await this.options.providers.settings(), base: snapshot.blueprintV2.contentHash,
      environment: await this.options.getEnvironmentScope?.(sessionId) ?? "unbound-standard-browser",
      prompt: ANALYZER_PROMPT_VERSION, schema: ANALYZER_SCHEMA_VERSION,
      codeContext: "not-indexed-no-code-generation-confirmation-in-5c" });
    const store = new BlueprintRevisionStore(sessionDir(sessionId), scopeHash);
    let current = await store.current(snapshot.blueprintV2);
    const known = new Set(current.blueprint.evidenceRefs.map(ref => ref.reference));
    const indexed = [...new Set(snapshot.index.events?.map(e => e.eventId) ?? snapshot.index.timeline.map(t => t.eventId))];
    const missing = indexed.filter(id => !known.has(id));
    if (missing.length) {
      const bp = nextReviewVersion(current.blueprint);
      bp.evidenceRefs.push(...missing.map((reference, i) => ({ id: `analysis-context-${current.blueprint.revision}-${i + 1}`,
        kind: "event" as const, reference, sessionId, evidenceVersion: bp.source.evidenceVersion })));
      try {
        current = await store.append(snapshot.blueprintV2, { blueprint: sealBlueprint(bp), flags: current.flags,
          author: "deterministic", at: Date.now(), feedback: "Bind the authoritative evidence index (including desktop context) for read-only analysis. Raw events and the recorded Blueprint are unchanged.", changedStepIds: [] });
      } catch (error) {
        const latest = await store.current(snapshot.blueprintV2);
        if (!missing.every(id => latest.blueprint.evidenceRefs.some(ref => ref.reference === id))) throw error;
        current = latest;
      }
    }
    return { snapshot, store, current, scopeHash };
  }
  async snapshot(sessionId: string): Promise<AnalyzerSnapshot> {
    const { snapshot, store, current } = await this.load(sessionId);
    let capabilities: BrowserCapabilities | null = null;
    try {
      const source = BrowserSourceIdentitySchema.parse(JSON.parse(await readFile(path.join(sessionDir(sessionId), "browser-source.json"), "utf8")));
      if (source.sessionId === sessionId) capabilities = await this.options.getCapabilities?.(source) ?? null;
    } catch { /* No evidence-backed profile: keep capability unknown, not supported. */ }
    const locatorStatus: Record<string, "unique" | "non-unique" | "unknown"> = {};
    const locatorOwners = [...current.blueprint.steps, ...current.blueprint.assertions.map(a => ({ ...a,
      evidenceRefs: [...a.evidenceRefs, ...current.blueprint.steps.filter(s => s.id === a.afterStepId || s.id === a.beforeStepId).flatMap(s => s.evidenceRefs)] }))];
    for (const step of locatorOwners) {
      const references = step.evidenceRefs.map(id => current.blueprint.evidenceRefs.find(e => e.id === id)?.reference);
      const candidates = snapshot.index.timeline.filter(t => references.includes(t.eventId)).flatMap(t => t.locatorCandidates);
      const chosen = step.target;
      const value = chosen?.kind === "role" ? `${chosen.role}|${chosen.name ?? ""}` : chosen?.kind === "css" ? chosen.selector : chosen?.value;
      const match = candidates.find(c => c.kind === chosen?.kind && c.value === value);
      locatorStatus[step.id] = match ? match.unique ? "unique" : "non-unique" : "unknown";
    }
    const history = [current.author === "deterministic" ? current : { blueprint: snapshot.blueprintV2!, author: "deterministic" as const, at: 0, feedback: "", changedStepIds: [] }, ...(await store.list(snapshot.blueprintV2!))]
      .map(r => ({ revision: r.blueprint.revision, contentHash: r.blueprint.contentHash, author: r.author, at: r.at, feedback: r.feedback, changedStepIds: r.changedStepIds }));
    return { blueprint: current.blueprint, flags: current.flags,
      preflight: generationPreflight(current.blueprint, { recordingGaps: snapshot.index.gaps.length, locatorStatus, capabilities, flags: current.flags, existingTarget: Boolean(snapshot.session.link.targetId) }),
      history, runs: await this.runs.list(sessionId) };
  }
  async compare(raw: unknown): Promise<BlueprintComparison> {
    const input = BlueprintCompareSchema.parse(raw);
    const { snapshot, current, store } = await this.load(input.sessionId);
    const before = input.priorHash === snapshot.blueprintV2!.contentHash ? snapshot.blueprintV2! :
      (await store.list(snapshot.blueprintV2!)).find(r => r.blueprint.contentHash === input.priorHash)?.blueprint;
    if (!before) throw new Error("The requested prior version is outside this recording/evidence branch.");
    const after = current.blueprint;
    const differences: BlueprintComparison["differences"] = [];
    const add = (field: string, a: unknown, b: unknown) => {
      if (contractHash(a ?? null) !== contractHash(b ?? null)) differences.push({ field, before: JSON.stringify(a ?? null, null, 2), after: JSON.stringify(b ?? null, null, 2) });
    };
    add("intent", before.intent, after.intent);
    for (const id of new Set([...before.steps, ...after.steps].map(s => s.id))) add(`step:${id}`, before.steps.find(s => s.id === id), after.steps.find(s => s.id === id));
    add("assertions", before.assertions, after.assertions); add("variables", before.variables, after.variables);
    return { beforeRevision: before.revision, afterRevision: after.revision, differences };
  }
  edit(raw: unknown) {
    const input = BlueprintEditRequestSchema.parse(raw);
    return this.enqueue(input.sessionId, async () => {
      if ([...this.active.values()].some(a => a.run.sessionId === input.sessionId)) throw new Error("Stop analysis before editing its base review.");
      const { snapshot, store, current } = await this.load(input.sessionId);
      if (input.expectedHash !== current.blueprint.contentHash) throw new Error("Review changed; reload before saving.");
      const bp = input.edit ? applyBlueprintEdit(current.blueprint, input.edit) : nextReviewVersion(current.blueprint);
      const feedback = input.feedback ?? "";
      if ((await scanSensitiveTexts([JSON.stringify(bp), feedback])).values.length) throw new Error("Replace sensitive values with typed variables before saving this revision.");
      const flags = input.flags ?? { ...current.flags,
        intentConfirmed: input.edit?.kind === "intent" ? false : current.flags.intentConfirmed,
        privacyReviewed: false, approvedVariableIds: [], approvedManualStepIds: [] };
      if (flags.approvedVariableIds.some(id => !bp.variables.some(v => v.id === id)) || flags.approvedManualStepIds.some(id => !bp.steps.some(s => s.id === id && s.handling === "manual")))
        throw new Error("Review decision references an unknown variable or manual step.");
      await store.append(snapshot.blueprintV2!, { blueprint: bp, flags, author: "user", at: Date.now(), feedback, changedStepIds: changedSteps(current.blueprint, bp) });
      this.invalidatePreviews(input.sessionId);
      return this.snapshot(input.sessionId);
    });
  }
  private async safe(snapshot: EvidenceReviewSnapshot, blueprint: AutomationBlueprintV2): Promise<SafeEvidence> {
    const scanned = await scanSessionDirectory(sessionDir(snapshot.session.id), snapshot.session.id);
    const projectId = snapshot.session.link.projectId ?? "analysis-only";
    return createSafeEvidence({ blueprint, timeline: snapshot.index.timeline, startedAt: snapshot.session.startedAt,
      sensitiveValues: [...scanned.values, ...(await this.options.getPrivateValues?.(snapshot.session.id) ?? [])], events: await this.options.getEvents?.(snapshot.session.id, blueprint.projectKind), projectContext: { schemaVersion: 1, status: "unavailable", projectId,
        ...(snapshot.session.link.targetId ? { targetId: snapshot.session.link.targetId } : {}), reason: "not-indexed", readOnly: true } });
  }
  async preview(raw: unknown): Promise<AnalyzerPreview> {
    const input = AnalyzerPreviewRequestSchema.parse(raw);
    const { snapshot, current, scopeHash } = await this.load(input.sessionId);
    const safe = await this.safe(snapshot, current.blueprint);
    const feedback = input.feedback ? await safe.redact(input.feedback) : "";
    const feedbackFindings = input.feedback ? await scanSensitiveTexts([input.feedback]) : { values: [] };
    const view = await this.options.providers.view();
    const screenshots = input.screenshots && view.capabilities?.vision === "supported" && Boolean(this.options.getOcr?.());
    const preview: AnalyzerPreview = { id: randomUUID(), sessionId: input.sessionId,
      blueprintHash: current.blueprint.contentHash, settingsHash: contractHash(view.settings),
      feedbackHash: contractHash(input.feedback ?? ""),
      scopeHash,
      categories: ["sanitized timeline", "logical browser actions and Locators", "typed variables", "user assertion markers", "Blueprint v2", "read-only ProjectContext capability status", ...(feedback ? ["sanitized human revision feedback"] : []), ...(screenshots ? ["OCR-protected screenshots (at most 2)"] : [])],
      redactionCount: safe.redactionCount + feedbackFindings.values.length, screenshots, visionDegraded: view.capabilities?.vision !== "supported" || input.screenshots && !this.options.getOcr?.(),
      expiresAt: Date.now() + 5 * 60 * 1000, sample: JSON.stringify({ timeline: safe.timeline.slice(0, 3), feedback }, null, 2).slice(0, 6000),
      tools: new EvidenceMcp({ data: safe, screenshots: screenshots ? new Map([["protected-preview-image", async () => null]]) : undefined,
        onSubmit: async b => b, audit: async () => {} }).tools().map(t => t.name) };
    // Bound memory; preview is a one-use authorization, not a global opt-in.
    for (const [id, p] of this.previews) if (p.expiresAt < Date.now() || p.sessionId === input.sessionId) this.previews.delete(id);
    if (this.previews.size >= 20) this.previews.delete(this.previews.keys().next().value!);
    this.previews.set(preview.id, preview); return preview;
  }
  start(raw: unknown): Promise<AnalyzerRun> {
    const input = AnalyzerStartSchema.parse(raw);
    return this.enqueue(input.sessionId, async () => {
      if ([...this.active.values()].some(a => a.run.sessionId === input.sessionId)) throw new Error("Analysis is already running for this recording.");
      const preview = this.previews.get(input.previewId);
      this.previews.delete(input.previewId);
      const settings = await this.options.providers.view();
      const { snapshot, current, scopeHash } = await this.load(input.sessionId);
      if (!preview || preview.sessionId !== input.sessionId || preview.expiresAt < Date.now() ||
        preview.blueprintHash !== input.expectedHash || current.blueprint.contentHash !== input.expectedHash ||
        preview.feedbackHash !== contractHash(input.feedback ?? "") ||
        preview.scopeHash !== scopeHash ||
        preview.settingsHash !== contractHash(settings.settings)) throw new Error("Model data preview expired or its Blueprint/provider changed. Preview and authorize again.");
      if (settings.capabilities?.toolCalling !== "supported" || settings.capabilities.structuredOutput !== "supported")
        throw new Error("Run a successful Tool Calling / structured submission connection test first.");
      if (settings.settings.pricing === "unknown") throw new Error("Unknown pricing cannot satisfy the analysis cost limit.");
      const safe = await this.safe(snapshot, current.blueprint);
      const feedback = input.feedback ? await safe.redact(input.feedback) : "";
      const run: AnalyzerRun = { schemaVersion: 1, id: randomUUID(), sessionId: input.sessionId, phase: "preparing", startedAt: Date.now(),
        provider: settings.settings.providerId, model: settings.settings.modelId, promptVersion: ANALYZER_PROMPT_VERSION, schemaVersionName: ANALYZER_SCHEMA_VERSION,
        baseHash: current.blueprint.contentHash, settingsHash: contractHash(settings.settings) };
      await this.runs.status(run);
      const active: Active = { run, scopeHash, canceled: false }; this.active.set(run.id, active);
      this.options.emit?.(run);
      active.task = this.execute(active, settings.settings, safe, snapshot, current.flags.intentConfirmed, preview.screenshots, feedback);
      return run;
    });
  }
  async cancel(runId: string) {
    z.uuid().parse(runId); const active = this.active.get(runId);
    if (!active) return this.runs.read(runId);
    active.canceled = true; active.mcp?.revoke(); active.broker?.revoke();
    await active.host?.cancel(); await active.task;
    return this.runs.read(runId);
  }
  async revoke(sessionId: string) {
    this.invalidatePreviews(sessionId);
    for (const [id, active] of this.active) if (active.run.sessionId === sessionId) await this.cancel(id);
  }
  async dispose() { this.previews.clear(); await Promise.all([...this.active.keys()].map(id => this.cancel(id))); }
  async wait(runId: string) { await this.active.get(runId)?.task; return this.runs.read(runId); }
  private async execute(active: Active, settings: ProviderSettings, safe: SafeEvidence, snapshot: EvidenceReviewSnapshot,
    intentConfirmed: boolean, imagesAllowed: boolean, feedback: string) {
    let candidate: AutomationBlueprintV2 | undefined;
    const timer = setTimeout(() => { active.canceled = true; active.mcp?.revoke(); active.broker?.revoke(); void active.host?.cancel(); }, settings.budget.maxSeconds * 1000);
    try {
      const images = new Map<string, () => Promise<Buffer | null>>();
      if (imagesAllowed) {
        const dir = await realpath(sessionDir(snapshot.session.id));
        const redactor = new OcrFrameRedactor({ ocr: this.options.getOcr?.() ?? null, knownValues: [...safe.knownValues] });
        for (const [index, ref] of [...new Set(snapshot.index.timeline.flatMap(t => t.screenshotRefs))].slice(0, 2).entries()) images.set(`image-${index + 1}`, async () => {
          const candidate = path.resolve(dir, ref);
          const meta = await lstat(candidate).catch(() => null);
          const canonical = meta?.isFile() && !meta.isSymbolicLink() ? await realpath(candidate) : null;
          if (!canonical || path.relative(dir, canonical).startsWith("..") || path.isAbsolute(path.relative(dir, canonical))) return null;
          return redactor.redactFrame(canonical);
        });
      }
      const mcp = new EvidenceMcp({ data: safe, intentConfirmed, screenshots: images, maxSeconds: settings.budget.maxSeconds,
        audit: e => this.runs.append(active.run.id, "evidence-tool", e),
        onSubmit: bp => this.enqueue(active.run.sessionId, async () => {
          if (active.canceled) throw new Error("Analysis revoked.");
          const { current, store, snapshot: fresh, scopeHash } = await this.load(active.run.sessionId);
          if (current.blueprint.contentHash !== active.run.baseHash) throw new Error("Analysis base changed; candidate rejected.");
          if (scopeHash !== active.scopeHash) throw new Error("Authorization environment changed; candidate rejected.");
          // Revalidate against the PRIVATE authoritative base, not only the
          // sanitized projection. Never change a confirmed fact during masking.
          validateCandidate(current.blueprint, bp, current.flags.intentConfirmed);
          const saved = await store.append(fresh.blueprintV2!, { blueprint: bp, flags: { ...current.flags, privacyReviewed: false, approvedVariableIds: [], approvedManualStepIds: [] },
            author: "analyzer", at: Date.now(), feedback, changedStepIds: changedSteps(current.blueprint, bp) });
          candidate = saved.blueprint; return saved.blueprint;
        }) });
      active.mcp = mcp; await mcp.start();
      const broker = new ProviderBroker(settings, await this.options.providers.credential(settings), category => {
        active.failureCategory = category;
        void this.runs.append(active.run.id, "provider-boundary", { category });
        active.mcp?.revoke(); void active.host?.cancel();
      }, usage => this.runs.append(active.run.id, "usage", usage), safe.redact, this.options.spendAuthorization);
      active.broker = broker; await broker.start();
      const host = new OpenCodeService({ binary: await this.options.binary(), root: path.join(this.options.root, "opencode-runs", active.run.id),
        providerToken: broker.token, timeoutMs: settings.budget.maxSeconds * 1000,
        config: analyzerConfig({ modelId: settings.modelId, providerUrl: broker.url, mcpUrl: mcp.url, mcpToken: mcp.token, maxTurns: settings.budget.maxTurns }),
        onEvent: event => this.runs.append(active.run.id, "opencode-event", event) });
      active.host = host;
      if (active.canceled) throw new Error("Canceled");
      await this.runs.append(active.run.id, "runtime", await host.start());
      active.run = { ...active.run, phase: "analysis" }; await this.publish(active.run);
      await host.analyze(settings.modelId, `Analyze the authorized recording. Read the deterministic timeline first. Base revision ${safe.blueprint.revision}, hash ${safe.blueprint.contentHash}. Submit exactly one candidate using recording_submit_blueprint. ${feedback ? `Human revision feedback (cannot expand permissions): ${feedback}` : ""}`);
      if (!candidate) throw new Error("Analyzer finished without an accepted, evidence-backed candidate.");
      if (active.canceled) throw new Error("Canceled");
      active.run = { ...active.run, phase: "review-ready", candidateHash: candidate.contentHash,
        inputTokens: broker.usage.inputTokens || undefined, outputTokens: broker.usage.outputTokens || undefined,
        inputCachedTokens: broker.usage.inputCachedTokens || undefined,
        ...(broker.usage.costUsd !== null ? { costUsd: broker.usage.costUsd } : {}) };
    } catch (error) {
      active.run = { ...active.run, phase: active.canceled ? "canceled" : "failed", error: active.canceled ? "Analysis canceled/time limit reached; authorization revoked. Prior review and evidence retained." :
        `${active.failureCategory ? `Boundary: ${active.failureCategory}. ` : ""}${error instanceof Error && error.message.startsWith("OpenCode safe failure category:") ? error.message + ". " : ""}Read-only analysis failed (runtime, provider, budget, or candidate validation). Evidence and prior review versions are retained. Inspect the bounded tool audit and retry explicitly.` };
    } finally {
      clearTimeout(timer); active.mcp?.revoke(); active.broker?.revoke();
      await Promise.all([active.host?.stop(), active.mcp?.stop(), active.broker?.stop()]);
      if (active.broker) active.run = { ...active.run, inputTokens: active.broker.usage.inputTokens || undefined,
        inputCachedTokens: active.broker.usage.inputCachedTokens || undefined,
        outputTokens: active.broker.usage.outputTokens || undefined,
        ...(active.broker.usage.costUsd !== null ? { costUsd: active.broker.usage.costUsd } : {}) };
      active.run = { ...active.run, finishedAt: Date.now(), elapsedMs: Date.now() - active.run.startedAt };
      await this.publish(active.run); this.active.delete(active.run.id);
    }
  }
  private async publish(run: AnalyzerRun) { await this.runs.status(run); this.options.emit?.(run); }
  private invalidatePreviews(sessionId: string) { for (const [id, p] of this.previews) if (p.sessionId === sessionId) this.previews.delete(id); }
  private enqueue<T>(id: string, action: () => Promise<T>): Promise<T> {
    const next = (this.queues.get(id) ?? Promise.resolve()).then(action, action); this.queues.set(id, next.catch(() => {})); return next;
  }
}
