import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { ControlledProcessRunner } from "./controlled-runner";

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

test("controlled commands preserve injection-shaped arguments without a shell", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "flowcode-runner-args-"));
  const marker = path.join(root, "injected.txt");
  const logPath = path.join(root, "output.log");
  const attack = `;require('node:fs').writeFileSync(${JSON.stringify(marker)},'bad')`;
  try {
    const result = await new ControlledProcessRunner().run({
      id: "run-args",
      executable: process.execPath,
      args: ["-e", "console.log(JSON.stringify(process.argv[1]))", attack],
      cwd: root,
      logPath,
      timeoutMs: 10_000,
      maxLogBytes: 16_384,
    });

    assert.equal(result.status, "succeeded");
    assert.equal(
      (await readFile(logPath, "utf8")).trim(),
      JSON.stringify(attack),
    );
    await assert.rejects(access(marker), isMissing);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("large output is capped on disk and reported as truncated", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "flowcode-runner-limit-"));
  const logPath = path.join(root, "output.log");
  try {
    const result = await new ControlledProcessRunner().run({
      id: "run-limit",
      executable: process.execPath,
      args: ["-e", "process.stdout.write('x'.repeat(64 * 1024))"],
      cwd: root,
      logPath,
      timeoutMs: 10_000,
      maxLogBytes: 1_024,
    });
    const log = await readFile(logPath, "utf8");
    assert.equal(result.status, "succeeded");
    assert.equal(result.logTruncated, true);
    assert.match(log, /log truncated after 1024 bytes/);
    assert.ok(Buffer.byteLength(log) < 1_200);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("timeout and cancellation terminate the command process tree", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "flowcode-runner-stop-"));
  const runner = new ControlledProcessRunner({ killGraceMs: 100 });
  const heartbeat = path.join(root, "child-heartbeat.txt");
  try {
    const timedOut = await runner.run({
      id: "run-timeout",
      executable: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      cwd: root,
      logPath: path.join(root, "timeout.log"),
      timeoutMs: 100,
      maxLogBytes: 4_096,
    });
    assert.equal(timedOut.status, "timed-out");

    let childPid = 0;
    let resolvePid!: () => void;
    const pidReady = new Promise<void>((resolve) => {
      resolvePid = resolve;
    });
    const running = runner.run(
      {
        id: "run-cancel",
        executable: process.execPath,
        args: [
          "-e",
          `const {spawn}=require("node:child_process"); const child=${JSON.stringify(
            "const fs=require('node:fs');const p=process.argv[1];setInterval(()=>fs.appendFileSync(p,'x'),25)",
          )}; const c=spawn(process.execPath,["-e",child,process.argv[1]],{stdio:"ignore"}); console.log(c.pid); setInterval(()=>{},1000)`,
          heartbeat,
        ],
        cwd: root,
        logPath: path.join(root, "cancel.log"),
        timeoutMs: 10_000,
        maxLogBytes: 4_096,
      },
      (event) => {
        const parsed = Number(event.text.trim());
        if (!childPid && Number.isInteger(parsed) && parsed > 0) {
          childPid = parsed;
          resolvePid();
        }
      },
    );
    await pidReady;
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(await runner.cancel("run-cancel"), true);
    assert.equal((await running).status, "canceled");
    await new Promise((resolve) => setTimeout(resolve, 150));
    const stoppedLength = (await readFile(heartbeat)).byteLength;
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal((await readFile(heartbeat)).byteLength, stoppedLength);
  } finally {
    await runner.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
