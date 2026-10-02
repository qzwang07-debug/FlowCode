// Test-only Codex subscription evaluation for the legacy Scout Automation Builder.
// It substitutes Codex app-server's model loop for the Copilot SDK, while forwarding
// get_analysis, get_timeline and propose_automation_plan to their production handlers.
// It never executes a Scout automation or a real business action.

import { createHash } from "node:crypto";
import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";

import { AutomationBuilder, AUTOMATION_BUILDER_KICKOFF_PROMPT } from "../../electron/automationbuilder/builder";
import { AUTOMATION_BUILDER_INSTRUCTIONS, AUTOMATION_BUILDER_PROMPT_VERSION } from "../../electron/automationbuilder/instructions";
import { NATIVE_TOOL_POLICY_VERSION, nativeToolPlanIssues } from "../../electron/automationbuilder/native-tool-policy";
import { createAutomationBuilderTools } from "../../electron/automationbuilder/tools";
import { createReadTools } from "../../electron/builders/read-tools";
import { requireCatalogue } from "../../electron/architectures/catalogue-registry";
import { loadPersistedAnalysis } from "../../electron/describer/describer";
import type { AutomationPlan } from "../../common/automation";
import { seedScenario } from "../lib/seed";
import { builderScenarios } from "./scenarios";
import { BUILDER_SCORER_VERSION, scoreBuilder } from "./score";

type Json = Record<string, unknown>;
type Pending = { resolve: (value: Json) => void; reject: (error: Error) => void };
const repo = path.resolve(new URL("../..", import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:\/)/, ""));
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const CODEX_MODEL = "gpt-6-sol";
const CODEX_EFFORT = "medium";
const sourceFiles = [
  "common/automation.ts", "electron/automationbuilder/builder.ts",
  "electron/automationbuilder/tools.ts", "electron/automationbuilder/instructions.ts",
  "electron/automationbuilder/native-tool-policy.ts", "electron/builders/read-tools.ts",
  "electron/architectures/catalogues/scout-catalogue.ts", "evals/builder/score.ts",
  "evals/builder/codex-run.ts",
];
const sourceHashes = Object.fromEntries(sourceFiles.map((file) =>
  [file, hash(readFileSync(path.join(repo, file), "utf8").replace(/\r\n/g, "\n"))]));

class AppServer {
  readonly child: ChildProcessWithoutNullStreams;
  private id = 0;
  private pending = new Map<number, Pending>();
  private turnDone: ((value: Json) => void) | null = null;
  private turnThread: string | null = null;
  onToolCall: ((params: Json) => Promise<Json>) | null = null;
  onEvent: ((method: string, params: Json) => void) | null = null;
  readonly stderr: string[] = [];

  constructor(bin: string) {
    this.child = spawn(bin, ["app-server", "--stdio", "-c", 'model_provider="openai"'], {
      cwd: repo, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
    });
    readline.createInterface({ input: this.child.stdout }).on("line", (line) => {
      try { this.receive(JSON.parse(line) as Json); }
      catch (error) { this.stderr.push(`Invalid app-server JSON: ${String(error)}`); }
    });
    readline.createInterface({ input: this.child.stderr }).on("line", (line) => {
      if (this.stderr.length < 100) this.stderr.push(line);
    });
    this.child.on("exit", (code) => {
      const error = new Error(`Codex app-server exited (${code}). ${this.stderr.slice(-4).join(" ")}`);
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
      this.turnDone?.({ turn: { status: "failed", error: { message: error.message } } });
    });
  }

  send(message: Json): void { this.child.stdin.write(JSON.stringify(message) + "\n"); }
  request(method: string, params: Json = {}): Promise<Json> {
    const id = ++this.id;
    return new Promise<Json>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ method, params, id });
    });
  }
  async initialize(): Promise<void> {
    await this.request("initialize", {
      clientInfo: { name: "flowcode_legacy_builder_eval", title: "FlowCode legacy Builder eval", version: "1.0.0" },
      capabilities: { experimentalApi: true },
    });
    this.send({ method: "initialized", params: {} });
  }
  waitForTurn(threadId: string, timeoutMs: number): Promise<Json> {
    if (this.turnDone) throw new Error("A Codex turn is already in progress.");
    this.turnThread = threadId;
    return new Promise<Json>((resolve) => {
      const timer = setTimeout(() => {
        this.turnDone = null;
        this.turnThread = null;
        resolve({ turn: { status: "failed", error: { message: `Turn exceeded ${timeoutMs} ms` } } });
      }, timeoutMs);
      this.turnDone = (value) => {
        clearTimeout(timer);
        this.turnDone = null;
        this.turnThread = null;
        resolve(value);
      };
    });
  }
  private receive(message: Json): void {
    if (typeof message.id === "number" && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id)!;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
      else pending.resolve((message.result ?? {}) as Json);
      return;
    }
    const method = String(message.method ?? "");
    const params = (message.params ?? {}) as Json;
    if (method === "item/tool/call") {
      void Promise.resolve().then(() => this.onToolCall?.(params) ??
        { contentItems: [{ type: "inputText", text: "No active eval tool." }], success: false })
        .then((result) => this.send({ id: message.id, result }))
        .catch((error) => this.send({ id: message.id, result: {
          contentItems: [{ type: "inputText", text: String(error) }], success: false,
        } }));
      return;
    }
    this.onEvent?.(method, params);
    if (method === "turn/completed" && params.threadId === this.turnThread) this.turnDone?.(params);
  }
  async close(): Promise<void> {
    this.child.stdin.end();
    if (this.child.exitCode === null) this.child.kill();
  }
}

