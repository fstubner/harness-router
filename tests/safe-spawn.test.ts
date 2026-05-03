/**
 * Tests for safeSpawn — focuses on the Windows cmd.exe wrapper path
 * (cross-spawn-style quoting).
 *
 * On POSIX, safeSpawn just delegates to spawn — that path is exercised
 * indirectly by every dispatcher test in the suite. The interesting
 * coverage here is the Windows path-with-spaces + arg-with-meta-chars
 * combination that previously broke codex (and would have broken any
 * harness installed under `C:\Program Files\…`).
 *
 * Strategy: mock `node:child_process.spawn` and `which`, exercise
 * safeSpawn, and assert on the exact (command, args, options) we'd hand
 * to spawn. We don't actually launch a child — we verify the recipe is
 * correct.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("which", () => ({
  default: vi.fn(),
}));
vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

import which from "which";
import { spawn } from "node:child_process";
import { safeSpawn } from "../src/dispatchers/shared/safe-spawn.js";

const mockedWhich = which as unknown as ReturnType<typeof vi.fn>;
const mockedSpawn = spawn as unknown as ReturnType<typeof vi.fn>;

const originalPlatform = process.platform;

function setPlatform(p: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value: p, configurable: true });
}

function lastSpawnCall(): { command: string; args: string[]; options: Record<string, unknown> } {
  const call = mockedSpawn.mock.calls.at(-1);
  if (!call) throw new Error("spawn was not called");
  return {
    command: call[0] as string,
    args: (call[1] as string[]) ?? [],
    options: (call[2] as Record<string, unknown>) ?? {},
  };
}

beforeEach(() => {
  mockedWhich.mockReset();
  mockedSpawn.mockReset();
  // spawn is invoked for its side effect; return a plain marker.
  mockedSpawn.mockReturnValue({} as never);
});

afterEach(() => {
  setPlatform(originalPlatform);
});

describe("safeSpawn — POSIX", () => {
  beforeEach(() => setPlatform("linux"));

  it("spawns the resolved binary directly with the original args", async () => {
    mockedWhich.mockResolvedValueOnce("/usr/local/bin/codex");
    await safeSpawn("codex", ["exec", "hello"]);
    const call = lastSpawnCall();
    expect(call.command).toBe("/usr/local/bin/codex");
    expect(call.args).toEqual(["exec", "hello"]);
    expect(call.options.windowsVerbatimArguments).toBeUndefined();
  });

  it("falls back to the bare command name when which returns null", async () => {
    mockedWhich.mockResolvedValueOnce(null);
    await safeSpawn("nope", ["x"]);
    const call = lastSpawnCall();
    expect(call.command).toBe("nope");
    expect(call.args).toEqual(["x"]);
  });
});

describe("safeSpawn — Windows native .exe", () => {
  beforeEach(() => setPlatform("win32"));

  it("does NOT wrap .exe binaries (no cmd.exe in the picture)", async () => {
    mockedWhich.mockResolvedValueOnce("C:\\Windows\\System32\\python.exe");
    await safeSpawn("python", ["-V"]);
    const call = lastSpawnCall();
    expect(call.command).toBe("C:\\Windows\\System32\\python.exe");
    expect(call.args).toEqual(["-V"]);
    expect(call.options.windowsVerbatimArguments).toBeUndefined();
  });

  it("does NOT wrap extensionless paths", async () => {
    mockedWhich.mockResolvedValueOnce("C:\\tools\\rusty");
    await safeSpawn("rusty", []);
    const call = lastSpawnCall();
    expect(call.command).toBe("C:\\tools\\rusty");
    expect(call.options.windowsVerbatimArguments).toBeUndefined();
  });
});

describe("safeSpawn — Windows .cmd shim wrapping (cross-spawn algorithm)", () => {
  const savedComSpec = process.env["ComSpec"];

  beforeEach(() => {
    setPlatform("win32");
    process.env["ComSpec"] = "C:\\Windows\\System32\\cmd.exe";
  });

  afterEach(() => {
    if (savedComSpec === undefined) delete process.env["ComSpec"];
    else process.env["ComSpec"] = savedComSpec;
  });

  it('wraps .cmd shims with `<ComSpec> /d /s /c "<cmdline>"`', async () => {
    mockedWhich.mockResolvedValueOnce("C:\\Users\\test\\AppData\\Roaming\\npm\\foo.cmd");
    await safeSpawn("foo", []);
    const call = lastSpawnCall();
    expect(call.command).toBe("C:\\Windows\\System32\\cmd.exe");
    expect(call.args[0]).toBe("/d");
    expect(call.args[1]).toBe("/s");
    expect(call.args[2]).toBe("/c");
    expect(call.options.windowsVerbatimArguments).toBe(true);
  });

  it("wraps .bat shims identically to .cmd", async () => {
    mockedWhich.mockResolvedValueOnce("C:\\Tools\\foo.bat");
    await safeSpawn("foo", []);
    const call = lastSpawnCall();
    expect(call.command).toBe("C:\\Windows\\System32\\cmd.exe");
    expect(call.args[0]).toBe("/d");
  });

  it("falls back to cmd.exe when ComSpec is not set", async () => {
    delete process.env["ComSpec"];
    mockedWhich.mockResolvedValueOnce("C:\\Tools\\foo.cmd");
    await safeSpawn("foo", []);
    const call = lastSpawnCall();
    expect(call.command).toBe("cmd.exe");
  });

  it("preserves a path containing spaces (the codex bug we fixed)", async () => {
    // This is the path shape that triggered `'C:\Program' is not recognized`
    // before the safe-spawn refactor. The fix is that the command path is
    // CreateProcess-quoted (just `"…"`) — NOT caret-escaped — so cmd.exe's
    // quoted-token parser identifies the path after `/s` strips the outer
    // wrapping.
    mockedWhich.mockResolvedValueOnce("C:\\Program Files\\nodejs\\codex.cmd");
    await safeSpawn("codex", ["exec", "hi"]);
    const call = lastSpawnCall();
    const cmdline = call.args[3]!;
    // The full cmdline is wrapped in outer quotes for /s.
    expect(cmdline.startsWith('"')).toBe(true);
    expect(cmdline.endsWith('"')).toBe(true);
    // The command path appears with simple double-quotes (no carets) so cmd
    // can parse the quoted token.
    expect(cmdline).toContain('"C:\\Program Files\\nodejs\\codex.cmd"');
    // The path has NOT been split with carets.
    expect(cmdline).not.toContain('^"C:\\Program');
  });

  it("caret-escapes argument quotes (so cmd doesn't reinterpret them)", async () => {
    mockedWhich.mockResolvedValueOnce("C:\\Tools\\foo.cmd");
    await safeSpawn("foo", ["arg"]);
    const cmdline = lastSpawnCall().args[3]!;
    // Args have caret-escaped quotes: `^"arg^"`.
    expect(cmdline).toContain('^"arg^"');
  });

  it("caret-escapes cmd meta-chars in arguments (& | < > etc.)", async () => {
    mockedWhich.mockResolvedValueOnce("C:\\Tools\\foo.cmd");
    await safeSpawn("foo", ["a&b", "c|d"]);
    const cmdline = lastSpawnCall().args[3]!;
    // The unsafe meta-chars get a caret prefix.
    expect(cmdline).toContain("^&");
    expect(cmdline).toContain("^|");
  });

  it("escapes embedded double-quotes in arguments (CreateProcess + caret)", async () => {
    mockedWhich.mockResolvedValueOnce("C:\\Tools\\foo.cmd");
    await safeSpawn("foo", ['hello "world"']);
    const cmdline = lastSpawnCall().args[3]!;
    // CreateProcess turns the inner `"` into `\"`. Then quoteForCmdShell's
    // caret pass matches every `"` (including the just-escaped ones) and
    // prefixes a `^`, producing `\^"` for embedded quotes. The outer wrap
    // quotes also get caret-escaped (they're argv quotes, not the command).
    expect(cmdline).toContain('hello \\^"world\\^"');
  });

  it('handles empty-string arguments as `""`', async () => {
    mockedWhich.mockResolvedValueOnce("C:\\Tools\\foo.cmd");
    await safeSpawn("foo", [""]);
    const cmdline = lastSpawnCall().args[3]!;
    // Empty-arg gets the literal `""` in CreateProcess, then caret-escaped.
    expect(cmdline).toContain('^"^"');
  });

  it("emits a single-token cmdline when args is empty", async () => {
    mockedWhich.mockResolvedValueOnce("C:\\Tools\\foo.cmd");
    await safeSpawn("foo", []);
    const cmdline = lastSpawnCall().args[3]!;
    // The inner cmdline is just the command path, no trailing whitespace.
    // Outer wrap `"…"` is added; inside we expect `"C:\\Tools\\foo.cmd"`.
    expect(cmdline).toBe('""C:\\Tools\\foo.cmd""');
  });
});
