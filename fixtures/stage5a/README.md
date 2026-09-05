# Stage 5A fixtures and actual evidence

These files follow the 2026-09-05 v1.1 documents. Fixtures contain no real store ID,
account name, API key, IP, business-page URL or reusable CDP endpoint. Runtime files,
raw diagnostic traces, screenshots and downloaded external tools stay under the
ignored `.stage5a/` directory. The actual user-selected environment stays open.

## What each artifact proves

- `blueprint-v1.json`: complete historical-contract example; v1 remains readable.
- `blueprint-v2.json`: independent complete fixture, canonical hash and graph references.
- `schemas/`: generated structural JSON Schemas. Zod graph checks and hash validation
  remain mandatory; these files do not establish readiness, consent or redaction.
- `ziniao-responses.json`: sanitized observed command-specific response shapes and
  startup/name-echo observations. It does not invent a kernel-download response.
- `toolchain.json`: fixed versions, executable hashes and npm integrity.
- `ziniao-capabilities.json`: version-bound machine-readable matrix; unsupported
  and unknown capabilities are retained, and supported entries reference receipts.
- `opencode-1.18.29.openapi.json`: complete actual `GET /doc` response (162 paths),
  not a handwritten fake. `evidence/openapi-provenance.json` records capture provenance.
  Its upstream copyright/license is retained in `OPENCODE-LICENSE.txt`, from
  [the pinned upstream license](https://github.com/anomalyco/opencode/blob/v1.18.29/LICENSE).
- `evidence/opencode-smoke.json`: actual server/auth/MCP/structured-output/shutdown.
  The provider is a local deterministic HTTP fixture, not an actual model.
- `evidence/opencode-config.json`: real merged and contained configuration loading;
  plugins/custom tools actually execute harmless canaries in the merge case.
- `evidence/windows-isolation.json`: real OS positive controls and restricted .NET/Node
  children. This is a fixed workload, not a production multi-process Runner.
- `evidence/ziniao-manual-capture.json`: the user's real manual input/click was captured.
  This historical attempt still shows its Flush gap; do not call the whole attempt a pass.
- `evidence/ziniao-browser.json`: final capture/Flush regression; automatic actor,
  navigation reinjection, trusted events, redaction, 0 gaps and original-page retention.
- `evidence/ziniao-artifacts.json`: existing-context actions-only Trace/screenshot,
  CLI download-directory metadata, actual wrong-name rejection and binding recheck.
- `evidence/ziniao-cli.json`: actual CLI version/hash, tool directory, help flags and
  validated read-only binding/state checks. No nonexistent prepare-agent options.
- `evidence/ziniao-startup.json`: sanitized transcription of the initial launch and
  subsequent state observation; kernel download is explicitly not claimed.

## Reproduce

Normal offline CI requires no external executable, credentials or live store:

```powershell
npm run typecheck
npm run typecheck:stage5a
npm run test:stage5a
npm test
npm run build
```

To provision the exact external **development** tools (no install scripts; no root
dependency or production bundle change):

```powershell
npm install --prefix .stage5a/tools --no-save --ignore-scripts --no-audit --no-fund opencode-windows-x64@1.18.29 playwright@1.62.1
npm run verify:stage5a:opencode
npm run verify:stage5a:windows
```

The OpenCode probes use random local ports and passwords and synthetic MCP/provider
traffic. Config-loading probes may prepare OpenCode's external dependencies in their
disposable roots. They never use existing model credentials. The Windows probe creates
and removes only its own AppContainer, synthetic credential and validated temp root.

For Ziniao, first have the user select an exact authorized **test** store, detect the
installed CLI, resolve the store and verify its current state. Do not silently launch
or operate another store. The probe currently requires the validated version tuple and
one existing authorized HTTPS page. It fulfills only unique fixture paths locally.

```powershell
$env:FLOWCODE_TEST_STORE_NAME = '<exact user-selected test store name>'
npm run verify:stage5a:ziniao
# Separate manual receipt; requires the user to type and click the fixture button:
node --experimental-transform-types --no-warnings --import ./evals/register.mjs scripts/stage5a/ziniao-browser-probe.ts --manual
```

The probe uses `connectOverCDP` with `noDefaults:true` and `isLocal:true`, retains the
browser's own settings, and checks downloads against the CLI-approved directory.
It uses existing context and preserves original pages. It creates synthetic
upload/download files and closes only its fixture pages. It does not run business writes,
export Cookie/storageState, modify proxies/fingerprints, switch CLI configuration or
register Native Messaging keys. No recorded UI/model behavior is inferred from a test
command merely exiting successfully; inspect individual capability fields.

Regenerate structural fixtures with `npm run fixtures:stage5a`. After reviewing new
actual probe results, deliberately refresh the sanitized receipts with
`npm run fixtures:stage5a -- --capture-evidence`. Do not replace a manual receipt with
an automatic-only run or mark untested capabilities as supported.
Then run `node --experimental-transform-types --no-warnings --import ./evals/register.mjs scripts/stage5a/write-capabilities.ts`
to validate the evidence-backed capability matrix.
