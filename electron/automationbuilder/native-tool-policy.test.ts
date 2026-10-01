import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { AutomationPlanSchema } from "../../common/automation";
import { builderScenarios } from "../../evals/builder/scenarios";
import { nativeToolPlanIssues } from "./native-tool-policy";
import { createAutomationBuilderTools } from "./tools";
import { AutomationBuilder, loadPersistedAutomation } from "./builder";
import { seedScenario } from "../../evals/lib/seed";
import { scoreBuilder } from "../../evals/builder/score";

const analysis = (id: string) => builderScenarios.find((s) => s.id === id)!.analysis;
const plan = (prompts: string[], values: { id: string; name: string; value: string }[] = []) => AutomationPlanSchema.parse({
  architecture: "scout", name: "test-plan", title: "Test", description: "Test plan",
  trigger: { schedule: { kind: "single", time: { hour: 9, minute: 0 } } },
  values, steps: prompts.map((prompt) => ({ label: "Step", prompt })),
});

test("GitHub browser comment fallback and unsupported-CLI claim are rejected", () => {
  const bad = plan(["Use the `gh` CLI to query open PRs.",
    "For each PR, navigate to the PR page on github.com and post a reminder. Use browser to fill and submit the form."]);
  const issues = nativeToolPlanIssues(bad, analysis("github-stale-pr-nudge"));
  assert.ok(issues.some((i) => i.code === "github-browser" && i.stepIndex === 1));
  assert.ok(issues.some((i) => i.code === "github-comment-tool"));
  const good = plan(["Use `gh pr list -R {{repo}} --state open --search review:required` to find all stale PRs.",
    "For each matching PR use `gh pr comment -R {{repo}} --body-file reminder.txt` to post the reminder."]);
  assert.deepEqual(nativeToolPlanIssues(good, analysis("github-stale-pr-nudge")), []);
});

test("value-bound GitHub browser steps are rejected but deployed-site health reads are allowed", () => {
  const values = [{ id: "repo_url", name: "Repository", value: "https://github.com/acme/api" }];
  assert.ok(nativeToolPlanIssues(plan(["Use browser_navigate to open {{repo_url}} and post a comment."], values)).some((i) => i.code === "github-browser"));
  assert.deepEqual(nativeToolPlanIssues(plan(["Use gh pr list to gather merged PRs.",
    "Use git and npm to deploy; use web_fetch to verify the health endpoint."]), analysis("release-notes")), []);
});

test("spreadsheet editing requires a tool in that prompt, not a filename or another step", () => {
  for (const text of ["Open the spreadsheet in Numbers and paste all rows.",
    "Append the live URL to Deployments.xlsx and save.", "Do not use xlsx; edit the sheet in Excel."]) {
    const issues = nativeToolPlanIssues(plan(["Use the xlsx skill to read the existing sheet.", text]));
    assert.ok(issues.some((i) => i.code === "spreadsheet-tool" && i.stepIndex === 1), text);
  }
  assert.deepEqual(nativeToolPlanIssues(plan(["Use web_fetch to read prices; use the xlsx built-in skill to append all prices to the spreadsheet."]), analysis("web-to-spreadsheet")), []);
});

test("missing read tools are rejected; real UI-only invoice, expense and CRM steps stay valid", () => {
  assert.ok(nativeToolPlanIssues(plan(["Fetch {{pricing_url}} as HTML.", "Use xlsx to write the sheet."]), analysis("web-to-spreadsheet")).some((i) => i.code === "public-web-tool"));
  assert.ok(nativeToolPlanIssues(plan(["Navigate to the directory and search for each person.", "Use xlsx to write the contacts."]), analysis("directory-lookup")).some((i) => i.code === "directory-tool"));
  assert.deepEqual(nativeToolPlanIssues(plan(["Use web_fetch for the public directory, or workiq_search_people for the M365 directory.", "Use the xlsx skill to append every contact to the spreadsheet."]), analysis("directory-lookup")), []);
  assert.deepEqual(nativeToolPlanIssues(plan(["Use browser_navigate and browser_snapshot to read all invoice rows.", "Use the xlsx skill to append each invoice to the spreadsheet."]), analysis("invoice-extract")), []);
  assert.deepEqual(nativeToolPlanIssues(plan(["Use browser_navigate and browser_snapshot to read the statement; use view to read local PDF receipts.", "Use browser automation to file and submit the report."]), analysis("expense-report")), []);
  assert.deepEqual(nativeToolPlanIssues(plan(["Use workiq_search_emails to read leads.", "Use browser automation for each CRM contact."]), analysis("lead-to-crm")), []);
});

