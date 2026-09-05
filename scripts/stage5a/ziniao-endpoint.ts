import { execFileSync } from "node:child_process";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { splitWindowsCommandLine } from "../../electron/ziniao/windows-command-line";
import {
  detectZiniaoCli,
  createZiniaoTransport,
  ZiniaoCliService,
  ziniaoConfigFingerprint,
} from "../../electron/ziniao/cli-service";

const ProcessSchema = z
  .object({
    Name: z.string(),
    ProcessId: z.number().int(),
    ExecutablePath: z.string().nullable(),
    CommandLine: z.string().nullable(),
  })
  .strip();
const VersionSchema = z
  .object({
    Browser: z.literal("Chrome/142.0.7444.168"),
    "Protocol-Version": z.literal("1.3"),
    webSocketDebuggerUrl: z.string().url(),
  })
  .strip();
const shell = path.join(
  process.env.SystemRoot ?? "C:\\Windows",
  "System32/WindowsPowerShell/v1.0/powershell.exe",
);
export async function selectedZiniaoEndpoint() {
  const name = process.env.FLOWCODE_TEST_STORE_NAME;
  if (!name)
    throw new Error(
      "Set FLOWCODE_TEST_STORE_NAME to the user-selected test environment.",
    );
  const cli = await detectZiniaoCli(
    path.join(
      process.env.APPDATA!,
      "npm/node_modules/@ziniao-open/cli/bin/ziniao-cli.exe",
    ),
  );
  const clientPath = (
    await readFile(
      path.join(process.env.APPDATA!, "ziniaobrowser/gui-path"),
      "utf8",
    )
  ).trim();
  if (
    !path.win32.isAbsolute(clientPath) ||
    path.win32.basename(clientPath).toLowerCase() !== "ziniao.exe"
  )
    throw new Error("Ziniao client location is not the detected executable.");
  const clientVersion = execFileSync(
    shell,
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `(Get-Item -LiteralPath '${clientPath.replaceAll("'", "''")}').VersionInfo.FileVersion`,
    ],
    { windowsHide: true, encoding: "utf8" },
  ).trim();
  if (clientVersion !== "6.26.6.7")
    throw new Error("Ziniao client version requires endpoint revalidation.");
  const service = new ZiniaoCliService(
    createZiniaoTransport(cli.binary),
    ziniaoConfigFingerprint(
      path.join(process.env.USERPROFILE!, ".ziniao-cli/config.json"),
    ),
  );
  const binding = await service.bindName(name);
  const state = await service.state(binding);
  if (!state.running)
    throw new Error(
      "Selected test environment is not running; no implicit launch or retry.",
    );
  const processes = z
    .array(ProcessSchema)
    .parse(
      JSON.parse(
        execFileSync(
          shell,
          [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Get-CimInstance Win32_Process | Select-Object Name,ProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress",
          ],
          { windowsHide: true, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
        ),
      ),
    );
  const selected = processes.filter((p) => {
    if (
      p.Name.toLowerCase() !== "ziniaobrowser.exe" ||
      !p.CommandLine ||
      !p.ExecutablePath
    )
      return false;
    const args = splitWindowsCommandLine(p.CommandLine);
    return (
      !args.some((a) => a.startsWith("--type=")) &&
      args.some((a) => a.startsWith("--store_data_path=")) &&
      args.filter((a) => a.startsWith("--user-data-dir=")).length === 1 &&
      args.some(
        (a) =>
          a.startsWith("--user-data-dir=") &&
          path.win32.basename(a.slice("--user-data-dir=".length)) ===
            `chrome_${binding.storeId}`,
      )
    );
  });
  if (selected.length !== 1) {
    const diagnostics = processes
      .filter((p) => p.CommandLine?.includes(binding.storeId))
      .map((p) => {
        const args = splitWindowsCommandLine(p.CommandLine!);
        return {
          kernel: p.Name.toLowerCase() === "ziniaobrowser.exe",
          subprocess: args.some((a) => a.startsWith("--type=")),
          storeFlag: args.some((a) => a.startsWith("--store_data_path=")),
          profileArgs: args.filter((a) => a.startsWith("--user-data-dir="))
            .length,
          profileMatch: args.some(
            (a) =>
              a.startsWith("--user-data-dir=") &&
              path.win32.basename(a.slice("--user-data-dir=".length)) ===
                binding.storeId,
          ),
          profileSuffix: args.some(
            (a) =>
              a.startsWith("--user-data-dir=") && a.endsWith(binding.storeId),
          ),
          profileLeafPattern: args
            .filter((a) => a.startsWith("--user-data-dir="))
            .map((a) =>
              path.win32
                .basename(a.slice("--user-data-dir=".length))
                .replace(binding.storeId, "<selected>")
                .replace(/[0-9]+/g, "<n>"),
            ),
        };
      });
    throw new Error(
      `Selected store process identity not unique: ${JSON.stringify(diagnostics)}`,
    );
  }
  const proc = selected[0];
  const version = JSON.parse(
    execFileSync(
      shell,
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `(Get-Item -LiteralPath '${proc.ExecutablePath!.replaceAll("'", "''")}').VersionInfo | Select-Object FileVersion,ProductVersion | ConvertTo-Json -Compress`,
      ],
      { windowsHide: true, encoding: "utf8" },
    ),
  );
  if (version.FileVersion !== "142.0.7444.168")
    throw new Error("Kernel version requires endpoint revalidation.");
  const listeners = execFileSync(
    path.join(process.env.SystemRoot!, "System32/netstat.exe"),
    ["-ano", "-p", "TCP"],
    { windowsHide: true, encoding: "utf8" },
  )
    .split(/\r?\n/)
    .map((l) => l.trim().split(/\s+/))
    .filter(
      (c) =>
        c[3] === "LISTENING" &&
        c[4] === String(proc.ProcessId) &&
        c[1].startsWith("127.0.0.1:"),
    );
  const endpoints: string[] = [];
  for (const l of listeners) {
    const endpoint = `http://${l[1]}`;
    try {
      const v = VersionSchema.parse(
        await (
          await fetch(endpoint + "/json/version", {
            signal: AbortSignal.timeout(2000),
            redirect: "error",
          })
        ).json(),
      );
      const ws = new URL(v.webSocketDebuggerUrl);
      if (ws.protocol === "ws:" && ws.host === l[1]) endpoints.push(endpoint);
    } catch {
      /* Only owned loopback listeners are inspected; no arbitrary port scan. */
    }
  }
  if (endpoints.length !== 1)
    throw new Error(
      "No unique compatible CDP endpoint owned by the selected process.",
    );
  await service.verifyBinding(binding);
  return {
    endpoint: endpoints[0],
    service,
    binding,
    state,
    cliVersion: cli.version,
    clientVersion,
    kernelVersion: version.FileVersion,
  };
}
