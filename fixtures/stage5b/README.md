# Stage 5B fixtures

These fixtures are sanitized receipts for the production Ziniao recording path.
They contain no real store ID, account reference, endpoint, proxy/IP, credential,
business URL, or captured field value.

Validated combination on 2026-09-18:

- Windows 11 x64
- `@ziniao-open/cli` 1.0.8
- Ziniao client 6.27.2.14
- Ziniao kernel 142.0.7444.168
- Node.js 24.19.0

Evidence is intentionally split:

- `evidence/ziniao-recording.json` records the full user-driven local Fixture
  flow, selected-PID isolation while two store browsers were open, Blueprint v2,
  and export. It retains one pre-fix contract Gap from a trusted click with
  `button=-1`; all required flow events and final Flush were present.
- `evidence/ziniao-fixed-sensor.json` is a second real human click captured by the
  fixed production sensor with normalized button, zero Gap, and successful Flush.
- `evidence/ziniao-fixture-host.json` verifies that the local Fixture, original
  pages, form, upload, iframe, Popup and SPA state remained isolated. Playwright's
  connected client did not observe the browser-default download content in this
  run; the production adapter did capture one download notification, while Stage
  5A separately verified the allowed-directory file and contents.

The generated Blueprint archive and raw session stay in ignored `.stage5b/`
storage because they contain machine/session-local evidence. Tests generate their
own synthetic stores and never depend on the approved real store.