test("tool names in labels/summary cannot authorize an unsupported step", () => {
  const p = plan(["Append the URL to the spreadsheet and save."]);
  p.steps[0].label = "Use xlsx";
  p.summary = "Use xlsx for all spreadsheets.";
  assert.ok(nativeToolPlanIssues(p).some((i) => i.code === "spreadsheet-tool"));
});

test("proposal tool rejects invalid plans without publishing them; valid retry is unchanged", async () => {
  const proposed: unknown[] = [];
  const tool = createAutomationBuilderTools({ architecture: "scout", analysis: analysis("github-stale-pr-nudge"), onPlan: (p) => proposed.push(p) })[0];
  const bad = plan(["Use gh pr list for stale PRs.", "Use browser to post a comment on each PR."]);
  const rejected = await tool.handler!(bad, {} as never) as { resultType: string; textResultForLlm: string };
  assert.equal(rejected.resultType, "failure");
  assert.match(rejected.textResultForLlm, /gh pr comment/);
  assert.equal(proposed.length, 0);
  const good = plan(["Use gh pr list to find all stale PRs.", "Use gh pr comment to post a reminder on each PR."]);
  await tool.handler!(good, {} as never);
  assert.deepEqual(proposed, [good]);
});

test("schema rejection is preserved and empty prompts cannot become a ready plan", async () => {
  let published = false;
  const tool = createAutomationBuilderTools({ architecture: "scout", onPlan: () => { published = true; } })[0];
  for (const p of [{}, plan([]), plan([" "])]) {
    const rejected = await tool.handler!(p, {} as never) as { resultType: string };
    assert.equal(rejected.resultType, "failure");
  }
  assert.equal(published, false);
});

test("a later rejection clears the candidate, including schema failures", async () => {
  let held: unknown;
  const tool = createAutomationBuilderTools({ architecture: "scout", onPlan: (p) => { held = p; }, onRejectedPlan: () => { held = undefined; } })[0];
  await tool.handler!(plan(["Use web_fetch to read the public page."]), {} as never);
  assert.ok(held);
  await tool.handler!({}, {} as never);
  assert.equal(held, undefined);
  await tool.handler!(plan([" "]), {} as never);
  assert.equal(held, undefined);
});

test("export rechecks edited steps/architecture, preserves old files and exports valid tiles exactly", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "fc-native-policy-test-"));
  const sessions = path.join(root, "sessions");
  const exports = path.join(root, "exports");
  const priorSessions = process.env.SKILL_RECORDER_SESSIONS_DIR;
  const priorExports = process.env.SKILL_RECORDER_AUTOMATIONS_DIR;
  process.env.SKILL_RECORDER_SESSIONS_DIR = sessions;
  process.env.SKILL_RECORDER_AUTOMATIONS_DIR = exports;
  const builder = new AutomationBuilder(() => undefined);
  try {
    await assert.rejects(builder.create("orphan-session", plan(["Use web_fetch to read a public page."])),
      /analysis.*recording/i);
    assert.equal(existsSync(exports), false);
    const scenario = builderScenarios.find((s) => s.id === "github-stale-pr-nudge")!;
    seedScenario(sessions, scenario);
    const bad = plan(["Use gh pr list for stale PRs.", "Use browser to submit a PR comment."]);
    await assert.rejects(builder.create(scenario.id, bad), /Native-tool plan validation failed/);
    assert.equal(existsSync(exports), false);
    const good = plan(["Use gh pr list to find every stale PR.", "Use gh pr comment to post a reminder on each PR."]);
    const result = await builder.create(scenario.id, good);
    assert.deepEqual(JSON.parse(readFileSync(result.path, "utf8")).steps, good.steps);
    assert.deepEqual(loadPersistedAutomation(scenario.id)?.plan, good);
    const historicalDir = path.join(sessions, "historical-session");
    mkdirSync(historicalDir, { recursive: true });
    writeFileSync(path.join(historicalDir, "built-automation.json"),
      JSON.stringify({ ...result.automation, sessionId: "historical-session", plan: null }));
    assert.equal(loadPersistedAutomation("historical-session")?.name, good.name);
    const original = readFileSync(result.path, "utf8");
    await assert.rejects(builder.create(scenario.id, bad), /Native-tool plan validation failed/);
    await assert.rejects(builder.create(scenario.id, { ...good, architecture: "cowork" }), /architecture.*available/i);
    assert.equal(readFileSync(result.path, "utf8"), original);
    assert.deepEqual(loadPersistedAutomation(scenario.id)?.plan, good);
  } finally {
    await builder.dispose();
    if (priorSessions === undefined) delete process.env.SKILL_RECORDER_SESSIONS_DIR;
    else process.env.SKILL_RECORDER_SESSIONS_DIR = priorSessions;
    if (priorExports === undefined) delete process.env.SKILL_RECORDER_AUTOMATIONS_DIR;
    else process.env.SKILL_RECORDER_AUTOMATIONS_DIR = priorExports;
    rmSync(root, { recursive: true, force: true });
  }
});

