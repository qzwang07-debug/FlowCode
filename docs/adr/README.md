# Architecture Decision Records

FlowCode uses Architecture Decision Records (ADRs) for durable product and
engineering decisions that affect multiple components or future stages.

## Format

Each ADR is an immutable numbered Markdown file with these sections:

- Status: Proposed, Accepted, Superseded, or Deprecated.
- Date.
- Context.
- Decision.
- Consequences.

Accepted ADRs are not silently rewritten. A later decision supersedes an earlier
one by adding a new ADR and linking both records.

## Index

- [0001 — FlowCode fork baseline and upstream lineage](0001-flowcode-fork-baseline.md)
- [0002 — Versioned execution contracts](0002-versioned-execution-contracts.md)
- [0003 — Pinned OpenCode protocol and configuration boundary](0003-opencode-pinned-integration.md)
- [0004 — Windows execution isolation feasibility](0004-windows-execution-isolation.md)
- [0005 — Ziniao recording and project-connection path](0005-ziniao-cdp-recording-and-runtime.md)
