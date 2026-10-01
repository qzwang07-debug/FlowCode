import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolve4 } from "node:dns/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { contractHash } from "../../electron/evidence/blueprint-contract";
if (process.platform !== "win32") throw new Error("Real Windows required.");
const root = await mkdtemp(path.join(tmpdir(), "flowcode-5c-isolation-source-"));
const run = promisify(execFile);
try {
  const ip = (await resolve4("opencode.ai"))[0]!;
  assert.ok(!/^(?:127\.|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(ip), "Public positive control required.");
  const native = await readFile("scripts/stage5a/windows-isolation.cs", "utf8");
  const node = await readFile("scripts/stage5a/windows-node-canary.mjs", "utf8");
  const ps = await readFile("scripts/stage5a/windows-isolation.ps1", "utf8");
  // Do not modify accepted 5A sources. Only the reviewed canaries' explicit
  // external positive-control target changes: the old 1.1.1.1 route is no longer
  // reachable on this machine. Same controls, ACLs, Job and zero-capability token.
  await writeFile(path.join(root, "windows-isolation.cs"), native.replaceAll('"1.1.1.1"', JSON.stringify(ip)));
  await writeFile(path.join(root, "windows-node-canary.mjs"), node.replaceAll('"1.1.1.1"', JSON.stringify(ip)));
  await writeFile(path.join(root, "windows-isolation.ps1"), ps);
  const { stdout } = await run(path.join(process.env.SystemRoot!, "System32/WindowsPowerShell/v1.0/powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.join(root, "windows-isolation.ps1")],
    { windowsHide: true, timeout: 60000, maxBuffer: 1024 * 1024, env: { ...process.env, FLOWCODE_PROBE_NODE: process.execPath } });
  const report = JSON.parse(stdout.trim());
  for (const key of Object.keys(report.sandbox)) { assert.equal(report.sandbox[key], true, key); assert.equal(report.control[key], ["insideRead", "insideWrite"].includes(key), `positive:${key}`); }
  for (const key of Object.keys(report.nodeSandbox.checks)) { assert.equal(report.nodeSandbox.checks[key], true, key); assert.equal(report.nodeControl.checks[key], ["insideRead", "insideWrite"].includes(key), `node-positive:${key}`); }
  const receipt = { ...report, sourceHashes: { native: contractHash(native), node: contractHash(node), ps: contractHash(ps) },
    externalPositiveControl: "A reachable public IPv4 endpoint resolved from opencode.ai; exact address not exported.",
    scope: "Same fixed native/Node AppContainer canaries as 5A, NOT a sandbox claim for OpenCode, npm or Playwright.", unreviewedCodeExecutionEnabled: false };
  await mkdir(".stage5c/evidence", { recursive: true }); await writeFile(".stage5c/evidence/windows-isolation.json", JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify({ native: "pass", node: "pass", positiveControls: "reachable", unreviewedCodeExecutionEnabled: false }));
} finally {
  const canonical = path.resolve(root);
  if (path.dirname(canonical) !== path.resolve(tmpdir()) || !path.basename(canonical).startsWith("flowcode-5c-isolation-source-")) throw new Error("Unsafe test cleanup target.");
  await rm(canonical, { recursive: true, force: true });
}
