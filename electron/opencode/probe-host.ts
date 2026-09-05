import { spawn, execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes, createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import {
  OPENCODE_PIN,
  OpenCodeContractClient,
  OpenCodeHealthSchema,
} from "./contract-client";
export { OpenCodeSessionSchema, OpenCodeHealthSchema } from "./contract-client";

export const OPENCODE_VERSION = OPENCODE_PIN;
export const OPENCODE_WINDOWS_X64_SHA256 =
  "88d2fa691b2d9e32fde6d1039382a850ddf96fe49cd41683c6375fe1dc8ec2a5";
const run = promisify(execFile);

/** Reviewed 5A harness only; not connected to Desktop, Analyzer or a project Runner. */
export function probeEnvironment(
  root: string,
  config: unknown,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["SystemRoot", "WINDIR", "ComSpec", "PATHEXT"])
    if (process.env[key]) env[key] = process.env[key];
  return {
    ...env,
    PATH: path.join(process.env.SystemRoot ?? "C:\\Windows", "System32"),
    USERPROFILE: path.join(root, "home"),
    HOME: path.join(root, "home"),
    APPDATA: path.join(root, "appdata"),
    LOCALAPPDATA: path.join(root, "localappdata"),
    XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_DATA_HOME: path.join(root, "data"),
    XDG_CACHE_HOME: path.join(root, "cache"),
    XDG_STATE_HOME: path.join(root, "state"),
    TEMP: path.join(root, "temp"),
    TMP: path.join(root, "temp"),
    OPENCODE_CONFIG_DIR: path.join(root, "managed-config"),
    OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
    OPENCODE_DISABLE_AUTOUPDATE: "true",
    OPENCODE_DISABLE_MODELS_FETCH: "true",
    OPENCODE_DISABLE_PROJECT_CONFIG: "true",
    OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: "true",
  };
}
export function restrictedProbeConfig(
  providerUrl: string,
  mcpUrl: string,
  mcpToken: string,
) {
  return {
    $schema: "https://opencode.ai/config.json",
    autoupdate: false,
    share: "disabled",
    enabled_providers: ["fixture"],
    model: "fixture/probe",
    small_model: "fixture/probe",
    provider: {
      fixture: {
        npm: "@ai-sdk/openai-compatible",
        name: "Local deterministic fixture",
        options: { baseURL: providerUrl, apiKey: "fixture-not-a-secret" },
        models: {
          probe: {
            name: "Protocol fixture",
            limit: { context: 16384, output: 2048 },
          },
        },
      },
    },
    permission: { "*": "deny", "probe_*": "allow", StructuredOutput: "allow" },
    agent: {
      "flowcode-probe": {
        mode: "primary",
        prompt:
          "Call only the restricted probe MCP and return its structured fixture result.",
        permission: {
          "*": "deny",
          "probe_*": "allow",
          StructuredOutput: "allow",
        },
      },
    },
    default_agent: "flowcode-probe",
    mcp: {
      probe: {
        type: "remote",
        url: mcpUrl,
        headers: { Authorization: `Bearer ${mcpToken}` },
        enabled: true,
        oauth: false,
      },
    },
  };
}
async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) =>
    server.once("error", reject).listen(0, "127.0.0.1", resolve),
  );
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
export class OpenCodeProbeHost {
  private child?: ChildProcess;
  private exited?: Promise<void>;
  private password = randomBytes(32).toString("hex");
  private base = "";
  private diagnostic = "";
  constructor(
    private readonly options: {
      binary: string;
      root: string;
      config: unknown;
      pure?: boolean;
      env?: NodeJS.ProcessEnv;
      cwd?: string;
      requestTimeoutMs?: number;
    },
  ) {}
  get url() {
    return this.base;
  }
  get output() {
    return this.diagnostic;
  }
  async start(): Promise<{ version: string; binaryHash: string }> {
    if (this.child) throw new Error("Probe already started.");
    if (
      !path.isAbsolute(this.options.binary) ||
      !path.isAbsolute(this.options.root)
    )
      throw new Error("Probe requires resolved absolute paths.");
    const binaryHash = createHash("sha256")
      .update(await readFile(this.options.binary))
      .digest("hex");
    if (
      process.platform === "win32" &&
      binaryHash !== OPENCODE_WINDOWS_X64_SHA256
    )
      throw new Error(
        "OpenCode binary does not match the reviewed Windows x64 pin.",
      );
    const env = {
      ...probeEnvironment(this.options.root, this.options.config),
      ...this.options.env,
      OPENCODE_SERVER_PASSWORD: this.password,
      OPENCODE_SERVER_USERNAME: "flowcode-probe",
    };
    const cwd = this.options.cwd ?? path.join(this.options.root, "work");
    await Promise.all(
      [
        cwd,
        ...[
          "home",
          "appdata",
          "localappdata",
          "config",
          "data",
          "cache",
          "state",
          "temp",
          "managed-config",
        ].map((x) => path.join(this.options.root, x)),
      ].map((p) => mkdir(p, { recursive: true })),
    );
    const version = (
      await run(this.options.binary, ["--version"], {
        env,
        cwd,
        windowsHide: true,
        timeout: 15000,
        maxBuffer: 4096,
      })
    ).stdout.trim();
    if (version !== OPENCODE_VERSION)
      throw new Error(
        "Unsupported OpenCode version; upgrade requires revalidation.",
      );
    const port = await reservePort();
    this.base = `http://127.0.0.1:${port}`;
    const child = spawn(
      this.options.binary,
      [
        "serve",
        "--hostname",
        "127.0.0.1",
        "--port",
        String(port),
        ...(this.options.pure === false ? [] : ["--pure"]),
      ],
      {
        cwd,
        env,
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    this.child = child;
    this.exited = new Promise((resolve) => {
      child.once("close", () => resolve());
      child.once("error", () => resolve());
    });
    const capture = (b: Buffer) => {
      if (this.diagnostic.length < 32000)
        this.diagnostic += b
          .toString("utf8")
          .slice(0, 32000 - this.diagnostic.length);
    };
    child.stdout?.on("data", capture);
    child.stderr?.on("data", capture);
    try {
      const deadline = Date.now() + 120000;
      let lastHealthError = "no health response";
      while (Date.now() < deadline) {
        if (child.exitCode !== null || child.signalCode !== null)
          throw new Error("OpenCode exited before health check.");
        try {
          OpenCodeHealthSchema.parse(await this.request("/global/health"));
          return { version, binaryHash };
        } catch (error) {
          lastHealthError = String(error);
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
      throw new Error(`OpenCode startup timed out: ${lastHealthError}`);
    } catch (error) {
      await this.stop();
      throw error;
    }
  }
  async request(route: string, body?: unknown): Promise<unknown> {
    return new OpenCodeContractClient(
      this.base,
      "flowcode-probe",
      this.password,
      route === "/global/health"
        ? 2000
        : (this.options.requestTimeoutMs ?? 60000),
    ).request(route, body);
  }
  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    if (child.exitCode === null && child.signalCode === null && child.pid) {
      if (process.platform === "win32")
        await run(
          path.join(
            process.env.SystemRoot ?? "C:\\Windows",
            "System32/taskkill.exe",
          ),
          ["/PID", String(child.pid), "/T", "/F"],
          { windowsHide: true, timeout: 10000 },
        ).catch(() => child.kill());
      else child.kill("SIGTERM");
    }
    await this.exited;
    this.child = undefined;
  }
}
