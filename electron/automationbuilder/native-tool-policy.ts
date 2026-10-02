import type { AnalysisSubmission } from "../../common/analysis";
import type { AutomationPlan } from "../../common/automation";
import { renderValues } from "../../common/values";

export const NATIVE_TOOL_POLICY_VERSION = "legacy-native-tools.7";

/** Ignore presentation, not tool identity. A generic "fetch" is NOT web_fetch. */
export function normalizeToolText(text: string): string {
  return text.replace(/`+/g, "").replace(/\*\*/g, "").toLowerCase().replace(/\s+/g, " ").trim();
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Small, deterministic English-prose guard, not a general NL parser or sandbox. */
function affirmativeMatch(text: string, pattern: RegExp): boolean {
  // URLs and extensions must not masquerade as a tool invocation.
  const normalized = text.replace(/`+/g, "").replace(/\*\*/g, "").toLowerCase()
    .replace(/[^\S\n]+/g, " ").replace(/https?:\/\/\S+/g, " ");
  for (const match of normalized.matchAll(pattern)) {
    const before = normalized.slice(0, match.index).split(/[.;!?\n]|\bbut\b/).at(-1) ?? "";
    const after = normalized.slice(match.index! + match[0].length);
    if (/\bno\s+$/.test(before)) continue;
    if (/\b(?:do not|don't|must not|never|avoid|without|instead of|rather than|cannot|can't|not use)\b[^,;.!?]*$/.test(before)) continue;
    if (/^\s*(?:cli\s+|tool\s+)?(?:is\s+|are\s+)?(?:unavailable|unsupported|not available|not supported|cannot|can't)\b/.test(after)) continue;
    return true;
  }
  return false;
}

/** Explicit positive tool references, including catalogue aliases and command prefixes. */
export function usesNativeTool(text: string, tool: string): boolean {
  const name = normalizeToolText(tool);
  let body = escapeRegex(name).replace(/ /g, "\\s+");
  if (name === "workiq") body = "workiq(?:_[a-z0-9_]+)?";
  if (name === "browser_") body = "browser_[a-z0-9_]+";
  // The '.' exclusion prevents Budget.xlsx satisfying the xlsx skill requirement.
  return affirmativeMatch(text, new RegExp(`(?<![\\w.])${body}(?![\\w-])`, "g"));
}

/** Catch UI instructions even when they omit formal browser_* tool names. */
export function hasBrowserAction(text: string): boolean {
  return affirmativeMatch(text, /\b(?:browser(?:_[a-z0-9_]+)?|playwright|chrome|microsoft edge|click|navigate\s+to)\b/g);
}

export interface NativeToolPlanIssue {
  code: string;
  /** Zero-based step, absent for an intent-level omission. No user values in errors. */
  stepIndex?: number;
  message: string;
}

/**
 * Bounded checks for the existing Scout automation catalogue only. Do not apply
 * its native-first rule to the future FlowCode Playwright project Builder.
 * Inputs stay schema-compatible; persisted plans are not rewritten. This catches
 * known omissions and explicit wrong-tool choices, not all possible plan defects.
 */
export function nativeToolPlanIssues(plan: AutomationPlan, analysis?: AnalysisSubmission): NativeToolPlanIssue[] {
  const issues: NativeToolPlanIssue[] = [];
  const add = (code: string, message: string, stepIndex?: number) => issues.push({ code, stepIndex, message });
  if (!plan.steps.length) add("empty-plan", "Provide at least one actionable step.");
  for (const [i, step] of plan.steps.entries()) {
    if (!step.prompt.trim()) add("empty-step", "Provide an actionable step prompt.", i);
  }
  if (plan.architecture !== "scout") return issues;

  const context = analysis ? normalizeToolText([
    analysis.intent,
    ...analysis.steps.map((s) => `${s.title} ${s.detail} ${s.evidence.join(" ")}`),
  ].join("\n")) : "";
  const githubTask = /\bgithub\b|github\.com/.test(context);
  const azureDeploy = /\bdeploy\b/.test(normalizeToolText(analysis?.intent ?? "")) && /\bazure\b/.test(context);
  const expensifyTask = /\bexpensify\b/.test(context);
  const approvedActions = analysis ? [analysis.intent, ...analysis.steps.map((s) => `${s.title}. ${s.detail}`)].join("\n") : "";
  // Never use summary, labels or skillNames as evidence of actionable tool use.
  const prompts = plan.steps.map((s) => s.prompt).join("\n");
  const usesAny = (names: string[]) => names.some((name) => usesNativeTool(prompts, name));
  if (githubTask && !usesAny(["gh issue", "gh pr", "gh release", "gh repo", "gh api", "gh gist", "gh run"])) {
    add("github-tool", "Name the matching gh command (gh issue/pr/release/repo/api), not a generic browser or CLI.");
  }
  if (githubTask && /\bcomment\b/.test(normalizeToolText(analysis?.intent ?? ""))) {
    const kind = /\b(?:pull requests?|prs?)\b/.test(context) ? "pr" : "issue";
    if (!usesAny([`gh ${kind} comment`, "gh api"])) {
      add("github-comment-tool", `GitHub supports comments: use gh ${kind} comment or the corresponding gh api request.`);
    }
  }

  for (const [i, step] of plan.steps.entries()) {
    const resolved = normalizeToolText(renderValues(step.prompt, plan.values));
    const githubStep = /\bgithub\b|github\.com/.test(resolved) ||
      (githubTask && /\b(?:prs?|pull requests?|issues?|merged)\b/.test(resolved));
    if (githubStep && hasBrowserAction(step.prompt)) {
      add("github-browser", "Replace GitHub UI replay with the matching gh CLI command; do not fall back to a browser for comments.", i);
    }
    if (githubStep && /\bgh\s+(?:pr|issue)\s+(?:list|comment|view)\b[^.;\n]*\s(?:--web|-w)\b/.test(resolved)) {
      add("github-browser", "Do not use gh --web/-w to open the browser; use the noninteractive CLI action.", i);
    }
    if (githubStep) {
      // A local changelog step consumes already-fetched PR data, not GitHub itself.
      const githubRead = /\b(?:fetch|list|search|query|retrieve|collect|gather|find|get)\b[^.;\n]{0,120}\b(?:github|prs?|pull requests?|issues?)\b/.test(resolved);
      const localArtifactStep = /\bchangelog\b|\.md\b|\b(?:local|notes?) file\b/.test(resolved) && !githubRead;
      if (!localArtifactStep && !["gh issue", "gh pr", "gh release", "gh repo", "gh api", "gh gist", "gh run"].some((name) => usesNativeTool(step.prompt, name))) {
        add("github-step-tool", "Name the matching gh command in this GitHub action prompt; a different step cannot supply its tool.", i);
      }
      // GitHub's documented search grammar, not invented review-status synonyms.
      const reviewStates = new Set(["none", "required", "approved", "changes_requested"]);
      if ([...resolved.matchAll(/\breview:([a-z_]+)/g)].some((m) => !reviewStates.has(m[1]))) {
        add("github-review-query", "Use a documented review qualifier: review:none/required/approved/changes_requested, not review:awaited.", i);
      }
      if (/\bcreated:<\d+_days_ago\b/.test(resolved)) {
        add("github-date-query", "Compute the cutoff date at run time and use an ISO date in created:<DATE, not a literal N_days_ago placeholder.", i);
      }
      if (usesNativeTool(step.prompt, "gh pr list") && /--milestone\b/.test(resolved)) {
        add("github-pr-list-flag", "gh pr list has no --milestone flag; use --search 'milestone:VALUE' and --state merged for release notes.", i);
      }
      if (usesNativeTool(step.prompt, "gh issue list") && /--assignee\s+['"]?none\b/.test(resolved) && /\bunassigned\b|\bno assignee\b/.test(context)) {
        add("github-unassigned-query", "Use --search 'no:assignee' for unassigned issues; --assignee none means a user named none.", i);
      }
      if (["gh pr view", "gh pr list"].some((name) => usesNativeTool(step.prompt, name)) && /--json\s+['"]?[^'"\s;]*\brequestedreviewers\b/.test(resolved)) {
        add("github-json-field", "The gh PR JSON field is reviewRequests, not requestedReviewers.", i);
      }
    }
    if ((/\b(?:spreadsheet|worksheet|workbook|sheet)s?\b|\.(?:xlsx|csv)\b/.test(resolved)) &&
      /\b(?:read|open|load|write|edit|update|append|save|paste|record|format|add|clear|wipe|erase|delete)\b/.test(resolved)) {
      if (!usesNativeTool(step.prompt, "xlsx")) {
        add("spreadsheet-tool", "Name and use the xlsx built-in skill in this spreadsheet step; a filename or another step is not a tool.", i);
      }
      if (affirmativeMatch(step.prompt, /\b(?:open|launch)\s+(?:the\s+)?(?:numbers|excel)\b(?!\s+(?:workbook|spreadsheet|file|sheet)\b)|\b(?:open|launch)\b[^.;!?]{0,80}\b(?:in|using|with)\s+(?:numbers|excel)\b|\b(?:paste|click|type)\b[^.;!?]{0,60}\b(?:numbers|excel)\b/g)) {
        add("spreadsheet-ui", "Use the xlsx skill to read/write the workbook, not the Numbers/Excel desktop UI.", i);
      }
      if (affirmativeMatch(step.prompt, /\b(?:clear|wipe|erase|delete)\b[^.;!?]{0,100}\b(?:rows|sheet|spreadsheet|workbook|records)\b/g) &&
        !affirmativeMatch(analysis?.intent ?? "", /\b(?:clear|wipe|erase|delete)\b/g)) {
        add("unapproved-sheet-deletion", "Preserve existing spreadsheet data; the approved intent does not authorize clearing/deleting rows or the sheet.", i);
      }
    }
    if (azureDeploy && hasBrowserAction(step.prompt)) {
      add("azure-browser", "Use the az CLI for Azure operations and web_fetch or curl for the live endpoint; do not replay the Portal or browser UI.", i);
    }
    if (/\b(?:pdf|receipts?)\b/.test(resolved) && affirmativeMatch(step.prompt, /\bpreview\b/g)) {
      add("receipt-viewer-ui", "Read local receipt files with view, not the Preview desktop UI.", i);
    }
    if (expensifyTask && usesNativeTool(step.prompt, "expense-report")) {
      add("expense-skill-mismatch", "The expense-report skill is for internal Dynamics 365 workflows, not Expensify; use its authorized browser UI.", i);
    }
    const statementRead = /\b(?:read|fetch|extract|open|navigate\s+to|review)\b[^.;\n]{0,80}\b(?:amex[\w_]*|american express|recent activity)\b/.test(resolved) ||
      /\b(?:read|fetch|extract|open|navigate\s+to|review)\s+(?:the\s+)?(?:card\s+)?statement\b/.test(resolved);
    if (expensifyTask && statementRead &&
      (!usesNativeTool(step.prompt, "browser_navigate") || !usesNativeTool(step.prompt, "browser_snapshot"))) {
      add("expense-statement-tool", "Read the private card statement with browser_navigate and browser_snapshot; web_fetch or generic fetch prose does not establish authenticated access.", i);
    }
    if (/\bpdf\b/.test(context) && /\breceipts?\b/.test(context) && usesAny(["view"]) &&
      /\breceipts?\b[^.;\n]{0,100}\bpdf\b|\bpdf\b[^.;\n]{0,100}\breceipts?\b/.test(resolved) &&
      /\b(?:read|open|inspect|check|verify|extract)\b/.test(resolved) && !usesNativeTool(step.prompt, "view")) {
      add("receipt-step-tool", "Name view in the step that reads receipt PDFs; an unrelated step cannot supply its file-read tool.", i);
    }
    if (affirmativeMatch(step.prompt, /\bgit\s+push\b|\bpush\s+(?:the\s+)?(?:changes|commits?|tags?|branch)\b/g) &&
      !affirmativeMatch(approvedActions, /\bpush(?:ed|ing)?\b/g)) {
      add("unapproved-push", "Do not add a Git push: the approved recording/intent does not authorize publishing commits or tags.", i);
    }
  }
  if (/\b(?:spreadsheet|worksheet|workbook)s?\b|\.xlsx\b/.test(context) && !usesAny(["xlsx"])) {
    add("spreadsheet-tool", "The approved task includes a spreadsheet: use the xlsx built-in skill.");
  }
  if (/\bpublic\b/.test(context) && /\b(?:web|page|website|articles?)\b/.test(context) && !usesAny(["web_fetch"])) {
    add("public-web-tool", "Use web_fetch for public-page reads; generic fetch prose does not identify a catalogue tool.");
  }
  if (/\bdirectory\b/.test(normalizeToolText(analysis?.intent ?? "")) && !usesAny(["web_fetch", "workiq_search_people"])) {
    add("directory-tool", "Use web_fetch for a readable web directory or workiq_search_people for an M365 directory; do not invent access or export login state.");
  }
  if (/\b(?:mailbox|inbox)\b|\b(?:read|search|retrieve)\b[^.;!?]{0,60}\bemails?\b/.test(normalizeToolText(analysis?.intent ?? "")) && !usesAny(["workiq_search_emails", "workiq_list_emails", "workiq_get_email"])) {
    add("mail-tool", "Use the catalogue's WorkIQ email read tools, not the Mail desktop UI.");
  }
  if (azureDeploy && !usesAny(["az webapp", "az deployment"])) {
    add("azure-tool", "Use an explicit az webapp/deployment command for the approved deployment, not a generic CLI instruction.");
  }
  if (/\bpdf\b/.test(context) && /\breceipts?\b/.test(context) && !usesAny(["view"])) {
    add("receipt-read-tool", "Use view to read local receipt PDFs; mentioning a PDF or opening a viewer is not a native read tool.");
  }
  return issues;
}

export function assertNativeToolPlan(plan: AutomationPlan, analysis?: AnalysisSubmission): void {
  const issues = nativeToolPlanIssues(plan, analysis);
  if (issues.length) throw new Error(formatNativeToolIssues(issues));
}

export function formatNativeToolIssues(issues: NativeToolPlanIssue[]): string {
  return "Native-tool plan validation failed. Revise the affected prompts:\n" + issues.map((i) =>
    `- ${i.stepIndex === undefined ? "plan" : `step ${i.stepIndex + 1}`} [${i.code}]: ${i.message}`,
  ).join("\n");
}
