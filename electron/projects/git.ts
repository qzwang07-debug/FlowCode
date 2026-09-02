import { spawn } from "node:child_process";

interface GitResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function runGit(
  directory: string,
  args: readonly string[],
): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", [...args], {
      cwd: directory,
      shell: false,
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      resolve({
        exitCode: code ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8").trim(),
        stderr: Buffer.concat(stderr).toString("utf8").trim(),
      });
    });
  });
}

async function isInsideGitRepository(directory: string): Promise<boolean> {
  const result = await runGit(directory, [
    "rev-parse",
    "--is-inside-work-tree",
  ]);
  return result.exitCode === 0 && result.stdout === "true";
}

/** Initialize only a local repository. This fixed command never adds a remote or pushes. */
export async function initializeLocalGit(directory: string): Promise<void> {
  if (await isInsideGitRepository(directory)) return;
  const initialized = await runGit(directory, [
    "init",
    "--initial-branch=main",
  ]);
  if (initialized.exitCode !== 0) {
    throw new Error(
      `Could not initialize the local Git repository: ${initialized.stderr}`,
    );
  }
  const remotes = await runGit(directory, ["remote"]);
  if (remotes.exitCode !== 0 || remotes.stdout) {
    throw new Error(
      "A newly created FlowCode project must not have a Git remote.",
    );
  }
}
