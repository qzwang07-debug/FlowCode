import assert from "node:assert/strict";
import test from "node:test";

import { builderScenarios } from "./scenarios";
import { scoreBuilder } from "./score";

const rubric = (id: string) => builderScenarios.find((s) => s.id === id)!.rubric;

test("CLI formatting and whitespace do not change tool selection", () => {
  for (const text of ["Use the `gh` CLI: `gh pr list`, then `gh pr comment`.",
    "Use **GH** PR\n  LIST and GH\tPR COMMENT."]) {
    assert.equal(scoreBuilder(text, rubric("github-stale-pr-nudge")).pass, true);
  }
});

test("generic GitHub browser fallback fails even alongside valid gh commands", () => {
  for (const fallback of ["Use browser to fill and submit the PR comment form.",
    "Navigate to the PR page on github.com and post the reminder.",
    "Open the PR page in Chrome and submit the comment."]) {
    const score = scoreBuilder(`Use gh pr list to find stale PRs. ${fallback}`, rubric("github-stale-pr-nudge"));
    assert.equal(score.pass, false, fallback);
    assert.ok(score.checks.some((c) => !c.pass && c.name.includes("browser")));
  }
});

test("negated tools, file extensions and URLs are not tool-use evidence", () => {
  for (const text of ["Do not use web_fetch. Use the xlsx skill to edit the sheet.",
    "web_fetch is unavailable. Use the xlsx skill.",
    "Use web_fetch to read the page; append the prices to Budget.xlsx.",
    "Read https://example.test/web_fetch; use the xlsx skill."]) {
    assert.equal(scoreBuilder(text, rubric("web-to-spreadsheet")).pass, false, text);
  }
  assert.equal(scoreBuilder("Fetch the HTML and use the xlsx skill.", rubric("web-to-spreadsheet")).pass, false);
});

test("genuine browser-only invoice/CRM flows remain allowed", () => {
  assert.equal(scoreBuilder("Use browser_navigate and browser_snapshot to read the invoices; use the xlsx skill to append all rows.", rubric("invoice-extract")).pass, true);
  assert.equal(scoreBuilder("Use workiq_search_emails to read leads; use browser automation to enter each lead in the CRM.", rubric("lead-to-crm")).pass, true);
  assert.equal(scoreBuilder("Use core/web_fetch to read prices and the xlsx skill to write the sheet.", rubric("web-to-spreadsheet")).pass, true);
  assert.equal(scoreBuilder("Use web_fetch to read articles; save the quotes in notes.md.", rubric("research-compile")).pass, true);
  assert.equal(scoreBuilder("Do not use a browser\nUse web_fetch to read prices\nUse xlsx to edit the sheet", rubric("web-to-spreadsheet")).pass, true);
});

test("original ten cases and required/forbidden groups are retained", () => {
  assert.equal(builderScenarios.length, 10);
  assert.deepEqual(rubric("github-stale-pr-nudge"), {
    mustUseAny: [["gh "], ["gh pr", "gh api"]],
    forbidden: ["playwright", "browser_", "click", "navigate to github", "github.com/acme"],
  });
  assert.deepEqual(rubric("web-to-spreadsheet").mustUseAny, [["web_fetch"], ["xlsx"]]);
  assert.deepEqual(rubric("windows-deploy").mustUseAny, [["az "], ["az webapp", "az login", "az group", "az account"], ["xlsx"]]);
});
