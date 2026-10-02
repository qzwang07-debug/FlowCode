import path from "node:path";
import { ProviderStore } from "../../electron/analyzer/provider-store";
import { WindowsCredentialVault } from "../../electron/analyzer/windows-credentials";
import { existsSync } from "node:fs";
const root = path.resolve(".stage5c/deepseek");
if (existsSync(path.join(root, "spend.jsonl.lock"))) throw new Error("Wait for the current authorized Eval before changing its profile.");
const model = process.argv.find(a => a.startsWith("--model="))?.slice(8);
if (!["deepseek-flash", "deepseek-v4-pro"].includes(model ?? "")) throw new Error("Select an explicitly authorized official DeepSeek model.");
const providers = new ProviderStore(path.join(root, "settings"), new WindowsCredentialVault());
const settings = await providers.settings();
const key = await providers.credential(settings);
const response = await fetch("https://api.deepseek.com/models", { headers: { authorization: `Bearer ${key}` }, redirect: "error", signal: AbortSignal.timeout(45000) });
if (!response.ok) { await response.body?.cancel(); throw new Error(`Model metadata HTTP ${response.status}; private body withheld.`); }
const metadata = await response.json();
if (!metadata.data?.some((m: { id: string }) => m.id === model)) throw new Error("The requested model is not listed for this authorized key.");
const pro = model === "deepseek-v4-pro";
await providers.save({ settings: { ...settings, modelId: model, pricing: "metered", inputUsdPerMillion: pro ? 1.32 : 0.30,
  inputCachedUsdPerMillion: pro ? 0.044 : 0.006, outputUsdPerMillion: pro ? 3.96 : 1.20,
  budget: { maxSeconds: 600, maxTokens: 200000, maxCostUsd: pro ? 0.50 : 0.30, maxTurns: 12 } } });
console.log(JSON.stringify({ model, authentication: "existing Credential Manager reference", totalAuthorization: "unchanged RMB 20 / USD 2.50 ledger",
  pricing: "Peak ceilings; preauthorize cache miss. Settle verified numeric cache hits only; missing/invalid cache usage stays at cache-miss ceiling." }));
