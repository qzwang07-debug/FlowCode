# FlowCode

FlowCode is an open-source, Windows-first tool that turns recorded desktop and browser workflows into maintainable Playwright automation and web testing projects.

The project is based on [Microsoft Skill Recorder](https://github.com/microsoft/skill-recorder). It preserves cross-application screen, window, clipboard, URL, and optional narration capture, then adds high-fidelity Chrome/Edge actions, project templates, assertion management, code review, test reports, and an OpenCode-powered coding workflow.

## Status

FlowCode is being implemented incrementally from the inherited Skill Recorder 0.5.0 code. Stage 0 establishes the FlowCode brand, upstream lineage, regression baseline, and Windows quality gate without changing recording or analysis behavior.

## Design documents

- [Product and technical design](docs/flowcode-design.md)
- [Staged AI implementation playbook](docs/flowcode-implementation-plan.md)
- [Upstream synchronization policy](docs/upstream-sync.md)
- [Architecture Decision Records](docs/adr/README.md)
- [Stage 0 regression baseline](docs/baselines/2026-09-01-stage-0.md)

## Development and release documentation

- [`INSTALL.md`](INSTALL.md)
- [`RELEASING.md`](RELEASING.md)

## Core direction

- Windows 11 first.
- Google Chrome and Microsoft Edge first.
- Browser extension for normal recording; optional CDP for explicitly authorized deep evidence.
- Web testing and browser automation project templates.
- Analyze-only and analyze-and-build modes.
- OpenCode as the sole coding harness, with configurable model providers and custom API endpoints.
- Local-first evidence, explicit consent, Git worktree isolation, reviewable diffs, and no automatic push.

## Development baseline

```powershell
npm ci
npm run typecheck
npm run typecheck:evals
npm test
npm run build
```

See the implementation playbook before making architectural changes.

## Upstream and attribution

FlowCode is a derivative of Microsoft Skill Recorder and retains its MIT license, copyright notices, third-party notices, and source history. Playwright and OpenCode are separate upstream projects with their own licenses; FlowCode intends to integrate them through documented public interfaces rather than vendoring their full repositories.

This project is independent and is not endorsed by Microsoft, Playwright, OpenCode, or their maintainers.

## License

MIT. See [LICENSE](LICENSE) and [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
