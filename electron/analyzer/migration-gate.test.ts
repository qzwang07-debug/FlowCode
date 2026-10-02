import assert from "node:assert/strict";
import test from "node:test";
import baseline from "../../fixtures/stage5c/copilot-baseline.json" with { type: "json" };
import { FREE_PROVIDER, ANALYZER_PROMPT_VERSION, ANALYZER_SCHEMA_VERSION } from "../../common/analyzer";
import { contractHash } from "../evidence/blueprint-contract";
import { ANALYZER_SYSTEM_PROMPT } from "../opencode/service";
import { migrationState } from "./migration-gate";

test("default migration requires full current quality evidence AND the checked configuration", () => {
  const settings = { ...FREE_PROVIDER, authentication: "credential-manager" as const };
  const view = { settings, keyPresent: true, capabilities: { settingsHash: contractHash(settings), checkedAt: 1,
    toolCalling: "supported" as const, structuredOutput: "supported" as const, vision: "unknown" as const, detail: "Synthetic policy test; not model evidence" } };
  const reviewed = { schemaVersion: 1, qualityPassed: true, samples: 21, individualCasesMet: true, safetyMet: true,
    promptVersion: ANALYZER_PROMPT_VERSION, schemaVersionName: ANALYZER_SCHEMA_VERSION,
    promptHash: contractHash(ANALYZER_SYSTEM_PROMPT), settingsHash: contractHash(settings), receiptHash: "b".repeat(64), inputHash: baseline.inputHash };
  assert.equal(migrationState(view, reviewed).defaultAnalyzer, "opencode");
  for (const change of [{ qualityPassed: false }, { samples: 20 }, { individualCasesMet: false }, { safetyMet: false },
    { promptVersion: "stale" }, { promptHash: "b".repeat(64) }, { inputHash: "c".repeat(64) }])
    assert.equal(migrationState(view, { ...reviewed, ...change }).defaultAnalyzer, "copilot");
  assert.equal(migrationState({ ...view, keyPresent: false }, reviewed).defaultAnalyzer, "copilot");
  assert.equal(migrationState({ ...view, capabilities: null }, reviewed).defaultAnalyzer, "copilot");
  assert.equal(migrationState({ ...view, settings: { ...settings, modelId: "unreviewed-model" } }, reviewed).defaultAnalyzer, "copilot");
});
