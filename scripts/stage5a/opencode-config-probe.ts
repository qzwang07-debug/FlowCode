import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { OpenCodeProbeHost } from "../../electron/opencode/probe-host";

const binary = path.resolve(
  ".stage5a/tools/node_modules/opencode-windows-x64/bin/opencode.exe",
);
await mkdir(path.resolve(".stage5a/config-probes"), { recursive: true });
const root = await mkdtemp(path.resolve(".stage5a/config-probes/run-"));
const project = path.join(root, "project"),
  global = path.join(root, "ambient-config/opencode"),
  custom = path.join(root, "custom"),
  home = path.join(root, "ambient-home");
const write = async (file: string, value: string | object) => {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(
    file,
    typeof value === "string" ? value : JSON.stringify(value),
  );
};
const marker = path.join(root, "plugin-executed.txt"),
  toolMarker = path.join(root, "tool-loaded.txt");
const plugin = path.join(global, "plugins/canary.mjs");
await write(
  plugin,
  `import {writeFileSync} from 'node:fs'; export const Canary=async()=>{writeFileSync(${JSON.stringify(marker)},'synthetic');return {}};`,
);
const base = {
  autoupdate: false,
  share: "disabled",
  enabled_providers: [],
  permission: { "*": "deny" },
};
await write(path.join(global, "opencode.json"), {
  ...base,
  username: "global-canary",
  agent: { "global-canary": { description: "global", mode: "subagent" } },
  plugin: [pathToFileURL(plugin).href],
  mcp: {
    global_canary: {
      type: "remote",
      url: "http://127.0.0.1:1/not-contacted",
      enabled: false,
    },
  },
});
await write(path.join(project, "opencode.json"), {
  username: "project-canary",
  agent: { "project-canary": { description: "project", mode: "subagent" } },
});
await write(
  path.join(project, ".opencode/agents/directory-canary.md"),
  "---\ndescription: Directory canary\nmode: subagent\n---\nSynthetic fixture only.\n",
);
await write(
  path.join(project, ".opencode/tools/canary.ts"),
  `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(toolMarker)},'synthetic'); export default {description:'Synthetic tool',args:{},execute:async()=> 'fixture'};`,
);
await write(
  path.join(home, ".opencode/agents/home-canary.md"),
  "---\ndescription: Home canary\nmode: subagent\n---\nSynthetic fixture only.\n",
);
await write(path.join(custom, "opencode.json"), {
  username: "custom-directory-canary",
  agent: {
    "custom-canary": { mode: "subagent", description: "custom directory" },
  },
});
const standalone = path.join(root, "standalone.json");
await write(standalone, {
  username: "standalone-canary",
  agent: {
    "standalone-canary": { mode: "subagent", description: "standalone file" },
  },
});
const inline = {
  ...base,
  username: "inline-canary",
  agent: { "inline-canary": { description: "inline", mode: "subagent" } },
};
const merged = new OpenCodeProbeHost({
  binary,
  root: path.join(root, "merged"),
  cwd: project,
  pure: false,
  config: inline,
  requestTimeoutMs: 180000,
  env: {
    OPENCODE_DISABLE_PROJECT_CONFIG: "false",
    OPENCODE_CONFIG_DIR: custom,
    OPENCODE_CONFIG: standalone,
    XDG_CONFIG_HOME: path.dirname(global),
    HOME: home,
    USERPROFILE: home,
  },
});
const isolated = new OpenCodeProbeHost({
  binary,
  root: path.join(root, "isolated"),
  cwd: project,
  pure: true,
  config: inline,
  requestTimeoutMs: 180000,
});
try {
  await merged.start();
  console.log(
    "merged server healthy; validating final loaded config and canaries",
  );
  const config = (await merged.request("/config")) as any;
  const agents = (await merged.request("/agent")) as Array<{ name: string }>;
  const tools = (await merged.request("/experimental/tool/ids")) as string[];
  assert.equal(config.username, "inline-canary");
  for (const key of [
    "global-canary",
    "project-canary",
    "directory-canary",
    "home-canary",
    "custom-canary",
    "standalone-canary",
    "inline-canary",
  ])
    assert.ok(
      agents.some((a) => a.name === key),
      `Missing real loaded agent: ${key}`,
    );
  assert.ok(config.mcp.global_canary);
  assert.ok(config.plugin.length > 0);
  assert.equal(await readFile(marker, "utf8"), "synthetic");
  assert.ok(tools.includes("canary"));
  assert.equal(await readFile(toolMarker, "utf8"), "synthetic");
  await merged.stop();
  await isolated.start();
  const clean = (await isolated.request("/config")) as any;
  const cleanAgents = (await isolated.request("/agent")) as Array<{
    name: string;
  }>;
  const cleanTools = (await isolated.request(
    "/experimental/tool/ids",
  )) as string[];
  assert.equal(clean.username, "inline-canary");
  assert.deepEqual(
    cleanAgents.filter((a) => a.name.endsWith("-canary")).map((a) => a.name),
    ["inline-canary"],
  );
  assert.equal(clean.plugin.length, 0);
  assert.equal(Object.keys(clean.mcp ?? {}).length, 0);
  assert.equal(cleanTools.includes("canary"), false);
  const report = {
    schemaVersion: 1,
    version: "1.18.29",
    merged: {
      precedence: "inline wins overlapping username",
      agents: agents
        .filter((a) => a.name.endsWith("-canary"))
        .map((a) => a.name),
      globalMcpMerged: true,
      pluginActuallyExecuted: true,
      customToolActuallyLoaded: true,
    },
    isolated: {
      ambientGlobalProjectHomeExcluded: true,
      pluginAbsent: true,
      mcpAbsent: true,
      customToolAbsent: true,
      controls: [
        "empty HOME/USERPROFILE",
        "empty XDG config/data/cache/state",
        "managed config directory",
        "project discovery disabled",
        "--pure",
        "minimal process environment",
      ],
    },
    conclusion:
      "OPENCODE_CONFIG_DIR alone is not isolation. Config containment is separate from OS containment.",
  };
  await mkdir(path.resolve(".stage5a/evidence"), { recursive: true });
  await writeFile(
    path.resolve(".stage5a/evidence/opencode-config.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report));
} catch (error) {
  console.error(String(error));
  console.error(merged.output.slice(-3000));
  console.error(isolated.output.slice(-3000));
  process.exitCode = 1;
} finally {
  await merged.stop();
  await isolated.stop();
}
