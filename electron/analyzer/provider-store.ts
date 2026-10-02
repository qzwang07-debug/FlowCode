import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { FREE_PROVIDER, ProviderSaveSchema, ProviderSettingsSchema, ProviderCapabilitiesSchema,
  type ProviderSettings, type ProviderCapabilities } from "../../common/analyzer";
import { contractHash } from "../evidence/blueprint-contract";
import type { CredentialVault } from "./windows-credentials";

async function read(file: string): Promise<unknown | undefined> {
  try { return JSON.parse(await readFile(file, "utf8")); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw new Error("Model settings are corrupt; restore them explicitly."); }
}
async function atomic(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true }); const tmp = `${file}.${randomUUID()}.tmp`;
  try { await writeFile(tmp, JSON.stringify(value, null, 2) + "\n", { flag: "wx" }); await rename(tmp, file); }
  finally { await rm(tmp, { force: true }); }
}
export class ProviderStore {
  constructor(private readonly root: string, private readonly vault: CredentialVault) {}
  async settings(): Promise<ProviderSettings> {
    return ProviderSettingsSchema.parse(await read(path.join(this.root, "provider.json")) ?? FREE_PROVIDER);
  }
  async view() {
    const settings = await this.settings();
    const checked = ProviderCapabilitiesSchema.safeParse(await read(path.join(this.root, "provider-capabilities.json")));
    const capabilities = checked.success && checked.data.settingsHash === contractHash(settings) ? checked.data : null;
    const keyPresent = settings.authentication === "credential-manager" && Boolean(await this.vault.read(settings.providerId));
    return { settings, capabilities, keyPresent };
  }
  async save(raw: unknown) {
    const input = ProviderSaveSchema.parse(raw);
    if (input.clearKey) await this.vault.remove(input.settings.providerId);
    if (input.apiKey) {
      if (input.settings.authentication !== "credential-manager") throw new Error("Select Windows Credential Manager before supplying a key.");
      await this.vault.write(input.settings.providerId, input.apiKey);
    }
    if (input.apiKey || input.clearKey) await rm(path.join(this.root, "provider-capabilities.json"), { force: true });
    await atomic(path.join(this.root, "provider.json"), input.settings);
    return this.view();
  }
  async credential(settings: ProviderSettings): Promise<string | undefined> {
    if (settings.authentication === "none") return undefined;
    const secret = await this.vault.read(settings.providerId);
    if (!secret) throw new Error("No model key is stored in Windows Credential Manager.");
    return secret;
  }
  async setCapabilities(capabilities: ProviderCapabilities) {
    const c = ProviderCapabilitiesSchema.parse(capabilities);
    if (c.settingsHash !== contractHash(await this.settings())) throw new Error("Model settings changed during the connection test.");
    await atomic(path.join(this.root, "provider-capabilities.json"), c);
  }
}
