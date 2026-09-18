import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import { ZiniaoStoreBindingSchema } from "../../common/browser-environment";
import type { ZiniaoCliService } from "./cli-service";
import {
  ZINIAO_KERNEL_VERSION,
  ZINIAO_VALIDATED_CLIENT_VERSIONS,
} from "./capabilities";
import { splitWindowsCommandLine } from "./windows-command-line";

const run = promisify(execFile);
const ProcessSchema = z
  .object({
    Name: z.string(),
    ProcessId: z.number().int().nonnegative(),
    ExecutablePath: z.string().nullable(),
    CommandLine: z.string().nullable(),
  })
  .strip();
export type ZiniaoProcess = z.infer<typeof ProcessSchema>;
const VersionResponseSchema = z
  .object({
    Browser: z.literal(`Chrome/${ZINIAO_KERNEL_VERSION}`),
    "Protocol-Version": z.literal("1.3"),
    webSocketDebuggerUrl: z.string().url(),
  })
  .strip();
const FileVersionSchema = z
  .object({ FileVersion: z.string(), ProductVersion: z.string().optional() })
  .strip();

function powershell(): string {
  return path.join(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32/WindowsPowerShell/v1.0/powershell.exe",
  );
}

function quotePowerShell(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function selectStoreProcess(
  processes: readonly ZiniaoProcess[],
  storeId: string,
): ZiniaoProcess {
  const selected = processes.filter((candidate) => {
    if (
      candidate.Name.toLowerCase() !== "ziniaobrowser.exe" ||
      !candidate.CommandLine ||
      !candidate.ExecutablePath
    )
      return false;
    let args: string[];
    try {
      args = splitWindowsCommandLine(candidate.CommandLine);
    } catch {
      return false;
    }
    const profiles = args.filter((arg) => arg.startsWith("--user-data-dir="));
    return (
      !args.some((arg) => arg.startsWith("--type=")) &&
      args.some((arg) => arg.startsWith("--store_data_path=")) &&
      profiles.length === 1 &&
      path.win32.basename(profiles[0]!.slice("--user-data-dir=".length)) ===
        `chrome_${storeId}`
    );
  });
  if (selected.length !== 1)
    throw new Error("The exact Ziniao store process is not uniquely identifiable.");
  return selected[0]!;
}

function parseProcesses(raw: string): ZiniaoProcess[] {
  const parsed = JSON.parse(raw) as unknown;
  return z
    .array(ProcessSchema)
    .parse(Array.isArray(parsed) ? parsed : parsed ? [parsed] : []);
}

export interface ZiniaoEndpoint {
  endpoint: string;
  webSocketDebuggerUrl: string;
  processId: number;
  clientVersion: string;
  kernelVersion: string;
  state: Awaited<ReturnType<ZiniaoCliService["state"]>>;
}

export async function discoverZiniaoEndpoint(input: {
  binding: z.infer<typeof ZiniaoStoreBindingSchema>;
  service: ZiniaoCliService;
  signal?: AbortSignal;
  /** Candidate versions are accepted only by an explicit feasibility harness.
   * Production callers omit this and use the evidence-backed allowlist. */
  allowedClientVersions?: readonly string[];
}): Promise<ZiniaoEndpoint> {
  if (process.platform !== "win32")
    throw new Error("Ziniao recording is supported on Windows 11 only.");
  await input.service.verifyBinding(input.binding, input.signal);
  const state = await input.service.state(input.binding, input.signal);
  if (!state.running)
    throw new Error("The selected Ziniao store is not ready for recording.");
  const appData = process.env.APPDATA;
  if (!appData) throw new Error("Windows application data is unavailable.");
  const clientPath = (
    await readFile(path.join(appData, "ziniaobrowser", "gui-path"), "utf8")
  ).trim();
  if (
    !path.win32.isAbsolute(clientPath) ||
    path.win32.basename(clientPath).toLowerCase() !== "ziniao.exe"
  )
    throw new Error("The Ziniao client path is not trusted.");
  const clientVersion = (
    await run(
      powershell(),
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `(Get-Item -LiteralPath ${quotePowerShell(clientPath)}).VersionInfo.FileVersion`,
      ],
      { encoding: "utf8", windowsHide: true, signal: input.signal },
    )
  ).stdout.trim();
  const allowedClientVersions =
    input.allowedClientVersions ?? ZINIAO_VALIDATED_CLIENT_VERSIONS;
  if (!allowedClientVersions.includes(clientVersion))
    throw new Error("This Ziniao client version requires compatibility validation.");
  const processOutput = await run(
    powershell(),
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Get-CimInstance Win32_Process | Select-Object Name,ProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress",
    ],
    {
      encoding: "utf8",
      windowsHide: true,
      signal: input.signal,
      maxBuffer: 8 * 1024 * 1024,
    },
  );
  const selected = selectStoreProcess(
    parseProcesses(processOutput.stdout),
    input.binding.storeId,
  );
  const kernelVersion = FileVersionSchema.parse(
    JSON.parse(
      (
        await run(
          powershell(),
          [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            `(Get-Item -LiteralPath ${quotePowerShell(selected.ExecutablePath!)}).VersionInfo | Select-Object FileVersion,ProductVersion | ConvertTo-Json -Compress`,
          ],
          { encoding: "utf8", windowsHide: true, signal: input.signal },
        )
      ).stdout,
    ),
  ).FileVersion;
  if (kernelVersion !== ZINIAO_KERNEL_VERSION)
    throw new Error("This Ziniao kernel version requires compatibility validation.");
  const listenerOutput = await run(
    path.join(process.env.SystemRoot!, "System32", "netstat.exe"),
    ["-ano", "-p", "TCP"],
    { encoding: "utf8", windowsHide: true, signal: input.signal },
  );
  const listeners = listenerOutput.stdout
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/))
    .filter(
      (columns) =>
        columns[3] === "LISTENING" &&
        columns[4] === String(selected.ProcessId) &&
        /^127\.0\.0\.1:\d+$/.test(columns[1] ?? ""),
    )
    .map((columns) => columns[1]!);
  const candidates: Array<{
    endpoint: string;
    webSocketDebuggerUrl: string;
  }> = [];
  for (const listener of listeners) {
    const endpoint = `http://${listener}`;
    try {
      const response = await fetch(`${endpoint}/json/version`, {
        signal: AbortSignal.any([
          input.signal ?? new AbortController().signal,
          AbortSignal.timeout(2000),
        ]),
        redirect: "error",
      });
      if (!response.ok) continue;
      const version = VersionResponseSchema.parse(await response.json());
      const websocket = new URL(version.webSocketDebuggerUrl);
      if (websocket.protocol === "ws:" && websocket.host === listener) {
        candidates.push({
          endpoint,
          webSocketDebuggerUrl: version.webSocketDebuggerUrl,
        });
      }
    } catch {
      // Only loopback listeners owned by the exact selected browser PID are read.
    }
  }
  if (candidates.length !== 1)
    throw new Error("The selected Ziniao store has no unique compatible endpoint.");
  await input.service.verifyBinding(input.binding, input.signal);
  return {
    ...candidates[0]!,
    processId: selected.ProcessId,
    clientVersion,
    kernelVersion,
    state,
  };
}
