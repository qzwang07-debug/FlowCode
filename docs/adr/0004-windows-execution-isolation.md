# ADR 0004 — Windows execution isolation feasibility

- Status: Accepted
- Date: 2026-09-05
- Scope: Stage 5A boundary decision and real probes

## Context

OpenCode permissions, shell-free spawning and Git worktrees do not stop JavaScript
from using its process's filesystem, network and credential rights. Existing Stage 2
user-invoked template execution is retained; it is not relabeled as a sandbox.

## Decision

Use a Windows AppContainer with **zero capabilities**, explicit per-run directory
ACLs, a minimal environment and an owned kill-on-close Job as the tested isolation
building block. The fixed 5A probe limits the Job to one process and assigns a
suspended child before resuming it. No broad user-profile ACLs, network capability,
firewall changes, loopback exemptions, shared credential files or ambient handles
are granted. Test only synthetic files and a temporary synthetic Credential Manager
entry; remove that entry and AppContainer profile and safely clean the exact temp root.

The real Windows 11 x64 tests compare unrestricted positive controls with restricted
children. Both .NET Framework and **Node 24.19.0** can read/write the allowed
directory, but cannot read/write outside it, traverse a junction to the outside,
connect to reachable loopback/Internet endpoints, or create an additional process.
The native child additionally verifies its AppContainer token, denied access to the
host process and denied reading of the synthetic credential. Ambient credential
environment variables are absent. All positive controls succeed before a denial is
counted, so unavailable networking cannot masquerade as network isolation.

Node is exercised with a fixed reviewed `--eval` module. The subprocess-denial probe
uses `stdio:ignore`: an exploratory default-pipe attempt hung in this AppContainer.
Runtime/module loading and brokered pipe/child-process support therefore need their
own integration checks; this result does not certify arbitrary npm/Playwright trees.
The known blocked-pipe condition is not hidden by increasing its timeout.

## Consequences

- `unreviewedCodeExecutionEnabled` remains **false**. The probe executes only fixed
  canaries and is not exposed as an arbitrary launcher in Desktop or IPC.
- The 5A boundary is demonstrated by real OS decisions, rather than inferred from
  `shell:false` or tool permissions. Read-only evidence/review/export remain available.
- 5C/6A must integrate the managed OpenCode/Runner workflow with the validated
  boundary. A production broker must keep credentials, model network access and
  store control outside the untrusted workload and validate every allowed channel.
- Enabling additional processes, sockets, dependency installation, module roots or
  Playwright workers changes the boundary and requires new real negative tests.
- The selected store's raw CDP endpoint is broad browser authority. It must never
  be supplied to unreviewed generated code as if it were a selector-scoped permission.

## Evidence and sources

`scripts/stage5a/windows-isolation.cs`, `windows-isolation.ps1`,
`windows-node-canary.mjs`, `windows-isolation-probe.ts`, and
`fixtures/stage5a/evidence/windows-isolation.json`.
Primary references: [AppContainer isolation](https://learn.microsoft.com/en-us/windows/win32/secauthz/appcontainer-isolation),
[process security attributes](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute),
[Job limits](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_basic_limit_information).
