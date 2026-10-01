# ADR 0007 — Read-only Analyzer and model boundary

- Status: Accepted (runtime policy; the default migration is gated separately)
- Date: 2026-10-01
- Scope: Stage 5C only; no generated-code Runner or Builder

## Context

The 2026-09-05 v1.1 roadmap requires versioned evidence-backed proposals, not
project writes. Prior ADRs 0003–0006 remain in force. A tool permission is not an
OS sandbox, a schema test is not a real runtime test, and a provider name is not
proof of Tool Calling, Vision or analysis quality.

## Decision

1. Use the external reviewed Windows x64 OpenCode 1.18.29 executable and exact
   SHA-256 from ADR 0003. No new package, redistributable binary or second Harness.
   Every run gets an empty managed working/config/HOME/XDG scope, minimal PATH,
   disabled project discovery/autoupdate/plugins/LSP/formatter and `--pure`.
   Require HTTP health **and** connected Evidence MCP before a model turn.
2. Use authenticated random loopback endpoints. The Analyzer advertises only the
   run-bound Evidence MCP tools; file/edit/shell/web/subagent tools are denied.
   The fixed reviewed OpenCode process is a **trusted host**, not an AppContainer
   workload. Its kill-on-close Job owns lifecycle, not security isolation.
   Unreviewed generated-code execution remains disabled, as ADR 0004 requires.
   The real zero-capability AppContainer canaries still pass with reachable
   positive controls; they do not certify OpenCode/npm/Playwright sandboxing.
3. Keep API keys in Windows Credential Manager. OpenCode receives a fresh broker
   token, not the provider key. Only the exact configured model's chat-completion
   route is forwarded. Scan message text, bound requests/responses/output tokens,
   and enforce time/turn/token/cost limits. Unknown usage is not reported as free.
   Account-wide Eval authorization additionally persists pre-request reservations;
   interrupted/unknown usage consumes its reservation and parallel runs share it.
4. At Standard evidence level, project raw events into bounded sanitized summaries.
   Never expose arbitrary paths, native store identities, raw CDP or network bodies.
   Bound rows, time windows, bytes, images and lifetime. Protected images require
   actual Vision **and** local OCR; unavailable/failed protection returns no pixels.
   Preview is one-use and bound to Blueprint, provider and human feedback. Revoke
   immediately invalidates tools and stops the owned process.
5. `project_get_context` returns scoped `unavailable/not-indexed`. No target file
   indexing or precise existing-target claims before 6A. A model proposes a derived
   revision through MCP; validate graph/scope/base and revalidate against the private
   authoritative base, preserving confirmed intent/assertions exactly. Compact
   patches reduce token overhead without bypassing contract validation.
6. Raw evidence and deterministic v1/v2 are preserved. User edits and model proposals
   are append-only revisions with hash-based concurrency control and comparisons.
   Review flags are scope/version-bound. Preflight distinguishes schema validity,
   continued review and generation conditions, with concrete blockers. No JSON file
   or human confirmation grants code execution.
7. Freeze the original nine Describer cases and twelve additional synthetic
   Chrome/Edge/Ziniao cases. Compare each real OpenCode result against the frozen
   real Copilot baseline, including every rubric check, confirmed assertions and
   scope/privacy checks. Retain failed trials; do not cherry-pick successful subsets.
   Switch FlowCode's default Analyzer only after the complete migration gate passes;
   retain the unchanged Copilot Describer/Builder and legacy UI.

## Consequences

- Windows x64 is the reviewed production runtime; other platforms/versions fail
  closed until reviewed. Runtime detection is not an automatic install/upgrade.
- Model endpoints receive only explicitly authorized projected evidence; provider
  retention policy and changing availability remain external limitations.
- For the user-authorized DeepSeek trial, only the official endpoint uses the
  documented non-thinking tool mode, because the pinned compatible SDK does not
  replay `reasoning_content`. Keys are transferred from the authorized Harness
  reference directly to the vault; Harness files are not modified.
- The user's RMB 20 ceiling covers probes, failures and all Eval attempts. Peak
  cache-miss USD rates multiplied by 8 conservatively upper-bound the published
  CNY prices. The persisted total ceiling is USD 2.50; no recharge is authorized.
- Runtime/protocol, model quality, OS canaries, browser capture and future business
  execution are distinct evidence. Existing-target indexing, Builder, login/Runner,
  business execution and packaging remain outside 5C.

## Evidence and sources

`electron/analyzer/`, `electron/opencode/service.ts`, `scripts/stage5c/`,
`evals/analyzer/`, `fixtures/stage5c/` and the stage delivery record.

Primary sources: [OpenCode server API](https://opencode.ai/docs/server/),
[pinned configuration loading](https://github.com/anomalyco/opencode/blob/v1.18.29/packages/opencode/src/config/config.ts),
[DeepSeek tool/thinking compatibility](https://api-docs.deepseek.com/guides/thinking_mode/),
[DeepSeek published price ceilings](https://api-docs.deepseek.com/quick_start/pricing/).
