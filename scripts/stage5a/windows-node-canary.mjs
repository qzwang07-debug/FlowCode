import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { connect } from "node:net";
import path from "node:path";
const [allowed, outside, port, label] = process.argv.slice(2);
const progress = (text) =>
  appendFileSync(path.join(allowed, `node-progress-${label}.txt`), text + "\n");
progress("script-entered");
const denied = (fn) => {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
};
const reachable = (hostname, port) =>
  new Promise((resolve) => {
    const socket = connect({ host: hostname, port });
    const finish = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.on("connect", () => finish(true));
    socket.on("error", () => finish(false));
    socket.setTimeout(2000, () => finish(false));
  }).catch(() => false);
progress("before-spawn");
const child = spawnSync(process.execPath, ["-e", "process.exit(0)"], {
  windowsHide: true,
  timeout: 5000,
  stdio: "ignore",
});
progress("after-spawn");
const checks = {
  insideRead: !denied(() => readFileSync(path.join(allowed, "input.txt"))),
  insideWrite: !denied(() =>
    writeFileSync(path.join(allowed, "node-written.txt"), "fixture"),
  ),
  outsideReadBlocked: denied(() => readFileSync(outside)),
  outsideWriteBlocked: denied(() => writeFileSync(outside, "fixture")),
  junctionReadBlocked: denied(() =>
    readFileSync(path.join(allowed, "outside-link/canary.txt")),
  ),
  loopbackBlocked: !(await reachable("127.0.0.1", Number(port))),
  internetBlocked: !(await reachable("1.1.1.1", 443)),
  childProcessBlocked: child.status !== 0,
  credentialEnvironmentAbsent: process.env.FLOWCODE_CANARY_KEY === undefined,
};
progress("checks-finished");
writeFileSync(
  path.join(allowed, `node-${label}.json`),
  JSON.stringify({ version: process.versions.node, checks }),
);
