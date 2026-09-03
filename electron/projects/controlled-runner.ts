import { spawn, type ChildProcess } from "node:child_process";
import { open, mkdir, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";

import type { RunStatus } from "../../common/project-run";

const MAX_EVENT_CHARACTERS = 32_768;

export interface ControlledCommand {
  id: string;
  executable: string;
  args: readonly string[];
  cwd: string;
  logPath: string;
  timeoutMs: number;
  maxLogBytes: number;
  env?: NodeJS.ProcessEnv;
}

export interface ControlledLogEvent {
  sequence: number;
  stream: "stdout" | "stderr" | "system";
  text: string;
}

export interface ControlledRunResult {
  status: Extract<RunStatus, "succeeded" | "failed" | "canceled" | "timed-out">;
  startedAt: number;
  completedAt: number;
  exitCode: number | null;
  error?: string;
  logBytes: number;
  logTruncated: boolean;
}

interface ActiveCommand {
  child: ChildProcess | null;
  reason: "canceled" | "timed-out" | null;
  killPromise: Promise<void> | null;
  finished: Promise<void>;
  finish: () => void;
}

export interface ControlledProcessRunnerOptions {
  killGraceMs?: number;
  now?: () => number;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function waitForClose(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null)
    return Promise.resolve();
  return new Promise((resolve) => child.once("close", () => resolve()));
}

export class ControlledProcessRunner {
  private readonly active = new Map<string, ActiveCommand>();
  private readonly killGraceMs: number;
  private readonly now: () => number;

  constructor(options: ControlledProcessRunnerOptions = {}) {
    this.killGraceMs = positiveInteger(
      options.killGraceMs ?? 1_000,
      "killGraceMs",
    );
    this.now = options.now ?? Date.now;
  }

  async run(
    command: ControlledCommand,
    onLog: (event: ControlledLogEvent) => void = () => undefined,
  ): Promise<ControlledRunResult> {
    if (!command.id || this.active.has(command.id)) {
      throw new Error(
        `Command id "${command.id}" is invalid or already active.`,
      );
    }
    if (!command.executable || command.executable.includes("\0")) {
      throw new Error("A controlled command requires an executable.");
    }
    if (!path.isAbsolute(command.cwd) || !path.isAbsolute(command.logPath)) {
      throw new Error("Controlled command paths must be absolute.");
    }
    positiveInteger(command.timeoutMs, "timeoutMs");
    positiveInteger(command.maxLogBytes, "maxLogBytes");
    if (command.args.some((argument) => argument.includes("\0"))) {
      throw new Error("Command arguments cannot contain null bytes.");
    }

    let finish!: () => void;
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const active: ActiveCommand = {
      child: null,
      reason: null,
      killPromise: null,
      finished,
      finish,
    };
    this.active.set(command.id, active);

    const startedAt = this.now();
    let handle: FileHandle | null = null;
    let sequence = 0;
    let logBytes = 0;
    let payloadBytes = 0;
    let logTruncated = false;
    let truncationMarkerWritten = false;
    let writeQueue = Promise.resolve();

    const emit = (stream: ControlledLogEvent["stream"], text: string): void => {
      for (
        let offset = 0;
        offset < text.length;
        offset += MAX_EVENT_CHARACTERS
      ) {
        try {
          onLog({
            sequence: sequence++,
            stream,
            text: text.slice(offset, offset + MAX_EVENT_CHARACTERS),
          });
        } catch {
          // A renderer listener must never interrupt or retain the child process.
        }
      }
    };

    const queueLog = (
      stream: ControlledLogEvent["stream"],
      text: string,
    ): void => {
      if (!text) return;
      emit(stream, text);
      writeQueue = writeQueue.then(async () => {
        if (!handle) return;
        const bytes = Buffer.from(text, "utf8");
        const remaining = Math.max(0, command.maxLogBytes - payloadBytes);
        if (remaining > 0) {
          const kept = bytes.subarray(0, remaining);
          await handle.write(kept);
          payloadBytes += kept.byteLength;
          logBytes += kept.byteLength;
        }
        if (bytes.byteLength > remaining) {
          logTruncated = true;
          if (!truncationMarkerWritten) {
            truncationMarkerWritten = true;
            const marker = Buffer.from(
              `\n[FlowCode] log truncated after ${command.maxLogBytes} bytes.\n`,
              "utf8",
            );
            await handle.write(marker);
            logBytes += marker.byteLength;
            emit("system", marker.toString("utf8"));
          }
        }
      });
    };

    try {
      await mkdir(path.dirname(command.logPath), { recursive: true });
      handle = await open(command.logPath, "wx");
      if (active.reason) {
        queueLog(
          "system",
          `[FlowCode] command ${active.reason} before launch.\n`,
        );
        await writeQueue;
        return {
          status: active.reason,
          startedAt,
          completedAt: this.now(),
          exitCode: null,
          logBytes,
          logTruncated,
        };
      }

      const child = spawn(command.executable, [...command.args], {
        cwd: command.cwd,
        env: command.env,
        shell: false,
        windowsHide: true,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
      active.child = child;

      const stdout = new StringDecoder("utf8");
      const stderr = new StringDecoder("utf8");
      child.stdout?.on("data", (chunk: Buffer) =>
        queueLog("stdout", stdout.write(chunk)),
      );
      child.stderr?.on("data", (chunk: Buffer) =>
        queueLog("stderr", stderr.write(chunk)),
      );

      let spawnError: string | undefined;
      child.once("error", (error) => {
        spawnError = errorMessage(error);
        queueLog(
          "system",
          `[FlowCode] command failed to start: ${spawnError}\n`,
        );
      });

      const timeout = setTimeout(() => {
        void this.stop(command.id, "timed-out");
      }, command.timeoutMs);
      timeout.unref?.();
      if (active.reason) void this.stop(command.id, active.reason);

      const { code } = await new Promise<{ code: number | null }>((resolve) => {
        child.once("close", (exitCode) => resolve({ code: exitCode }));
      });
      clearTimeout(timeout);
      queueLog("stdout", stdout.end());
      queueLog("stderr", stderr.end());
      await writeQueue;

      const completedAt = this.now();
      if (active.reason) {
        return {
          status: active.reason,
          startedAt,
          completedAt,
          exitCode: code,
          logBytes,
          logTruncated,
        };
      }
      if (spawnError) {
        return {
          status: "failed",
          startedAt,
          completedAt,
          exitCode: code,
          error: spawnError,
          logBytes,
          logTruncated,
        };
      }
      return {
        status: code === 0 ? "succeeded" : "failed",
        startedAt,
        completedAt,
        exitCode: code,
        error:
          code === 0
            ? undefined
            : `Command exited with code ${code ?? "unknown"}.`,
        logBytes,
        logTruncated,
      };
    } finally {
      await writeQueue.catch(() => undefined);
      await handle?.close().catch(() => undefined);
      this.active.delete(command.id);
      active.finish();
    }
  }

  cancel(id: string): Promise<boolean> {
    return this.stop(id, "canceled");
  }

  async dispose(): Promise<void> {
    const active = [...this.active.entries()];
    await Promise.all(active.map(([id]) => this.stop(id, "canceled")));
    await Promise.all(active.map(([, command]) => command.finished));
  }

  private async stop(
    id: string,
    reason: "canceled" | "timed-out",
  ): Promise<boolean> {
    const active = this.active.get(id);
    if (!active) return false;
    active.reason ??= reason;
    if (!active.child) return true;
    active.killPromise ??= this.killTree(active.child);
    await active.killPromise;
    return true;
  }

  private async killTree(child: ChildProcess): Promise<void> {
    const pid = child.pid;
    if (!pid || child.exitCode !== null || child.signalCode !== null) return;

    if (process.platform === "win32") {
      const taskkill = path.join(
        process.env.SystemRoot ?? "C:\\Windows",
        "System32",
        "taskkill.exe",
      );
      const killer = spawn(taskkill, ["/pid", String(pid), "/T", "/F"], {
        shell: false,
        windowsHide: true,
        stdio: "ignore",
      });
      await waitForClose(killer).catch(() => undefined);
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await waitForClose(child).catch(() => undefined);
      return;
    }

    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
    await Promise.race([
      waitForClose(child),
      new Promise((resolve) => setTimeout(resolve, this.killGraceMs)),
    ]);
    if (child.exitCode === null && child.signalCode === null) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
      await waitForClose(child).catch(() => undefined);
    }
  }
}
