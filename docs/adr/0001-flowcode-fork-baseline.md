# ADR 0001: FlowCode fork baseline and upstream lineage

- Status: Accepted
- Date: 2026-09-01

## Context

FlowCode is built from Microsoft Skill Recorder and must add product capabilities
without losing upstream history, privacy safeguards, recorder behavior, or legal
attribution. A large rename or history rewrite would make future upstream fixes
harder to audit and could break existing sessions, environment overrides, or the
preload bridge.

## Decision

1. Pin the initial source baseline to Skill Recorder 0.5.0 commit
   `c7f2fe4402527a0eb7f4fc1b653bf438229bac61`.
2. Use `origin` for FlowCode and a fetch-only `upstream` for Microsoft Skill
   Recorder. Preserve upstream commits and merge ancestry.
3. Change user-visible package, Electron, window, tray, capture-helper, and log
   branding to FlowCode during Stage 0.
4. Retain compatibility identifiers such as `window.skillRecorder`, existing
   `SKILL_RECORDER_*` environment overrides, and the Session schema until a later
   migration has an explicit compatibility plan and tests.
5. Retain the Microsoft MIT copyright, third-party notices, and source attribution.
6. Do not merge post-baseline upstream branches, remove Copilot, migrate the source
   tree, or implement Stage 1 features as part of the rebrand.

## Consequences

- Users see FlowCode while existing integration and test seams remain stable.
- Some internal legacy names intentionally remain and are not evidence of an
  incomplete user-facing rebrand.
- Upstream updates require a reviewed merge and the complete regression gate in
  `docs/upstream-sync.md`.
- Any future internal rename must provide compatibility aliases or migration before
  removing a legacy contract.
