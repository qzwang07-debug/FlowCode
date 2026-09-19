# ADR 0006 — Ziniao production semantic recording

- Status: Accepted
- Date: 2026-09-18
- Scope: Stage 5B only; Analyzer and project execution remain out of scope

## Context

ADR 0005 selected a version-bound CDP isolated-world path after the extension
path was unavailable. Stage 5A intentionally stopped at feasibility probes. Stage
5B must turn that path into a user-facing, single-store recording source without
exposing endpoints or treating CLI page control as human recording.

The installed client upgraded from 6.26.6.7 to 6.27.2.14 while retaining CLI
1.0.8 and kernel 142.0.7444.168. Production therefore continued to reject the new
client until the full Stage 5B Fixture and post-fix sensor regression completed.

## Decision

Use one `BrowserCaptureCoordinator` to activate exactly one semantic channel per
recording. Chrome/Edge keep their existing extension/Native Bridge. Ziniao uses:

1. paginated CLI search and exact ID/name/account verification;
2. a local `BrowserEnvironmentProfile` plus an exclusive, persisted recording
   lease;
3. selected-PID and owned-loopback endpoint discovery for validated client/kernel
   versions only;
4. an opaque preparation/page capability in Renderer IPC—never a target ID,
   endpoint, command, credential, or arbitrary path;
5. a bundled isolated-world sensor reusing FlowCode Locator and privacy helpers;
6. host-assigned sequence/event IDs, packet deduplication, bounded persistence,
   approved Origin/frame chains, associated-Popup scope, Flush and explicit Gaps;
7. immutable browser evidence mapped deterministically to sealed Blueprint v2.

The UI explicitly authorizes current cross-origin iframe Origins. Store/page
preparations expire, are extended only while a recording may reconnect, and are
deleted on terminal cleanup. Stopping detaches FlowCode's CDP sessions and releases
the lease; it does not close the store or pre-existing pages.

Client 6.27.2.14 joins 6.26.6.7 in the production allowlist only after the real
evidence in `fixtures/stage5b` passed. Kernel changes still fail closed.

## Consequences

- A store launch error marked “state check required” is followed by exact state
  polling and is never blindly reissued. CLI 1.0.8 `store open` is invoked without
  a fabricated `--format` flag.
- Two simultaneously open store browsers were present during the real run; only
  the selected profile/PID/target produced the single captured source.
- A pre-fix trusted click with `button=-1` produced an explicit retained Gap. The
  sensor now normalizes non-mouse trusted clicks to button 0; a second real human
  click passed with zero Gap and successful Flush. Raw pre-fix evidence is not
  rewritten.
- Reconnect logic is implemented with exact identity revalidation and covered by
  deterministic tests. A forced real disconnect remains `unknown` in the matrix,
  not promoted from unit coverage.
- Project running, login recovery, Builder, Evidence MCP and Analyzer remain for
  5C/6 and are not exposed by this implementation.

## Evidence

Production code lives in `electron/ziniao/`, shared contracts in
`common/ziniao-recording.ts`, UI in `src/ziniao/`, and deterministic mapping in
`electron/evidence/blueprint-builder.ts`. See the
[Stage 5B acceptance record](../baselines/2026-09-18-stage-5b.md) and
[capability matrix](../stage-5b-capabilities.md).