test("native xlsx editing is not mistaken for opening the Excel desktop UI", () => {
  assert.deepEqual(nativeToolPlanIssues(plan(["Use the xlsx skill to open the Excel workbook and append all rows to the spreadsheet."])), []);
  assert.ok(nativeToolPlanIssues(plan(["Use xlsx to read the spreadsheet, then open Numbers and paste all rows into it."])).some((i) => i.code === "spreadsheet-ui"));
  assert.deepEqual(nativeToolPlanIssues(plan(["Locate the spreadsheet file using glob.", "Use the xlsx skill to append all prices to the sheet.", "Use web_fetch to read prices."]), analysis("web-to-spreadsheet")), []);
});

test("documented PR review/date qualifiers replace invented query syntax", () => {
  const bad = plan(["Use gh pr list --search 'review:awaited created:<2_days_ago' for stale PRs.", "Use gh pr comment to post a reminder."]);
  const issues = nativeToolPlanIssues(bad, analysis("github-stale-pr-nudge"));
  assert.ok(issues.some((i) => i.code === "github-review-query"));
  assert.ok(issues.some((i) => i.code === "github-date-query"));
  const good = plan(["Use PowerShell to compute the ISO cutoff date; use gh pr list -R {{repo}} --search 'review:required created:<DATE' to find stale PRs.", "Use gh pr comment -R {{repo}} to post a reminder on each PR."]);
  assert.deepEqual(nativeToolPlanIssues(good, analysis("github-stale-pr-nudge")), []);
});

test("each GitHub action names its tool, not only another step", () => {
  const bad = plan(["List open unassigned GitHub bug issues using the CLI.", "Use gh issue comment to request details."]);
  assert.ok(nativeToolPlanIssues(bad, analysis("github-issue-triage")).some((i) => i.code === "github-step-tool" && i.stepIndex === 0));
  const changelogCover = plan([
    "Use gh pr list -R {{repo}} to get a preliminary count.",
    "Use the generic CLI to fetch GitHub merged PRs for CHANGELOG.md, then append the titles.",
  ]);
  assert.ok(nativeToolPlanIssues(changelogCover, analysis("release-notes")).some((i) =>
    i.code === "github-step-tool" && i.stepIndex === 1));
  assert.deepEqual(nativeToolPlanIssues(plan(["Use gh pr list -R {{repo}} to fetch merged PRs.", "Read CHANGELOG.md; append the merged PR titles using the local file tools."]), analysis("release-notes")), []);
});

test("PR milestone queries cannot inherit the issue-list-only --milestone flag", () => {
  assert.ok(nativeToolPlanIssues(plan(["Use gh pr list --milestone {{milestone}} --state merged for merged PRs."]), analysis("release-notes")).some((i) => i.code === "github-pr-list-flag"));
  assert.deepEqual(nativeToolPlanIssues(plan(["Use gh pr list -R {{repo}} --state merged --search 'milestone:{{milestone}}' --json number,title to gather merged PRs."]), analysis("release-notes")), []);
  for (const flag of ["--web", "-w"]) {
    assert.ok(nativeToolPlanIssues(plan([`Use gh pr comment ${flag} to post a reminder on the PR.`]), analysis("github-stale-pr-nudge")).some((i) => i.code === "github-browser"));
  }
});

