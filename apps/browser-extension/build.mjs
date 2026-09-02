import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "vite";

const extensionRoot = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(extensionRoot, "../..");
const outputRoot = path.join(repositoryRoot, "dist", "browser-extension");
const sharedOutput = path.join(outputRoot, ".shared");

await rm(outputRoot, { recursive: true, force: true });
await mkdir(sharedOutput, { recursive: true });

async function bundle(entry, fileName, format, name) {
  await build({
    configFile: false,
    logLevel: "warn",
    build: {
      target: "chrome114",
      outDir: sharedOutput,
      emptyOutDir: false,
      sourcemap: false,
      minify: true,
      lib: {
        entry: path.join(extensionRoot, entry),
        formats: [format],
        name,
        fileName: () => fileName,
      },
    },
  });
}

await bundle(
  "src/service-worker/service-worker.ts",
  "service-worker.js",
  "es",
  "FlowCodeServiceWorker",
);
await bundle(
  "src/content/content-script.ts",
  "content-script.js",
  "iife",
  "FlowCodeContentScript",
);
await bundle("src/popup/popup.ts", "popup.js", "iife", "FlowCodePopup");

for (const browser of ["chrome", "edge"]) {
  const destination = path.join(outputRoot, browser);
  await mkdir(destination, { recursive: true });
  for (const file of ["service-worker.js", "content-script.js", "popup.js"]) {
    await cp(path.join(sharedOutput, file), path.join(destination, file));
  }
  await cp(
    path.join(extensionRoot, "src", "popup", "popup.html"),
    path.join(destination, "popup.html"),
  );
  await cp(
    path.join(extensionRoot, "src", "popup", "popup.css"),
    path.join(destination, "popup.css"),
  );
  const [manifest, config] = await Promise.all([
    readFile(path.join(extensionRoot, "manifests", `${browser}.json`), "utf8"),
    readFile(path.join(extensionRoot, "config", `${browser}.json`), "utf8"),
  ]);
  await writeFile(
    path.join(destination, "manifest.json"),
    `${manifest.trim()}\n`,
    "utf8",
  );
  await writeFile(
    path.join(destination, "browser-config.json"),
    `${config.trim()}\n`,
    "utf8",
  );
}

await rm(sharedOutput, { recursive: true, force: true });
console.log(`FlowCode browser extensions built at ${outputRoot}`);
