import { mkdir, rm } from "node:fs/promises";
import path from "node:path";

import { build } from "vite";

const outDir = path.resolve(".flowcode-build", "ziniao");
await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });
await build({
  configFile: false,
  publicDir: false,
  logLevel: "warn",
  build: {
    target: "chrome114",
    outDir,
    emptyOutDir: false,
    sourcemap: false,
    minify: true,
    lib: {
      entry: path.resolve("electron", "ziniao", "semantic-sensor.ts"),
      name: "FlowCodeZiniaoSensor",
      formats: ["iife"],
      fileName: () => "semantic-sensor.js",
    },
  },
});