test("Azure deploy and live-endpoint checks do not silently fall back to browser UI", () => {
  const bad = plan(["Use az webapp up to deploy.", "Open the deployed URL in a web browser.", "Use xlsx to append the URL to the spreadsheet."]);
  assert.ok(nativeToolPlanIssues(bad, analysis("windows-deploy")).some((i) => i.code === "azure-browser" && i.stepIndex === 1));
  const good = plan(["Use az webapp up in PowerShell to deploy.", "Use web_fetch to check the live URL.", "Use the xlsx skill to append the URL to the spreadsheet."]);
  assert.deepEqual(nativeToolPlanIssues(good, analysis("windows-deploy")), []);
});

test("local PDF reads use view and table updates cannot invent destructive clearing", () => {
  const bad = plan(["Open each receipt PDF in Preview.", "Use browser automation to submit the expense report."]);
  const issues = nativeToolPlanIssues(bad, analysis("expense-report"));
  assert.ok(issues.some((i) => i.code === "receipt-read-tool"));
  assert.ok(issues.some((i) => i.code === "receipt-viewer-ui"));
  const good = plan(["Use view to read each local receipt PDF.", "Use browser automation to submit the expense report."]);
  assert.deepEqual(nativeToolPlanIssues(good, analysis("expense-report")), []);
  const unrelatedView = plan([
    "Use browser_navigate and browser_snapshot to read the card statement and each matching receipt PDF.",
    "Use view to read a local configuration note.",
    "Use browser automation to file the verified expenses and submit the report.",
  ]);
  assert.ok(nativeToolPlanIssues(unrelatedView, analysis("expense-report")).some((i) =>
    i.code === "receipt-step-tool" && i.stepIndex === 0));
  const destructive = plan(["Use web_fetch to read contacts.", "Use xlsx to clear or append to the existing contacts sheet and save."]);
  assert.ok(nativeToolPlanIssues(destructive, analysis("directory-lookup")).some((i) => i.code === "unapproved-sheet-deletion"));
  assert.deepEqual(nativeToolPlanIssues(plan(["Use xlsx to clear existing rows in the spreadsheet."]), { ...analysis("web-to-spreadsheet"), intent: "Clear the existing spreadsheet rows.", steps: [] }), []);
});

test("Expensify cannot borrow the Dynamics-only expense skill or fetch a private card statement", () => {
  const wrongSkill = plan([
    "Use browser_navigate and browser_snapshot to read the Amex card statement.",
    "Use view to read each matching receipt PDF.",
    "Use the expense-report skill to create each Expensify expense and submit the report.",
  ]);
  assert.ok(nativeToolPlanIssues(wrongSkill, analysis("expense-report")).some((i) =>
    i.code === "expense-skill-mismatch" && i.stepIndex === 2));
  const privateFetch = plan([
    "Use web_fetch to read all charges from the Amex card statement.",
    "Use view to read each matching receipt PDF.",
    "Use browser_navigate and browser_snapshot to file verified expenses in Expensify.",
  ]);
  assert.ok(nativeToolPlanIssues(privateFetch, analysis("expense-report")).some((i) =>
    i.code === "expense-statement-tool" && i.stepIndex === 0));
});

test("release generalization cannot invent Git publication or treat a prohibition as approval", () => {
  for (const publish of ["Run git push to publish the version commit and tags.", "Commit and push the changes."]) {
    const p = plan(["Use gh pr list to read merged PRs.", publish]);
    assert.ok(nativeToolPlanIssues(p, analysis("release-notes")).some((i) => i.code === "unapproved-push"));
    assert.ok(nativeToolPlanIssues(p, { ...analysis("release-notes"), intent: "Prepare a release but do not push changes." }).some((i) => i.code === "unapproved-push"));
    assert.ok(nativeToolPlanIssues(p, { ...analysis("release-notes"), intent: "Prepare a release. No push." }).some((i) => i.code === "unapproved-push"));
    assert.deepEqual(nativeToolPlanIssues(p, { ...analysis("release-notes"), intent: "Prepare the release and push the approved version commit and tags." }), []);
  }
  assert.deepEqual(nativeToolPlanIssues(plan(["Use gh pr list to read merged PRs.", "Run npm version minor to commit locally. Do not run git push."]), analysis("release-notes")), []);
});

