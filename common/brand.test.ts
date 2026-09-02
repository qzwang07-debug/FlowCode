import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const repositoryRoot = path.resolve(import.meta.dirname, "..");

function read(relativePath: string): string {
  return readFileSync(path.join(repositoryRoot, relativePath), "utf8");
}

function readPackage(): Record<string, any> {
  return JSON.parse(read("package.json")) as Record<string, any>;
}

test("package and Electron metadata identify FlowCode", () => {
  const manifest = readPackage();
  assert.equal(manifest.name, "flowcode");
  assert.match(manifest.description, /FlowCode/);
  assert.equal(manifest.author, "FlowCode contributors");
  assert.equal(manifest.repository, "github:qzwang07-debug/FlowCode");
  assert.equal(manifest.build?.appId, "com.flowcode.app");
  assert.equal(manifest.build?.productName, "FlowCode");
  assert.match(manifest.build?.mac?.extendInfo?.NSMicrophoneUsageDescription ?? "", /FlowCode/);

  // Stage 0 deliberately retains the inherited analyzer/builder dependency.
  assert.ok(manifest.dependencies?.["@github/copilot-sdk"]);
});

test("desktop titles, tray text, capture helpers, and log prefixes use FlowCode", () => {
  assert.match(read("index.html"), /<title>FlowCode<\/title>/);

  const windows = read("electron/window.ts");
  assert.match(windows, /title: "FlowCode"/);
  assert.match(windows, /title: "FlowCode: Recording controls"/);
  assert.match(windows, /title: "FlowCode: Sessions"/);
  assert.match(read("electron/tray.ts"), /setToolTip\("FlowCode"\)/);
  assert.match(read("electron/audio/capture.html"), /<title>FlowCode — narration<\/title>/);
  assert.match(read("electron/video/capture.html"), /<title>FlowCode — capture<\/title>/);
  assert.match(read("electron/logger.ts"), /`\[FlowCode:\$\{tag\}\]`/);

  const analyzerInstructions = read("electron/describer/instructions.ts");
  assert.match(analyzerInstructions, /FlowCode app itself/);
  assert.match(analyzerInstructions, /legacy recordings may call it/);
  assert.match(analyzerInstructions, /Skill Recorder/);
});

test("source installers fetch FlowCode commits and retain legacy environment aliases", () => {
  const windowsInstaller = read("install.ps1");
  assert.match(
    windowsInstaller,
    /https:\/\/codeload\.github\.com\/qzwang07-debug\/FlowCode\/zip\/\$Commit/,
  );
  assert.match(windowsInstaller, /"FlowCode \(Source\)\.lnk"/);
  assert.match(windowsInstaller, /\[FlowCode\]/);
  assert.match(windowsInstaller, /SKILL_RECORDER_COMMIT/);

  const unixInstaller = read("install.sh");
  assert.match(
    unixInstaller,
    /https:\/\/codeload\.github\.com\/qzwang07-debug\/FlowCode\/tar\.gz\/\$COMMIT/,
  );
  assert.match(unixInstaller, /FlowCode \(Source\)\.app/);
  assert.match(unixInstaller, /flowcode-\*\.log/);
  assert.match(unixInstaller, /SKILL_RECORDER_COMMIT/);
});

test("the FlowCode rebrand retains Microsoft Skill Recorder attribution", () => {
  assert.match(read("LICENSE"), /Copyright \(c\) Microsoft Corporation\./);

  const readme = read("README.md");
  assert.match(readme, /Microsoft Skill Recorder/);
  assert.match(readme, /https:\/\/github\.com\/microsoft\/skill-recorder/);
  assert.match(readme, /\[`INSTALL\.md`\]\(INSTALL\.md\)/);

  const notices = read("THIRD-PARTY-NOTICES.md");
  assert.match(notices, /FlowCode/);
  assert.match(notices, /Microsoft Skill Recorder/);
  assert.match(notices, /MIT License/);
});

test("stage 0 governance and Windows baseline artifacts are present", () => {
  const upstream = read("docs/upstream-sync.md");
  assert.match(upstream, /c7f2fe4402527a0eb7f4fc1b653bf438229bac61/);
  assert.match(upstream, /git fetch upstream --prune/);
  assert.match(upstream, /remote\.upstream\.pushurl/);

  assert.match(read("docs/adr/README.md"), /Architecture Decision Records/);
  assert.match(read("docs/adr/0001-flowcode-fork-baseline.md"), /Accepted/);
  assert.match(read("docs/baselines/2026-09-01-stage-0.md"), /Regression baseline/);

  const windowsWorkflow = read(".github/workflows/windows.yml");
  for (const command of [
    "npm run typecheck",
    "npm run typecheck:evals",
    "npm test",
    "npm run build",
  ]) {
    assert.ok(windowsWorkflow.includes(command), `Windows CI is missing ${command}`);
  }
});
