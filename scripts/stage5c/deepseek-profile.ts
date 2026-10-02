import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { ProviderStore } from "../../electron/analyzer/provider-store";
import { WindowsCredentialVault } from "../../electron/analyzer/windows-credentials";

// Explicit, user-authorized Harness-to-vault transfer. Never export/print keys,
// account balances, grant tokens or the source credential document.
const home = process.env.USERPROFILE;
if (!home || process.platform !== "win32") throw new Error("This transfer requires the user's Windows profile.");
const profile = path.resolve(".stage5c/deepseek");
const require = createRequire(import.meta.url);
const yaml = require(path.join(home, ".dsh/profiles/node_modules/js-yaml/index.js"));
const source = path.join(home, ".dsh/.credentials.yaml");
const original = await readFile(source);
let key: unknown;
try { key = yaml.load(original.toString("utf8"))?.refs?.DEEPSEEK_API_KEY; }
catch { throw new Error("Harness credential document is not readable; no contents logged."); }
if (typeof key !== "string" || !/^sk-[A-Za-z0-9_-]{20,}$/.test(key)) throw new Error("No directly usable DEEPSEEK_API_KEY in the authorized Harness reference.");
const headers = { authorization: `Bearer ${key}` };
async function metadata(route: string) {
  const response = await fetch(`https://api.deepseek.com${route}`, { headers, redirect: "error", signal: AbortSignal.timeout(45000) });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`DeepSeek metadata HTTP ${response.status}; private body withheld.`); }
  return response.json();
}
const models = await metadata("/models");
if (!models.data?.some((m: { id: string }) => m.id === "deepseek-flash")) throw new Error("The selected official model is not available to this key.");
const balance = await metadata("/user/balance");
if (!balance.is_available) throw new Error("DeepSeek balance is unavailable; no purchase or recharge authorized.");
const vault = new WindowsCredentialVault();
const providers = new ProviderStore(path.join(profile, "settings"), vault);
await providers.save({ settings: { schemaVersion: 1, providerId: "flowcode-deepseek", baseUrl: "https://api.deepseek.com",
  modelId: "deepseek-flash", authentication: "credential-manager", pricing: "metered", inputUsdPerMillion: 0.30, outputUsdPerMillion: 1.20,
  budget: { maxSeconds: 600, maxTokens: 120000, maxCostUsd: 0.30, maxTurns: 12 } }, apiKey: key });
const roundtrip = await vault.read("flowcode-deepseek");
if (roundtrip !== key) throw new Error("Credential Manager round-trip did not validate.");
if (!(await readFile(source)).equals(original)) throw new Error("Harness credentials unexpectedly changed during the transfer.");
const receipt = { schemaVersion: 1, keyFound: true, credentialManagerRoundTrip: true, harnessUnchanged: true,
  metadataAuthenticated: true, model: "deepseek-flash", selectedModelListed: true, balanceAvailable: true,
  totalAuthorizedCny: 20, totalAuthorizationUsdCeiling: 2.50,
  accounting: "Peak cache-miss USD rates, multiplied by 8 as a conservative CNY upper bound; covers all probes, trials, failures and Eval. Missing usage consumes its reservation. No recharge.",
  priceSource: "https://api-docs.deepseek.com/quick_start/pricing/", keyStorage: "Windows Credential Manager only" };
await mkdir(profile, { recursive: true });
await writeFile(path.join(profile, "key-check.json"), JSON.stringify(receipt, null, 2));
console.log(JSON.stringify(receipt));
