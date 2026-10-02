import { appendFile, mkdir, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { AnalyzerRunSchema, type AnalyzerRun } from "../../common/analyzer";

/** Audit entries deliberately exclude model content, key, source payload or paths. */
export class AnalyzerRunStore {
  private queues = new Map<string, Promise<void>>();
  constructor(private readonly root: string) {}
  async append(id: string, type: string, data: unknown) {
    z.uuid().parse(id);
    const previous = this.queues.get(id) ?? Promise.resolve();
    const next = previous.then(async () => {
      const dir = path.join(this.root, id); await mkdir(dir, { recursive: true });
      await appendFile(path.join(dir, "audit.jsonl"), JSON.stringify({ schemaVersion: 1, at: Date.now(), type, data }) + "\n", { mode: 0o600 });
    });
    this.queues.set(id, next); await next;
  }
  async status(run: AnalyzerRun) { await this.append(run.id, "state", AnalyzerRunSchema.parse(run)); }
  async read(id: string): Promise<AnalyzerRun | null> {
    z.uuid().parse(id);
    const contents = await readFile(path.join(this.root, id, "audit.jsonl"), "utf8").catch(e => { if (e.code === "ENOENT") return ""; throw e; });
    let run: AnalyzerRun | null = null;
    for (const line of contents.split(/\r?\n/)) {
      try { const entry = JSON.parse(line); if (entry.type === "state") run = AnalyzerRunSchema.parse(entry.data); }
      catch { /* incomplete final append after crash cannot fabricate successful state */ }
    }
    return run;
  }
  async list(sessionId?: string): Promise<AnalyzerRun[]> {
    const names = await readdir(this.root).catch(e => { if (e.code === "ENOENT") return []; throw e; });
    const runs = await Promise.all(names.filter(n => z.uuid().safeParse(n).success).map(id => this.read(id)));
    return runs.filter((r): r is AnalyzerRun => Boolean(r && (!sessionId || r.sessionId === sessionId))).sort((a, b) => b.startedAt - a.startedAt).slice(0, 50);
  }
  async recover() {
    for (const r of await this.list()) if (["analysis", "preparing"].includes(r.phase))
      await this.status({ ...r, phase: "interrupted", finishedAt: Date.now(), error: "Application stopped before analysis completed. Evidence and prior review versions remain available; start an explicit retry." });
  }
}
