// Deterministic, LLM-free scoring for the builder evals: does the generalized
// output reach for the RIGHT native tool? We score the actionable text — the
// ordered step labels + prompts — against the scenario's rubric. The plan's
// summary/generalization are intentionally NOT scored, so the builder isn't
// penalized for *explaining* what it deliberately avoided (e.g. "instead of
// clicking through the browser…").

import type { BuilderRubric } from "./scenario";
import { hasBrowserAction, normalizeToolText, usesNativeTool } from "../../electron/automationbuilder/native-tool-policy";

export const BUILDER_SCORER_VERSION = "native-tools.2";

export interface BuilderCheck {
  name: string;
  pass: boolean;
  detail?: string;
}

export interface BuilderScoreResult {
  pass: boolean;
  score: number;
  checks: BuilderCheck[];
}

const has = (haystack: string, needle: string): boolean =>
  normalizeToolText(haystack).includes(normalizeToolText(needle));
// These rubric entries describe output formats, not named native tools.
const OUTPUT_HINTS = new Set(["note", "write", ".md", ".txt", "pdf"]);

/** Score the built steps' text against the rubric. `stepsText` is label + prompt joined. */
export function scoreBuilder(stepsText: string, rubric: BuilderRubric): BuilderScoreResult {
  const checks: BuilderCheck[] = [];

  for (const group of rubric.mustUseAny) {
    const hit = group.find((k) => OUTPUT_HINTS.has(k) ? has(stepsText, k) : usesNativeTool(stepsText, k));
    checks.push({
      name: `uses one of: ${group.map((k) => JSON.stringify(k)).join(", ")}`,
      pass: Boolean(hit),
      detail: hit ? `found ${JSON.stringify(hit)}` : "none of these appeared in the steps",
    });
  }

  for (const bad of rubric.forbidden) {
    // Preserve every forbidden token; additionally recognize informal UI replay
    // where a scenario already explicitly forbids browser_* automation.
    const literal = has(stepsText, bad);
    const present = literal || (bad === "browser_" && hasBrowserAction(stepsText));
    checks.push({
      name: `avoids ${JSON.stringify(bad)}`,
      pass: !present,
      detail: present ? (literal ? `forbidden token ${JSON.stringify(bad)} appeared in the steps` : "informal browser/UI replay appeared in the steps") : undefined,
    });
  }

  // A forbidden-token hit (wrong tool) fails the scenario outright; otherwise the
  // must-use checks must all pass.
  const forbiddenHit = checks.some((c) => c.name.startsWith("avoids ") && !c.pass);
  const passed = checks.filter((c) => c.pass).length;
  const score = checks.length ? passed / checks.length : 0;
  return { pass: !forbiddenHit && passed === checks.length, score, checks };
}
