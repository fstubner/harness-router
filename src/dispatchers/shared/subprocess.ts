/**
 * Async subprocess runner.
 *
 * Wraps `child_process.spawn` (via `safeSpawn`, which handles Windows
 * `.cmd`/`.bat` shims with proper quoting) with:
 * - hard timeout (SIGTERM, then SIGKILL after grace period)
 * - output byte cap (protects the agent from pathological CLI output)
 * - DEVNULL stdin by default (prevents interactive auth prompts from hanging)
 * - UTF-8 decoding with replacement on invalid sequences
 */

import { type ChildProcess, type SpawnOptions } from "node:child_process";

import { safeSpawn } from "./safe-spawn.js";

export interface SubprocessResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  timedOut: boolean;
  /**
   * True iff output exceeded `maxOutputBytes` and the child was killed.
   * The buffered API didn't expose this historically; it's optional so
   * existing tests/mocks that don't set it stay valid.
   */
  truncated?: boolean;
}

export interface RunSubprocessOpts {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  maxOutputBytes?: number;
  /**
   * Optional input to write to the child's stdin (and then close). When
   * set, spawn switches stdin from `"ignore"` to `"pipe"`. Used by
   * generic_cli recipes with `promptDelivery: "stdin"`. Treated as UTF-8.
   */
  stdinInput?: string;
}

const DEFAULT_TIMEOUT_MS = 300_000;
const DEFAULT_MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
const KILL_GRACE_MS = 2_000;

export function runSubprocess(
  command: string,
  args: readonly string[],
  opts: RunSubprocessOpts = {},
): Promise<SubprocessResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const start = Date.now();

  const stdinMode: "ignore" | "pipe" = opts.stdinInput !== undefined ? "pipe" : "ignore";
  const spawnOpts: SpawnOptions = {
    stdio: [stdinMode, "pipe", "pipe"],
    windowsHide: true,
    env: opts.env ? { ...process.env, ...opts.env } : process.env,
  };
  if (opts.cwd !== undefined) spawnOpts.cwd = opts.cwd;

  return new Promise((resolve, reject) => {
    safeSpawn(command, args, spawnOpts).then(
      (child) => {
        // Feed the prompt on stdin if requested. Errors here are typically
        // EPIPE when the child has already exited — swallow; the close
        // handler reports the real failure.
        if (opts.stdinInput !== undefined && child.stdin) {
          try {
            child.stdin.end(opts.stdinInput, "utf8");
          } catch {
            /* child already terminated */
          }
        }
        attachAndDrain(child, resolve, reject);
      },
      (err) => reject(err instanceof Error ? err : new Error(String(err))),
    );
  });

  function attachAndDrain(
    child: ChildProcess,
    resolve: (r: SubprocessResult) => void,
    reject: (err: unknown) => void,
  ): void {
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let truncated = false;
    let timedOut = false;
    let settled = false;

    const appendStdout = (chunk: Buffer): void => {
      if (truncated) return;
      if (stdoutBytes + chunk.length > maxOutputBytes) {
        const remaining = Math.max(0, maxOutputBytes - stdoutBytes);
        if (remaining > 0) stdoutChunks.push(chunk.subarray(0, remaining));
        stdoutBytes = maxOutputBytes;
        truncated = true;
        child.kill("SIGTERM");
        return;
      }
      stdoutChunks.push(chunk);
      stdoutBytes += chunk.length;
    };

    const appendStderr = (chunk: Buffer): void => {
      if (truncated) return;
      if (stderrBytes + chunk.length > maxOutputBytes) {
        const remaining = Math.max(0, maxOutputBytes - stderrBytes);
        if (remaining > 0) stderrChunks.push(chunk.subarray(0, remaining));
        stderrBytes = maxOutputBytes;
        truncated = true;
        child.kill("SIGTERM");
        return;
      }
      stderrChunks.push(chunk);
      stderrBytes += chunk.length;
    };

    child.stdout?.on("data", (chunk: Buffer) => appendStdout(chunk));
    child.stderr?.on("data", (chunk: Buffer) => appendStderr(chunk));

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      // Force-kill if the child ignores SIGTERM.
      setTimeout(() => {
        if (!settled) {
          try {
            child.kill("SIGKILL");
          } catch {
            // already dead
          }
        }
      }, KILL_GRACE_MS).unref();
    }, timeoutMs);
    timer.unref();

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });

    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const exitCode = code ?? (signal ? 128 : -1);
      resolve({
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        exitCode,
        durationMs: Date.now() - start,
        timedOut,
        truncated,
      });
    });
  }
}
