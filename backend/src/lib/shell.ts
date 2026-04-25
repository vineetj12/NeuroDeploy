import { exec } from "node:child_process";

/**
 * Runs a shell command and returns its combined stdout+stderr output.
 * Resolves with `{ ok: true }` on success, `{ ok: false }` on non-zero exit.
 */
export async function runShellCommand(
  command: string,
  cwd: string,
  timeoutMs = 60_000
): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    exec(
      command,
      { cwd, timeout: timeoutMs, maxBuffer: 5 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const output = `${stdout}\n${stderr}`.trim();
        if (error) {
          resolve({ ok: false, output: output || error.message });
        } else {
          resolve({ ok: true, output });
        }
      }
    );
  });
}
