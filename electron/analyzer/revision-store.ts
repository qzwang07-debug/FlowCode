import { mkdir, readFile, readdir, writeFile, link, rm, lstat, realpath } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { AutomationBlueprintV2Schema, type AutomationBlueprintV2 } from "../../common/blueprint-v2";
import { BlueprintReviewFlagsSchema, EMPTY_REVIEW_FLAGS } from "../../common/analyzer";
import { contractHash, readBlueprintDocument, sealBlueprint } from "../evidence/blueprint-contract";

const Revision = z.object({ blueprint: AutomationBlueprintV2Schema, flags: BlueprintReviewFlagsSchema,
  baseHash: z.string().regex(/^[a-f0-9]{64}$/).optional(), scopeHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  author: z.enum(["deterministic", "user", "analyzer"]), at: z.number(),
  feedback: z.string().max(8000), changedStepIds: z.array(z.string()) }).strict();
export type ReviewRevision = z.infer<typeof Revision>;

/** Append-only derived versions; never rewrites raw events or deterministic v1/v2. */
export class BlueprintRevisionStore {
  constructor(private readonly sessionDirectory: string, private readonly scopeHash?: string) {}
  async list(base: AutomationBlueprintV2): Promise<ReviewRevision[]> {
    const directory = path.join(this.sessionDirectory, "blueprint-revisions");
    const directoryInfo = await lstat(directory).catch(e => { if (e.code === "ENOENT") return null; throw e; });
    if (!directoryInfo) return [];
    const parent = await realpath(this.sessionDirectory), canonical = await realpath(directory);
    if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink() || path.relative(parent, canonical).startsWith("..") || path.isAbsolute(path.relative(parent, canonical)))
      throw new Error("Derived revision directory is outside the trusted Session store.");
    const names = await readdir(directory).catch(e => { if (e.code === "ENOENT") return []; throw e; });
    const records: ReviewRevision[] = [];
    for (const name of names.filter(n => /^revision-\d+(?:-[a-f0-9]{64})?\.json$/.test(n)).sort()) {
      const file = await lstat(path.join(directory, name));
      if (!file.isFile() || file.isSymbolicLink()) throw new Error("Derived revisions must be owned regular files, not external links.");
      const record = Revision.parse(JSON.parse(await readFile(path.join(directory, name), "utf8")));
      readBlueprintDocument(record.blueprint);
      if (record.blueprint.id === base.id && record.blueprint.source.evidenceHash === base.source.evidenceHash &&
        record.blueprint.source.sessionId === base.source.sessionId && record.blueprint.projectKind === base.projectKind &&
        (!record.baseHash || record.baseHash === base.contentHash)) records.push(record);
    }
    return records.sort((a, b) => a.blueprint.revision - b.blueprint.revision);
  }
  async current(base: AutomationBlueprintV2): Promise<ReviewRevision> {
    const list = await this.list(base);
    const last = list.at(-1);
    if (last && last.blueprint.revision >= base.revision) return this.scopeHash && last.scopeHash !== this.scopeHash
      ? { ...last, flags: structuredClone(EMPTY_REVIEW_FLAGS) } : last;
    return { blueprint: base, flags: structuredClone(EMPTY_REVIEW_FLAGS), author: "deterministic", at: 0, feedback: "", changedStepIds: [] };
  }
  async append(base: AutomationBlueprintV2, raw: ReviewRevision): Promise<ReviewRevision> {
    const current = await this.current(base);
    const record = Revision.parse({ ...raw, baseHash: base.contentHash, ...(this.scopeHash ? { scopeHash: this.scopeHash } : {}) });
    readBlueprintDocument(record.blueprint);
    if (record.blueprint.revision !== current.blueprint.revision + 1 ||
      record.blueprint.parent?.contentHash !== current.blueprint.contentHash)
      throw new Error("Blueprint changed; reload before saving this revision.");
    if (record.blueprint.id !== base.id || record.blueprint.source.evidenceHash !== base.source.evidenceHash ||
      record.blueprint.source.sessionId !== base.source.sessionId) throw new Error("Revision belongs to another evidence scope.");
    const directory = path.join(this.sessionDirectory, "blueprint-revisions");
    await mkdir(directory, { recursive: true });
    // wx is also the cross-process compare-and-swap guard for this exact version.
    const temporary = path.join(directory, `${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, JSON.stringify(record, null, 2) + "\n", { flag: "wx" });
      await link(temporary, path.join(directory, `revision-${String(record.blueprint.revision).padStart(8, "0")}-${base.contentHash}.json`));
    } finally { await rm(temporary, { force: true }); }
    return record;
  }
}
export function nextReviewVersion(base: AutomationBlueprintV2) {
  return sealBlueprint({ ...base, revision: base.revision + 1, parent: { revision: base.revision, contentHash: base.contentHash } });
}
export function changedSteps(base: AutomationBlueprintV2, next: AutomationBlueprintV2): string[] {
  const ids = new Set([...base.steps, ...next.steps].map(s => s.id));
  return [...ids].filter(id => contractHash(base.steps.find(s => s.id === id) ?? null) !== contractHash(next.steps.find(s => s.id === id) ?? null));
}
