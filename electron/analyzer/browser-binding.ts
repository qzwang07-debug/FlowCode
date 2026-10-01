import { readFile } from "node:fs/promises";
import path from "node:path";
import { BrowserSourceIdentitySchema, BrowserSessionLeaseSchema, type BrowserEnvironmentProfile } from "../../common/browser-environment";
import type { z } from "zod";
import { contractHash } from "../evidence/blueprint-contract";

/** Private Desktop-side access only. Native bindings never become MCP data. */
export class RecordedBrowserAccess {
  constructor(private readonly directory: (sessionId: string) => string,
    private readonly profile: (id: string) => Promise<BrowserEnvironmentProfile>) {}
  private async binding(id: string) {
    const directory = this.directory(id);
    const raw = await readFile(path.join(directory, "browser-source.json"), "utf8").catch(e => { if (e.code === "ENOENT") return null; throw e; });
    if (!raw) return null;
    const source = BrowserSourceIdentitySchema.parse(JSON.parse(raw));
    if (source.sessionId !== id) throw new Error("Recording source identity mismatch; model data withheld.");
    if (source.provider !== "ziniao") return null;
    const lease = BrowserSessionLeaseSchema.parse(JSON.parse(await readFile(path.join(directory, "browser-lease.json"), "utf8")));
    if (lease.id !== source.leaseId || lease.environmentProfileId !== source.environmentProfileId || lease.provider !== source.provider ||
      lease.owner.kind !== "recording" || lease.owner.sessionId !== id || !lease.binding)
      throw new Error("Recorded environment identity mismatch; model data withheld.");
    return { source, lease };
  }
  async privateValues(id: string): Promise<string[]> {
    const binding = await this.binding(id);
    return binding?.lease.binding ? [binding.lease.binding.storeId, binding.lease.binding.expectedName] : [];
  }
  async scopeHash(id: string) {
    const binding = await this.binding(id);
    if (!binding) return contractHash("no-recorded-profile");
    const current = await this.profile(binding.source.environmentProfileId).catch(() => null);
    return contractHash({ source: binding.source, recorded: binding.lease.environmentHash,
      current: current ? contractHash(current) : "unavailable" });
  }
  async capabilities(source: z.infer<typeof BrowserSourceIdentitySchema>) {
    const binding = await this.binding(source.sessionId);
    if (!binding || contractHash(source) !== contractHash(binding.source)) return null;
    const current = await this.profile(source.environmentProfileId).catch(() => null);
    return current?.provider === source.provider && contractHash(current) === binding.lease.environmentHash ? current.capabilities : null;
  }
}
