/**
 * Cross-platform safe spawn for CLI binaries.
 *
 * On POSIX: spawns the resolved binary directly.
 * On Windows .exe: spawns the resolved exe directly.
 * On Windows .cmd / .bat: wraps with `cmd /d /s /c "<cmdline>"` using the
 *   `cross-spawn` algorithm.
 *
 *   The COMMAND PATH is wrapped only at the CreateProcess level (`"…"`) —
 *   no caret escape — so cmd.exe's quoted-token parser identifies the
 *   executable path correctly after `/s` strips the outer wrapping.
 *
 *   ARGUMENTS get both layers: CreateProcess-level quote-wrap PLUS caret
 *   escape of cmd's meta-characters (`& | < > ^ ( ) % ! "`) so cmd doesn't
 *   interpret them mid-line.
 *
 *   The whole resulting command line is wrapped in one set of quotes that
 *   cmd.exe's `/s` flag strips exactly once. `windowsVerbatimArguments: true`
 *   tells Node to skip its own escaping pass so our quoting reaches cmd.exe
 *   byte-for-byte.
 *
 * Why this exists:
 *   `spawn("cmd", ["/c", "C:\\Program Files\\foo.cmd", "exec", "long arg"])`
 *   produces a command line where cmd.exe's default `/c` parsing rule sees
 *   four quotes, falls through to "strip first and last quote", and the path
 *   gets split on the space. With the cross-spawn pattern, cmd.exe parses
 *   correctly and the path is preserved.
 *
 * The argument-quoting algorithm is a vendored adaptation of cross-spawn's
 * (MIT, https://github.com/moxystudio/node-cross-spawn) — narrowed to just
 * the cmd.exe wrapper case we need.
 */

import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import path from "node:path";
import which from "which";

/**
 * Spawn a CLI safely across platforms. Resolves the command via `which`,
 * detects `.cmd`/`.bat` shims on Windows, and wraps them with cmd.exe using
 * the cross-spawn pattern so paths containing spaces and args containing
 * special characters parse correctly.
 *
 * If `which` cannot resolve `command`, this falls back to spawning it
 * verbatim — the resulting ENOENT bubbles up to the caller, matching the
 * previous behaviour.
 */
export async function safeSpawn(
  command: string,
  args: readonly string[],
  options: SpawnOptions = {},
): Promise<ChildProcess> {
  const resolved = (await which(command, { nothrow: true })) ?? command;

  if (process.platform !== "win32") {
    return spawn(resolved, args as string[], options);
  }

  const ext = path.extname(resolved).toLowerCase();
  if (ext !== ".cmd" && ext !== ".bat") {
    return spawn(resolved, args as string[], options);
  }

  const shell = process.env["ComSpec"] ?? "cmd.exe";
  // The command path uses ONLY the CreateProcess-level quote-wrap — no
  // caret escape — so cmd.exe parses the surrounding quotes as quote
  // delimiters after `/s` strips the outer command wrapping. Args are
  // additionally caret-escaped so cmd doesn't interpret meta-chars in user
  // text (prompts, etc.).
  const commandPart = quoteForCreateProcess(resolved);
  const argsPart = args.map(quoteForCmdShell).join(" ");
  const cmdline = argsPart.length > 0 ? `${commandPart} ${argsPart}` : commandPart;
  return spawn(shell, ["/d", "/s", "/c", `"${cmdline}"`], {
    ...options,
    windowsVerbatimArguments: true,
  });
}

/**
 * Quote a single argument for the CreateProcess command-line parser.
 * Doubles backslashes that precede a quote, escapes embedded quotes as `\"`,
 * doubles trailing backslashes, and wraps in `"..."`. This is the layer
 * that the .cmd/.bat shim (and any executable) sees after cmd hands off.
 *
 * Algorithm: https://qntm.org/cmd
 */
function quoteForCreateProcess(arg: string): string {
  const a = String(arg);
  if (a.length === 0) return '""';
  let escaped = a;
  escaped = escaped.replace(/(\\*)"/g, '$1$1\\"');
  escaped = escaped.replace(/(\\*)$/, "$1$1");
  return `"${escaped}"`;
}

/**
 * Quote a single argument for inclusion in a cmd.exe command line.
 *
 * Two layers of escaping:
 *   1. CreateProcess-level (same as `quoteForCreateProcess`).
 *   2. cmd.exe meta-characters (`& | < > ^ ( ) % ! "`) — caret-escaped so
 *      cmd doesn't interpret them before passing the line to the program.
 *
 * Used for argv entries, NOT the command itself. The command's quotes need
 * to stay unescaped so cmd's quoted-token parser identifies the executable
 * path after `/s` strips the outer wrapping.
 */
function quoteForCmdShell(arg: string): string {
  const escaped = quoteForCreateProcess(arg);
  return escaped.replace(/([()%!^"<>&|;,])/g, "^$1");
}
