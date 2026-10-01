# Stage 5C capability matrix

Date: 2026-10-01. Roadmap: 2026-09-05 v1.1. Stage 0–5B evidence remains unchanged.

| Capability | Evidence | Result / boundary |
|---|---|---|
| Windows x64 fixed OpenCode 1.18.29 | Reviewed executable hash; actual protocol receipt | Supported for trusted read-only analysis; no automatic upgrade/install |
| Config/plugin/tool loading containment | Actual 5A seeded loading recheck and production tool catalogue | Empty managed scope + disabled discovery + `--pure`; config directory alone is insufficient |
| Authentication, lifecycle, cancellation | Actual runtime, scoped MCP, owned Windows Job, cancel receipt | Supported; stop/revoke invalidates access and retains evidence |
| Crash recovery / replay | Append-only recovery, atomic revision, idempotent submission and SSE tests | Interrupted runs are not successful; no automatic repeated business action |
| Windows OS isolation canaries | Native + Node unrestricted controls and AppContainer denials | Pass, including reachable Internet control. OpenCode/Playwright OS sandbox is **not claimed** |
| Unreviewed generated-code execution | Runtime/config and unchanged prior ADR decision | Disabled; no Builder or generated-code Runner |
| Model credentials | Real authenticated metadata + vault roundtrip, UI synthetic key save/remove | Credential Manager only; no key in repo/config/prompt/AgentRun audit |
| Model capabilities | Actual nonce/function/structured arguments and randomized-image probe | Use exported per-provider results; no Vision/failed OCR means no image tool |
| Standard Evidence MCP | Real HTTP negatives, quotas, scope/reference tests and fixed runtime | Bounded rows/bytes/images/time, projection/redaction and fail-closed behavior |
| Deep DOM/network/debug bodies | Production tool catalogue and denial tests | Not exposed in 5C |
| Historical/native store binding | Recorded lease/source validation and changed-profile tests | Native values stay private; changed environment invalidates review/preview; no cross-source fallback |
| ProjectContext | Bound project/target, `unavailable/not-indexed` | Only analysis/new-target context supported; no existing-target precision before 6A |
| Derived review and preflight | Three-source deterministic fixtures, actual Electron QA | Delete/merge/fixed/typed/manual/assertion edits, comparisons and concrete blockers; raw capture unchanged |
| Model migration | Frozen 9 + 12 cases, actual Copilot/OpenCode receipts | See current full receipt; successful subsets never enable default migration |
| Chrome/Edge/Ziniao business execution | No execution in this phase | Not tested/implemented; prior capture/connection receipts do not imply execution success |
| Other platforms/runtime versions | No real 5C runtime verification | Unsupported until reviewed; do not label them passing |

Legacy Copilot remains available through the explicit legacy library. A missing
key, untested/different provider configuration or stale quality receipt keeps the
legacy default. See ADR 0007 and the stage delivery record for item-level evidence.
