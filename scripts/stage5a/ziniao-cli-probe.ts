import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  detectZiniaoCli,
  createZiniaoTransport,
  ZiniaoCliService,
  ziniaoConfigFingerprint,
} from "../../electron/ziniao/cli-service";

const name = process.env.FLOWCODE_TEST_STORE_NAME;
if (!name)
  throw new Error(
    "Specify the explicitly selected test store; no implicit selection.",
  );
const cli = await detectZiniaoCli(
  path.join(
    process.env.APPDATA!,
    "npm/node_modules/@ziniao-open/cli/bin/ziniao-cli.exe",
  ),
);
const transport = createZiniaoTransport(cli.binary);
const service = new ZiniaoCliService(
  transport,
  ziniaoConfigFingerprint(
    path.join(process.env.USERPROFILE!, ".ziniao-cli/config.json"),
  ),
);
const binding = await service.bindName(name);
await service.verifyBinding(binding);
const state = await service.state(binding);
const toolSchema = z
  .object({
    ok: z.literal(true),
    data: z
      .array(
        z
          .object({
            name: z.string().max(128),
            description: z.string().max(2000),
          })
          .strip(),
      )
      .max(100),
    meta: z.object({ count: z.number().int().nonnegative() }).strip(),
  })
  .strip();
const tools = toolSchema.parse(
  JSON.parse(
    await transport(["zclaw", "tools", "--format", "json"], {
      timeoutMs: 30000,
    }),
  ),
);
assert.equal(tools.meta.count, tools.data.length);
const helpFlags: Record<string, string[]> = {};
for (const args of [
  ["store", "list"],
  ["store", "resolve"],
  ["store", "open"],
  ["store", "prepare-agent"],
  ["page", "extract"],
  ["page", "snapshot"],
  ["page", "exec"],
  ["page", "upload"],
  ["automation", "run"],
]) {
  const text = await transport([...args, "--help"], { timeoutMs: 10000 });
  helpFlags[args.join(" ")] = [
    ...text.matchAll(/^\s*(?:-[a-z],\s*)?(--[a-z][a-z-]*)/gm),
  ].map((m) => m[1]);
}
assert.equal(helpFlags["store prepare-agent"].includes("--store-id"), false);
const report = {
  schemaVersion: 1,
  cliVersion: cli.version,
  binarySha256: cli.sha256,
  listAndExactBinding: "pass",
  accountConfigFingerprint: "pass",
  selectedStoreRunning: state.running,
  downloadDirectoryReported: Boolean(state.downloadFolderPath),
  toolNames: tools.data.map((t) => t.name),
  helpFlags,
  mutatingCommandsExecuted: false,
};
await mkdir(path.resolve(".stage5a/evidence"), { recursive: true });
await writeFile(
  path.resolve(".stage5a/evidence/ziniao-cli.json"),
  JSON.stringify(report, null, 2) + "\n",
);
console.log(JSON.stringify(report));
