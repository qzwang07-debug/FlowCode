# ADR 0005 — Ziniao recording and project-connection path

- Status: Accepted for the validated versions and scope below
- Date: 2026-09-05
- Scope: Stage 5A decision; production recording UI/adapter is Stage 5B

## Context

The user selected one exact store for testing. The installed CLI is **1.0.8**, the
client **6.26.6.7**, the browser kernel **142.0.7444.168**, and Playwright **1.62.1**.
CLI query/page-control interfaces are not themselves human-event recording APIs.
The npm CLI package is UNLICENSED, so FlowCode detects the installed executable
and verifies its version/hash; it does not redistribute it.

## Decision

Select a **CDP isolated-world semantic adapter** for the first production path.
The live `Extensions.loadUnpacked` probe returned `Method not available` on this
launch. A complete extension/Native Messaging chain was not established and remains
unknown; no guessed Ziniao registry keys or Chrome/Edge registration changes were made.
Do not maintain a second production capture implementation in 5B.

The version-bound discovery prototype resolves the user-selected name, verifies
the exact returned store ID and authoritative paginated list, locates exactly one
non-renderer `ziniaobrowser.exe` whose profile leaf is `chrome_<storeId>`, verifies
the kernel version, and inspects only loopback listeners owned by that PID. Exactly
one compatible `/json/version` endpoint must exist, and its websocket host must
match the owned listener. Recheck CLI account/config and store binding before use.
There is no fixed debugging port and no arbitrary local CDP scan. This is a documented
local discovery mechanism tied to these versions, not a claimed vendor CDP API.

CLI 1.0.8 can echo a supplied `expected-name` during ID resolution. The service
therefore independently compares ID/name against the authoritative list and rejects
duplicates, changed pagination, wrong names and changed account/config fingerprints.
Config contents and credentials never enter logs or fixtures. A 30-second initial
open call timed out, but subsequent state checks showed the store running; it was
not blindly relaunched. Cold kernel download/preparation responses remain unverified.

The live sensor prototype reuses FlowCode's locator and sensitive-field helpers.
It accepts `isTrusted` events in a named isolated world, binds the runtime context
to browser-reported frame identity/URL, and bounds retained events. This kernel
does not supply the expected isolated-world Origin, so Origin alone is not used as
the identity proof. Main-world scripts cannot access the binding; synthetic DOM
dispatch is excluded. Host-driven actions and the user's real manual input/click
are recorded as different actors. Start participation and Stop/Flush are scoped
to actual active sensor contexts, not every context the browser creates.

Playwright `connectOverCDP` successfully reuses the selected store's existing
context with `{ noDefaults: true, isLocal: true }`. The final probe preserves real
focus and explicitly returns from its popup before continuing. It observes browser-default
download completion, verifies the file's resolved path is inside the CLI-reported
allowed directory, validates its contents, and imports a copy. Early exploratory
Playwright default overrides were reset to the browser's own download policy;
the final probe confirms that policy is restored. No download path is redirected
to Playwright temporary storage in the selected connection scheme.

The test creates and closes only its own fixture pages; the original page
and the store remain open. No profile copy, Cookie/storageState export, proxy or
fingerprint modification is performed.

## Test-environment constraints

This client blocked direct loopback and `.test` navigation. Tests used a random
nonce path on the already-authorized origin and a second port for cross-origin
iframe coverage. Only those exact fixture routes were fulfilled with local bytes;
no test request was sent to the business server and no original tab was navigated.
This proves the browser transport/DOM path, not unrestricted site access.

Actual proof covers manual input/click, automated trusted input/select/check/submit,
same/cross-origin frames, open Shadow DOM, SPA/document navigation, Popup notification,
upload metadata, download completion/import, password blocking and final Flush with
zero gaps. Separate actions-only Trace and fixture screenshot probes passed.
Trace disabled snapshots/screenshots/sources and recorded zero network bytes/resources.
Full Trace, video, cold kernel preparation, reconnect and adversarial two-store E2E
remain unknown; they are not inferred from connection success.

## Consequences

- 5B implements production selection, source lifecycle, leases, buffering/dedup,
  recovery/gaps, approved-page/Popup scope and deterministic Blueprint mapping using
  this path. The development sensor is not production registration or a completed 5B.
- 6A integrates the existing-context connection into Runtime/Fixture for the two
  project types. Generated projects use logical environment/page references.
- Native Messaging remains unverified for Ziniao; Chrome/Edge behavior is preserved.
- Every version/capability change must be revalidated. Unknown/unsupported results
  must be visible rather than silently using an empty ordinary browser.

## Evidence and sources

`electron/ziniao/`, `scripts/stage5a/ziniao-*.ts`, `semantic-sensor.ts`,
and `fixtures/stage5a/evidence/ziniao-*.json`. The manual receipt is separate from
the final automatic Flush regression; its earlier Flush gap is retained honestly.
See the [capability matrix](../stage-5a-capabilities.md),
[original integration contract](../ziniao-integration.md), and the
[Playwright CDP documentation](https://playwright.dev/docs/api/class-browsertype#browser-type-connect-over-cdp).
