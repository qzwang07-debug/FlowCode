import { mkdir, readFile, realpath, rename, writeFile, rm } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { OPENCODE_WINDOWS_X64_SHA256 } from "../opencode/probe-host";
import { OPENCODE_PIN } from "../opencode/contract-client";

export class RuntimeSettings {
  constructor(private readonly root: string, private readonly devBinary?: string) {}
  async resolve(): Promise<string> {
    let selected: string | undefined;
    try { const raw = JSON.parse(await readFile(path.join(this.root, "opencode-runtime.json"), "utf8")); selected = typeof raw.binary === "string" ? raw.binary : undefined; }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("External OpenCode runtime setting is invalid."); }
    const candidate = selected ?? this.devBinary;
    if (!candidate || !path.isAbsolute(candidate)) throw new Error("Select the reviewed external OpenCode 1.18.29 executable in Model settings.");
    const binary = await realpath(candidate);
    const hash = createHash("sha256").update(await readFile(binary)).digest("hex");
    if (hash !== OPENCODE_WINDOWS_X64_SHA256) throw new Error("This executable does not match the reviewed OpenCode version/hash.");
    return binary;
  }
  async view() {
    try { await this.resolve(); return { available: true, version: OPENCODE_PIN, detail: "Reviewed external Windows x64 runtime is ready. Not bundled or auto-updated." }; }
    catch { return { available: false, version: OPENCODE_PIN, detail: "Select the reviewed external OpenCode executable. No download or installation is performed automatically." }; }
  }
  async select(binary: string) {
    const canonical = await realpath(binary);
    const hash = createHash("sha256").update(await readFile(canonical)).digest("hex");
    if (hash !== OPENCODE_WINDOWS_X64_SHA256) throw new Error("Unreviewed OpenCode binary rejected.");
    await mkdir(this.root, { recursive: true }); const temporary = path.join(this.root, `runtime-${randomUUID()}.tmp`);
    try { await writeFile(temporary, JSON.stringify({ schemaVersion: 1, binary: canonical }), { flag: "wx" }); await rename(temporary, path.join(this.root, "opencode-runtime.json")); }
    finally { await rm(temporary, { force: true }); }
    return this.view();
  }
}