test("unassigned issue search and PR reviewer JSON use documented native syntax", () => {
  const unassigned = plan(["Use gh issue list --assignee none to find unassigned issues.", "Use gh issue comment to ask for details."]);
  assert.ok(nativeToolPlanIssues(unassigned, analysis("github-issue-triage")).some((i) => i.code === "github-unassigned-query"));
  const reviewers = plan(["Use gh pr view --json requestedReviewers,comments for each PR.", "Use gh pr comment to post a reminder."]);
  assert.ok(nativeToolPlanIssues(reviewers, analysis("github-stale-pr-nudge")).some((i) => i.code === "github-json-field"));
  assert.deepEqual(nativeToolPlanIssues(plan(["Use gh pr view --json reviewRequests,comments to read each PR.", "Use gh pr comment to post a reminder."]), analysis("github-stale-pr-nudge")), []);
});

test("authored native-tool fixtures cover all ten original cases without a model or business execution", async () => {
  // These are authored regression examples, NOT real-model acceptance evidence.
  const prompts: Record<string, string[]> = {
    "github-issue-triage": ["Use gh issue list -R {{repo}} --state open --label bug --search 'no:assignee' to find all unassigned bug issues.", "Use gh issue comment -R {{repo}} to request reproduction details and gh issue edit --add-label needs-info for each issue."],
    "github-stale-pr-nudge": ["Use gh pr list -R {{repo}} --search 'review:required' to find all stale PRs, computing the ISO cutoff at runtime.", "Use gh pr comment -R {{repo}} to post a reminder to every qualifying PR."],
    "web-to-spreadsheet": ["Use web_fetch to read public plan prices.", "Use the xlsx skill to update monthly and annual prices in the spreadsheet."],
    "invoice-extract": ["Use web_fetch for a public invoice table; if authorized and UI-only, use browser_navigate and browser_snapshot to read all invoice rows.", "Use the xlsx skill to append new invoice rows to the spreadsheet and preserve existing rows."],
    "research-compile": ["Use web_fetch to read the research articles.", "Write the quotes and sources to the notes.md file, preserving previous entries."],
    "directory-lookup": ["Use web_fetch to read the authorized web directory; stop safely if inaccessible.", "Use the xlsx skill to add or update contact rows in the spreadsheet and preserve other rows."],
    "expense-report": ["Use browser_navigate and browser_snapshot to read the authorized card statement.", "Use view to read each matching local receipt PDF.", "Use browser automation to file verified expenses and submit the report."],
    "release-notes": ["Use git to pull the latest main.", "Use gh pr list -R {{repo}} --state merged --search 'milestone:VALUE' to collect merged PRs.", "Read CHANGELOG.md with view and append the PR titles using local file tools.", "Run npm version minor to commit locally, then the recorded deployment script; use curl for the health check."],
    "windows-deploy": ["Use az webapp up in PowerShell to deploy the app.", "Use web_fetch to verify the live endpoint.", "Use the xlsx skill to append the verified URL to the deployment spreadsheet."],
    "lead-to-crm": ["Use workiq_search_emails to read the sales lead mailbox.", "Use browser automation for the authorized LinkedIn lookup and Salesforce contact creation."],
  };
  for (const scenario of builderScenarios) {
    const p = plan(prompts[scenario.id], [{ id: "repo", name: "Fixture repository", value: "acme/api" }]);
    assert.deepEqual(nativeToolPlanIssues(p, scenario.analysis), [], scenario.id);
    assert.equal(scoreBuilder(p.steps.map((s) => s.prompt).join("\n"), scenario.rubric).pass, true, scenario.id);
    let accepted: unknown;
    const tool = createAutomationBuilderTools({ architecture: "scout", analysis: scenario.analysis, onPlan: (value) => { accepted = value; } })[0];
    await tool.handler!(p, {} as never);
    assert.deepEqual(accepted, p, scenario.id);
  }
});
