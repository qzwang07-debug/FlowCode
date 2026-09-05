import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile } from "node:fs/promises";
import { release } from "node:os";
import path from "node:path";

if (process.platform !== "win32")
  throw new Error(
    "Real Windows required; this probe must not self-skip as a pass.",
  );
const run = promisify(execFile);
const { stdout } = await run(
  path.join(
    process.env.SystemRoot!,
    "System32/WindowsPowerShell/v1.0/powershell.exe",
  ),
  [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    path.resolve("scripts/stage5a/windows-isolation.ps1"),
  ],
  {
    windowsHide: true,
    timeout: 60000,
    maxBuffer: 1024 * 1024,
    env: { ...process.env, FLOWCODE_PROBE_NODE: process.execPath },
  },
);
const report = JSON.parse(stdout.trim());
for (const key of Object.keys(report.sandbox)) {
  assert.equal(report.sandbox[key], true, `Sandbox boundary failed: ${key}`);
  assert.equal(
    report.control[key],
    ["insideRead", "insideWrite"].includes(key),
    `Positive control failed: ${key}`,
  );
}
report.nativeCompatibilityVersion = report.os;
report.os = release();
for (const key of Object.keys(report.nodeSandbox.checks)) {
  assert.equal(
    report.nodeSandbox.checks[key],
    true,
    `Node boundary failed: ${key}`,
  );
  assert.equal(
    report.nodeControl.checks[key],
    ["insideRead", "insideWrite"].includes(key),
    `Node positive control failed: ${key}`,
  );
}
assert.equal(report.nodeSandbox.version, "24.19.0");
report.runtimeScope =
  ".NET Framework 4 and Node 24.19.0 fixed canaries; full OpenCode/Playwright process-tree integration remains a later Runner task";
report.verification =
  "pass: positive control reachable, AppContainer boundary blocked";
await mkdir(path.resolve(".stage5a/evidence"), { recursive: true });
await writeFile(
  path.resolve(".stage5a/evidence/windows-isolation.json"),
  JSON.stringify(report, null, 2) + "\n",
);
console.log(JSON.stringify(report));
