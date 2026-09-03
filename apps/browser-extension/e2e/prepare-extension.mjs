import { cp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const [browser, output, ...origins] = process.argv.slice(2);
if (
  !new Set(["chrome", "edge"]).has(browser) ||
  !output ||
  origins.length === 0
) {
  throw new Error(
    "Usage: node prepare-extension.mjs <chrome|edge> <temporary-output> <origin-pattern...>",
  );
}
const outputPath = path.resolve(output);
const temporaryRoot = `${path.resolve(os.tmpdir())}${path.sep}`.toLowerCase();
if (!`${outputPath}${path.sep}`.toLowerCase().startsWith(temporaryRoot)) {
  throw new Error(
    "The E2E extension copy must stay under the OS temporary directory.",
  );
}
for (const origin of origins) {
  const parsed = new URL(origin.replace(/\*$/, "fixture"));
  if (!new Set(["http:", "https:"]).has(parsed.protocol)) {
    throw new Error(`Unsupported E2E origin: ${origin}`);
  }
}
const source = path.resolve("dist", "browser-extension", browser);
await rm(outputPath, { recursive: true, force: true });
await cp(source, outputPath, { recursive: true, force: false });
const manifestPath = path.join(outputPath, "manifest.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
manifest.host_permissions = origins;
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
console.log(outputPath);
