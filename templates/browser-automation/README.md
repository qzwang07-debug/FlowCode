# FlowCode browser automation project

This project was created from FlowCode's versioned browser-workflow template.

## Start

1. Run `npm install`.
2. Make sure Google Chrome or Microsoft Edge is installed.
3. Run `npm run workflow -- --url https://example.test --browser chrome` (or use `msedge`).
4. Run `npm run smoke` for the minimal project check.

Each workflow exports readable metadata, a Zod input schema, and a `run()` function. Keep secrets outside source control. FlowCode project metadata lives in `.flowcode/project.json`; run logs and artifacts remain in ignored folders.
