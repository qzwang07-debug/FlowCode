import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const [target] = process.argv.slice(2);
if (!target) throw new Error("Usage: node cleanup.mjs <temporary-e2e-root>");
const resolved = path.resolve(target);
const temporaryRoot = `${path.resolve(os.tmpdir())}${path.sep}`.toLowerCase();
if (!`${resolved}${path.sep}`.toLowerCase().startsWith(temporaryRoot)) {
  throw new Error("Refusing to clean an E2E directory outside the OS temp root.");
}
if (!/^flowcode-stage3-e2e-[a-f0-9]{32}$/.test(path.basename(resolved))) {
  throw new Error("Refusing to clean a directory without the Stage 3 E2E prefix.");
}
await rm(resolved, { recursive: true, force: true });
console.log(`Removed ${resolved}`);
