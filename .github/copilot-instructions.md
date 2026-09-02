# FlowCode repository instructions for coding agents

Before changing code, read `docs/flowcode-design.md`,
`docs/flowcode-implementation-plan.md`, and the files/tests named by the active
stage. Implement one stage at a time and do not pull later roadmap work forward.

## Branch and remote policy

- Base ordinary FlowCode work on the current `origin/main` unless the task names a
  different base.
- Use a focused branch for each change; Codex branches use the `codex/` prefix.
- `origin` is the FlowCode repository.
- `upstream` is Microsoft Skill Recorder and is fetch-only. Never push to it.
- Follow `docs/upstream-sync.md` for reviewed upstream merges.
- Never push, publish, or create a release without explicit user authorization.

## Change safety

- Preserve unrelated user changes; do not reset or clean them.
- Preserve the inherited recorder, privacy, sensitive-data, compliance, and
  Skill/Automation Builder behavior until its replacement stage is accepted.
- Keep `@github/copilot-sdk`, the Session schema, legacy preload/API names, and
  `SKILL_RECORDER_*` compatibility overrides during Stage 0.
- Do not combine a directory migration with a core behavior change.

## Minimum validation

```powershell
npm run typecheck
npm run typecheck:evals
npm test
npm run build
```

Dependency changes also require `npm run check:lockfile` and
`npm run compliance:licenses`.
