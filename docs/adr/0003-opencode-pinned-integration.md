# ADR 0003 — Pinned OpenCode protocol and configuration boundary

- Status: Accepted
- Date: 2026-09-05
- Scope: Stage 5A feasibility; no production Analyzer

## Context

OpenCode exposes a headless HTTP/OpenAPI server. Configuration comes from multiple
sources, and loading plugins/custom tools can execute code before a model tool
permission is considered. A configuration directory is not an OS security boundary.

## Decision

Use external OpenCode **1.18.29**, initially Windows x64. Detect/validate its version
and reviewed executable SHA-256 before using it; record the npm package integrity
in `fixtures/stage5a/toolchain.json`. Do not vendor the executable/source repository.
Install the exact external runtime explicitly for development; Stage 9A can build
on this detection strategy, but must separately review redistribution/packaging.
The upstream project is MIT licensed; the executable is not added to FlowCode's bundle.

Set both `OPENCODE_DISABLE_AUTOUPDATE=true` and `autoupdate:false`. Bind a random
loopback port, generate a fresh strong Basic-auth password, use argument arrays,
bound request sizes/timeouts, and kill the owned process tree on stop/failure.
Cold configuration dependency preparation gets a separate bounded probe timeout;
it is not treated as a model turn. Preserve the complete actual `/doc` response.

The real merge probe seeds only synthetic configuration in disposable directories.
It verifies global, standalone file, project, home `.opencode`, custom directory and
inline agents; the inline overlapping value wins while other keys merge. An actual
plugin writes a canary file and an actual custom tool import writes another. A
disabled global MCP entry remains in the merged config. These are executed loading
tests, not assertions about configuration strings.

The clean probe uses empty HOME/USERPROFILE and XDG config/data/cache/state roots,
an empty managed config directory, disabled project discovery, `--pure`, and a
minimal environment. The same seeded project then contributes no ambient agents,
MCP, plugin or tool. Do not copy arbitrary user project/global configuration into
this managed scope. Any additional loading surface or version needs revalidation.

The test agent denies all tools except the restricted probe MCP and OpenCode's
`StructuredOutput` tool. The real provider request confirms that these are the only
advertised tools. `StructuredOutput` requires an explicit allow in this version.

## Consequences

- A fake OpenCode server validates the client contract. Separately, the actual
  executable authenticates, calls the scope-checked test MCP, submits structured
  output and exits. A deterministic **local HTTP provider** drives two tool turns;
  this verifies protocol behavior, not model quality, cloud credentials or a 5C Eval.
- The raw OpenCode permission list contains inherited defaults; evaluating the final
  effective rules and real advertised tools matters more than finding a deny string.
- Config containment and the [Windows OS boundary](0004-windows-execution-isolation.md)
  are separate. The 5A probe host must not be used as an arbitrary-code production runner.
- Copilot and the original Describer/Builder are retained.

## Evidence and sources

`electron/opencode/`, `scripts/stage5a/opencode-smoke.ts`,
`scripts/stage5a/opencode-config-probe.ts`, and the recorded fixtures.
Primary references: [server API](https://opencode.ai/docs/server/),
[configuration](https://opencode.ai/docs/config/),
[pinned loading implementation](https://github.com/anomalyco/opencode/blob/v1.18.29/packages/opencode/src/config/config.ts),
[security boundary](https://github.com/anomalyco/opencode/blob/v1.18.29/SECURITY.md).
