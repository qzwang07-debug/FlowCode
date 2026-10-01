import policy from "../../fixtures/stage5c/migration-policy.json" with { type: "json" };
import baseline from "../../fixtures/stage5c/copilot-baseline.json" with { type: "json" };
import { ANALYZER_PROMPT_VERSION, ANALYZER_SCHEMA_VERSION, type ProviderSettings, type ProviderCapabilities } from "../../common/analyzer";
import { ANALYZER_SYSTEM_PROMPT } from "../opencode/service";
import { contractHash } from "../evidence/blueprint-contract";

export function migrationState(view: { settings: ProviderSettings; capabilities: ProviderCapabilities | null; keyPresent: boolean }, reviewed = policy) {
  const passed = reviewed.qualityPassed && reviewed.samples === 21 && reviewed.individualCasesMet && reviewed.safetyMet &&
    reviewed.promptVersion === ANALYZER_PROMPT_VERSION && reviewed.schemaVersionName === ANALYZER_SCHEMA_VERSION &&
    reviewed.promptHash === contractHash(ANALYZER_SYSTEM_PROMPT) && reviewed.inputHash === baseline.inputHash && /^[a-f0-9]{64}$/.test(reviewed.receiptHash);
  const configured = contractHash(view.settings) === reviewed.settingsHash && view.capabilities?.settingsHash === reviewed.settingsHash &&
    view.capabilities?.toolCalling === "supported" && view.capabilities?.structuredOutput === "supported" &&
    (view.settings.authentication === "none" || view.keyPresent);
  return { migrationGate: passed ? "passed" : "not-passed", defaultAnalyzer: passed && configured ? "opencode" : "copilot" } as const;
}
