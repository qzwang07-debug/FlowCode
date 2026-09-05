# ADR 0002 — Versioned execution contracts

- Status: Accepted
- Date: 2026-09-05
- Scope: Stage 5A, design/roadmap v1.1

## Context

Stage 4 Blueprint v1 is a deterministic review/export contract. Its separate
review stores `stepId`, but its final assertion shape has no execution position.
It also lacks logical pages, frame locator chains and typed producer references.
The completed Stage 0–4 delivery and its stored events must remain compatible.

## Decision

Add `common/blueprint-v2.ts` alongside the unchanged v1 schema. Add shared browser,
target/context, run-request, phase/checkpoint and confirmation contracts without
registering new production IPC or replacing existing services.

Every v2 Blueprint has source Session/event/evidence versions, an evidence hash,
revision and canonical SHA-256 content hash. Hashing sorts object keys, preserves
array order, and excludes only `contentHash` itself. Confirmation records are
separate; their bindings include Blueprint revision/hash, project/Target,
environment hash (including local store/account binding), code/plan hashes and
typed parameter hash. Changing any bound content invalidates that binding.

The host validates both structural schemas and graph references: step ordering,
assertion before/after anchors, page opening/closure, frame ownership, action/result
evidence, variable producers and use-before-produce, outputs and unsupported actions.
Manual/unresolved states are representable. JSON Schema cannot express all these
checks; generated schemas explicitly require the corresponding Zod/host validation.
Schema validity alone does not authorize execution.

`readBlueprintDocument` reads v1 unchanged or verifies a v2 hash. The pure
`migrateBlueprintV1` creates a new derived version, matches review assertions to
their original marker evidence, preserves saved step associations as `afterStepId`,
and records gaps where page/frame/anchor/producer information cannot be recovered.
It performs no filesystem writes and never guesses a missing page or insertion point.
Migration callers must supply the actual source Session/evidence version and hash.

## Consequences

- Existing v1 builders, exports, Chrome/Edge bridge enums and Session readers retain
  their behavior. New browser provider identity is an additive contract.
- Store IDs, profile/account references and leases remain local. Long-lived project
  contracts use logical pages, environment IDs, and controlled secret/file references.
- Complete v1/v2 examples and generated JSON Schemas live in `fixtures/stage5a`.
- Phase/lease/checkpoint schemas are definitions only. Persistence, production
  capture, Analyzer, target indexing, runtime and UI belong to 5B/5C/6A.

## Evidence

`common/blueprint-v2.test.ts`, `common/project-execution.test.ts`,
`electron/evidence/blueprint-contract.ts`, `electron/evidence/confirmation.ts`.
See the [5A acceptance record](../baselines/2026-09-05-stage-5a.md).
