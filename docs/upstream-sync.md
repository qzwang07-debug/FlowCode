# Upstream synchronization

FlowCode retains the complete Microsoft Skill Recorder history. The product fork
starts from Skill Recorder 0.5.0 at commit
`c7f2fe4402527a0eb7f4fc1b653bf438229bac61`.

## Remote contract

- `origin` is `https://github.com/qzwang07-debug/FlowCode.git` and is the FlowCode remote.
- `upstream` is `https://github.com/microsoft/skill-recorder.git` and is fetch-only.
- No automation or development agent may push to `upstream`.

Git does not version remote configuration, so every clone must apply and verify the
push guard locally:

```powershell
git remote set-url --push upstream DISABLED
git config --get remote.upstream.pushurl
git remote -v
```

The expected `remote.upstream.pushurl` value is `DISABLED`.

## Review and synchronization procedure

1. Start from a clean FlowCode worktree. Preserve and stop for unrelated local changes.
2. Refresh both remotes without changing the current branch:

   ```powershell
   git fetch origin --prune
   git fetch upstream --prune
   ```

3. Inspect upstream rather than merging blindly:

   ```powershell
   git log --oneline --decorate HEAD..upstream/main
   git diff --stat HEAD...upstream/main
   git rev-list --left-right --count HEAD...upstream/main
   ```

4. Create a dedicated `codex/upstream-sync-YYYYMMDD` branch from the current
   FlowCode `main`.
5. Merge `upstream/main` with an explicit merge commit so upstream ancestry stays
   auditable. Do not merge a release or topic branch merely because it is newer;
   that requires an explicit review decision.
6. Resolve product-layer conflicts separately from upstream security, recording,
   privacy, and compliance fixes. Never weaken a guard to complete the merge.
7. Run `npm ci`, `npm run typecheck`, `npm run typecheck:evals`, `npm test`, and
   `npm run build`. Dependency changes also require `npm run check:lockfile` and
   `npm run compliance:licenses`.
8. Review the full diff and upstream attribution before opening a PR. Do not push
   automatically.

As of 2026-09-01, `upstream/main` still points to the pinned 0.5.0 baseline. The
separate `upstream/release/0.6.0` branch is four commits ahead of that baseline and
is intentionally not merged during Stage 0.