function flags(argv: string[]): { rounds: number; only: string | null; probe: boolean } {
  const result = { rounds: 2, only: null as string | null, probe: false };
  for (const arg of argv) {
    if (arg.startsWith("--rounds=")) result.rounds = Number(arg.slice(9));
    else if (arg.startsWith("--only=")) result.only = arg.slice(7);
    else if (arg === "--probe") result.probe = true;
    else throw new Error(`Unknown option ${arg}`);
  }
  if (!Number.isInteger(result.rounds) || result.rounds < 1 || result.rounds > 2) throw new Error("Use one or two rounds.");
  return result;
}

async function main(): Promise<void> {
  const options = flags(process.argv.slice(2));
  for (const key of ["OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_ACCESS_TOKEN"]) {
    if (process.env[key]) throw new Error(`${key} is set; this run requires saved ChatGPT subscription login.`);
  }
  const bin = process.env.FLOWCODE_CODEX_BIN || "codex.exe";
  const cliVersion = execFileSync(bin, ["--version"], { encoding: "utf8", windowsHide: true }).trim();
  const server = new AppServer(bin);
  try {
    await server.initialize();
    const account = await server.request("account/read", { refreshToken: false });
    const identity = account.account as Json | null;
    if (identity?.type !== "chatgpt") throw new Error(`Expected ChatGPT auth, got ${String(identity?.type ?? "none")}`);
    const models = await server.request("model/list", { limit: 100, includeHidden: false });
    const modelCatalogue = ((models.data ?? []) as Json[]).map((item) => ({
      model: item.model, displayName: item.displayName, isDefault: item.isDefault,
    }));
    console.log(JSON.stringify({ cliVersion, authMethod: "chatgpt", planType: identity.planType ?? null, modelCatalogue }));
    if (options.probe) return;

    const catalogue = requireCatalogue("scout", "automation");
    const systemContent = `${AUTOMATION_BUILDER_INSTRUCTIONS}\n\n${catalogue.content}`.trim();
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const runRoot = path.join(repo, "evals", "results", `codex-builder-${stamp}`);
    mkdirSync(runRoot, { recursive: true });
    const builder = new AutomationBuilder(() => undefined);
    const selected = builderScenarios.filter((item) => !options.only || item.id === options.only);
    if (!selected.length) throw new Error(`No scenario matches ${options.only}`);
    const evidence: Json = {
      schemaVersion: 1, status: "running", at: stamp, provider: "codex-chatgpt-subscription",
      authMethod: "chatgpt", planType: identity.planType ?? null, cliVersion,
      requestedModel: CODEX_MODEL, requestedEffort: CODEX_EFFORT, modelCatalogue,
      promptVersion: AUTOMATION_BUILDER_PROMPT_VERSION,
      policyVersion: NATIVE_TOOL_POLICY_VERSION, scorerVersion: BUILDER_SCORER_VERSION,
      catalogueVersion: catalogue.version, systemPromptHash: hash(systemContent),
      scenarioHash: hash(JSON.stringify(builderScenarios)), sourceHashes,
      scenarioIds: selected.map((item) => item.id), roundsRequested: options.rounds,
      mode: "Codex app-server model loop; production read/proposal handlers and deterministic export; no Scout execution",
      cost: null, costStatus: "unavailable", results: [] as Json[],
    };
    const outFile = path.join(runRoot, "evidence.json");
    const save = () => writeFileSync(outFile, JSON.stringify(evidence, null, 2) + "\n");
    save();
    for (let round = 1; round <= options.rounds; round++) {
      const sessionsRoot = path.join(runRoot, `round-${round}`, "sessions");
      const exportsRoot = path.join(runRoot, `round-${round}`, "exports");
      mkdirSync(sessionsRoot, { recursive: true });
      process.env.SKILL_RECORDER_SESSIONS_DIR = sessionsRoot;
      process.env.SKILL_RECORDER_AUTOMATIONS_DIR = exportsRoot;
      for (const scenario of selected) {
        seedScenario(sessionsRoot, scenario);
        const sessionDir = path.join(sessionsRoot, scenario.id);
        const seededAnalysis = loadPersistedAnalysis(scenario.id);
        if (!seededAnalysis) throw new Error(`Seeded analysis missing for ${scenario.id}`);
        let proposed: AutomationPlan | undefined;
        const rejected: string[] = [];
        const trace: Json[] = [];
        const unexpectedTools: Json[] = [];
        let tokenUsage: Json | null = null;
        let finalMessage: string | null = null;
        const productionTools = [
          ...createReadTools({ sessionDir, analysis: seededAnalysis }),
          ...createAutomationBuilderTools({
            architecture: scenario.architecture, analysis: scenario.analysis,
            onPlan: (plan) => { proposed = plan; },
            onRejectedPlan: () => { proposed = undefined; },
          }),
        ];
        const toolMap = new Map(productionTools.map((tool) => [tool.name, tool]));
        const started = Date.now();
        const result: Json = { round, id: scenario.id, status: "running" };
        try {
          const startedThread = await server.request("thread/start", {
            cwd: sessionDir, approvalPolicy: "never", sandbox: "read-only",
            model: CODEX_MODEL, modelProvider: "openai", developerInstructions: systemContent,
            dynamicTools: productionTools.map((tool) => ({
              type: "function", name: tool.name, description: tool.description,
              inputSchema: tool.parameters,
            })),
          });
          const thread = startedThread.thread as Json;
          const threadId = String(thread.id);
          result.threadId = threadId;
          result.model = startedThread.model ?? null;
          result.modelProvider = startedThread.modelProvider ?? null;
          result.threadDefaultReasoningEffort = startedThread.reasoningEffort ?? null;
          if (startedThread.modelProvider !== "openai") throw new Error("Unexpected model provider.");
          server.onToolCall = async (params) => {
            const name = String(params.tool ?? "");
            const raw = (params.arguments ?? {}) as Json;
            const tool = toolMap.get(name);
            const callStarted = Date.now();
            if (!tool) {
              unexpectedTools.push({ name, kind: "dynamicToolCall" });
              return { success: false, contentItems: [{ type: "inputText", text: "Unknown eval tool." }] };
            }
            const response = await tool.handler!(raw, {} as never);
            const failed = typeof response === "object" && response !== null && "resultType" in response && response.resultType === "failure";
            const text = typeof response === "string" ? response :
              failed ? String((response as Record<string, unknown>).textResultForLlm ?? "") : JSON.stringify(response);
            trace.push({ name, arguments: raw, success: !failed, responseHash: hash(text),
              rejection: failed ? text : null, durationMs: Date.now() - callStarted });
            if (failed) rejected.push(text);
            return { success: !failed, contentItems: [{ type: "inputText", text }] };
          };
          server.onEvent = (method, params) => {
            if (params.threadId !== threadId) return;
            if (method === "thread/tokenUsage/updated") tokenUsage = (params.tokenUsage as Json)?.last as Json ?? null;
            if (method === "item/completed" || method === "item/started") {
              const item = params.item as Json | undefined;
              if (!item) return;
              if (item.type === "agentMessage" && item.phase === "final_answer") finalMessage = String(item.text ?? "");
              if (["commandExecution", "mcpToolCall", "webSearch", "fileChange", "collabToolCall"].includes(String(item.type))) {
                unexpectedTools.push({ kind: item.type, id: item.id, status: item.status ?? null });
              }
            }
          };
          const turnCompletion = server.waitForTurn(threadId, 180_000);
          await server.request("turn/start", { threadId, effort: CODEX_EFFORT,
            input: [{ type: "text", text: AUTOMATION_BUILDER_KICKOFF_PROMPT }] });
          const completed = await turnCompletion;
          const turn = completed.turn as Json;
          result.turnStatus = turn.status ?? null;
          result.turnError = (turn.error as Json | null)?.message ?? null;
          result.tokenUsage = tokenUsage;
          result.toolTrace = trace;
          result.rejectedProposals = rejected;
          result.unexpectedTools = unexpectedTools;
          result.finalMessage = finalMessage;
          if (turn.status !== "completed") throw new Error(`Codex turn ${String(turn.status)}: ${String(result.turnError)}`);
          if (!proposed) throw new Error("Codex finished without an accepted propose_automation_plan call.");
          result.plan = proposed;
          result.score = scoreBuilder(proposed.steps.map((step) => `${step.label}\n${step.prompt}`).join("\n\n"), scenario.rubric);
          result.planIssues = nativeToolPlanIssues(proposed, scenario.analysis);
          const built = await builder.create(scenario.id, proposed);
          result.exportSha256 = hash(readFileSync(built.path, "utf8"));
          result.analysisRead = trace.some((item) => item.name === "get_analysis" && item.success === true);
          result.ok = (result.score as { pass: boolean }).pass && (result.planIssues as unknown[]).length === 0 &&
            result.analysisRead === true && unexpectedTools.length === 0;
          result.status = result.ok ? "pass" : "fail";
        } catch (error) {
          result.status = "error";
          result.ok = false;
          result.error = error instanceof Error ? error.message : String(error);
          result.toolTrace ??= trace;
          result.rejectedProposals ??= rejected;
          result.unexpectedTools ??= unexpectedTools;
          result.tokenUsage ??= tokenUsage;
        }
        result.durationMs = Date.now() - started;
        (evidence.results as Json[]).push(result);
        save();
        console.log(`${round}/${options.rounds} ${scenario.id}: ${result.status} (${result.durationMs}ms)`);
      }
    }
    await builder.dispose();
    evidence.status = "complete";
    evidence.completedAt = new Date().toISOString();
    save();
    console.log(`Evidence: ${outFile}`);
  } finally {
    await server.close();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
