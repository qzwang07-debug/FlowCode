# FlowCode Playwright Test project

This project was created from FlowCode's versioned Page Object Model template.

## Start

1. Run `npm install`.
2. Make sure Google Chrome and Microsoft Edge are installed.
3. Copy `.env.example` to a local `.env` only when your tests need runtime configuration.
4. Run `npm test`.

Keep page interactions in `pages/`, reusable test setup in `fixtures/`, explicit expectations in tests or `assertions/`, and non-secret test values in `data/`. FlowCode project metadata lives in `.flowcode/project.json`; `.flowcode/runs/` is local-only.
