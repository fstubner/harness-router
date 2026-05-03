import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type {
  SubprocessResult,
  RunSubprocessOpts,
} from "../../src/dispatchers/shared/subprocess.js";

// Dispatchers no longer call resolveCliCommand directly — Windows .cmd
// quoting now lives in safeSpawn (covered by tests/safe-spawn.test.ts).
vi.mock("../../src/dispatchers/shared/subprocess.js", () => ({
  runSubprocess: vi.fn(),
}));
vi.mock("which", () => ({
  default: vi.fn(),
}));

const { runSubprocess } = await import("../../src/dispatchers/shared/subprocess.js");
const { default: which } = await import("which");
const { CursorDispatcher } = await import("../../src/dispatchers/cursor.js");

const runSubprocessMock = runSubprocess as unknown as ReturnType<typeof vi.fn>;
const whichMock = which as unknown as ReturnType<typeof vi.fn>;

function ok(overrides: Partial<SubprocessResult> = {}): SubprocessResult {
  return {
    stdout: "",
    stderr: "",
    exitCode: 0,
    durationMs: 42,
    timedOut: false,
    ...overrides,
  };
}

function captureSubprocessCall(index: number): {
  command: string;
  args: string[];
  opts: RunSubprocessOpts | undefined;
} {
  const call = runSubprocessMock.mock.calls[index];
  if (!call) throw new Error(`runSubprocess call #${index} not recorded`);
  return {
    command: call[0] as string,
    args: call[1] as string[],
    opts: call[2] as RunSubprocessOpts | undefined,
  };
}

function mockFound(commandPath = "/usr/local/bin/agent"): void {
  whichMock.mockResolvedValue(commandPath);
}

const savedEnv = { ...process.env };

beforeEach(() => {
  runSubprocessMock.mockReset();
  whichMock.mockReset();
});

afterEach(() => {
  for (const k of Object.keys(process.env)) {
    if (!(k in savedEnv)) delete process.env[k];
  }
  for (const [k, v] of Object.entries(savedEnv)) {
    process.env[k] = v;
  }
});

describe("CursorDispatcher", () => {
  it("returns an error DispatchResult when the CLI is not found", async () => {
    whichMock.mockResolvedValue(null);
    const d = new CursorDispatcher();

    const res = await d.dispatch("hi", [], "");

    expect(res.success).toBe(false);
    expect(res.service).toBe("cursor");
    expect(res.error).toMatch(/agent CLI not found/i);
    expect(res.output).toBe("");
    expect(runSubprocessMock).not.toHaveBeenCalled();
  });

  it("passes the bare command name (`agent`) to runSubprocess", async () => {
    mockFound();
    runSubprocessMock.mockResolvedValue(ok({ stdout: JSON.stringify({ result: "ok" }) }));

    const d = new CursorDispatcher();
    await d.dispatch("hi", [], "/tmp");

    const { command } = captureSubprocessCall(0);
    // Bare-name contract — safeSpawn handles which() + .cmd shim quoting.
    expect(command).toBe("agent");
  });

  it("parses JSON result on a successful run", async () => {
    mockFound();
    runSubprocessMock.mockResolvedValue(
      ok({
        stdout: JSON.stringify({
          result: "hello from cursor",
          usage: { input_tokens: 7, output_tokens: 13 },
        }),
      }),
    );

    const d = new CursorDispatcher();
    const res = await d.dispatch("do thing", [], "/tmp/work");

    expect(res.success).toBe(true);
    expect(res.service).toBe("cursor");
    expect(res.output).toBe("hello from cursor");
    expect(res.tokensUsed).toEqual({ input: 7, output: 13 });
    expect(res.durationMs).toBe(42);
  });

  it("passes --model <override> through to the subprocess", async () => {
    mockFound();
    runSubprocessMock.mockResolvedValue(ok({ stdout: JSON.stringify({ result: "ok" }) }));

    const d = new CursorDispatcher();
    await d.dispatch("go", [], "/tmp", { modelOverride: "claude-4-cursor" });

    expect(runSubprocessMock).toHaveBeenCalledTimes(1);
    const { args } = captureSubprocessCall(0);
    expect(args).toContain("--model");
    const idx = args.indexOf("--model");
    expect(args[idx + 1]).toBe("claude-4-cursor");
  });

  it("sets --workspace <workingDir> when provided", async () => {
    mockFound();
    runSubprocessMock.mockResolvedValue(ok({ stdout: JSON.stringify({ result: "ok" }) }));

    const d = new CursorDispatcher();
    await d.dispatch("go", [], "/tmp/project");

    const { args } = captureSubprocessCall(0);
    expect(args).toContain("--workspace");
    const idx = args.indexOf("--workspace");
    expect(args[idx + 1]).toBe("/tmp/project");
    // Also includes --trust and -p.
    expect(args).toContain("--trust");
    expect(args).toContain("-p");
    // Output format is json.
    expect(args).toContain("--output-format");
    const jidx = args.indexOf("--output-format");
    expect(args[jidx + 1]).toBe("json");
  });

  it("defaults --workspace to os.homedir() when workingDir is empty", async () => {
    mockFound();
    runSubprocessMock.mockResolvedValue(ok({ stdout: JSON.stringify({ result: "ok" }) }));

    const d = new CursorDispatcher();
    await d.dispatch("go", [], "");

    const { args } = captureSubprocessCall(0);
    const widx = args.indexOf("--workspace");
    expect(widx).toBeGreaterThanOrEqual(0);
    // Locks the cross-platform HOME fallback — without this, an accidental
    // regression to a constant like "." or process.cwd() would still pass.
    const os = await import("node:os");
    expect(args[widx + 1]).toBe(os.homedir());
  });

  it("forwards CURSOR_API_KEY from process.env to the subprocess", async () => {
    process.env["CURSOR_API_KEY"] = "cursor-key-xyz";
    mockFound();
    runSubprocessMock.mockResolvedValue(ok({ stdout: JSON.stringify({ result: "ok" }) }));

    const d = new CursorDispatcher();
    await d.dispatch("go", [], "/tmp");

    const { opts } = captureSubprocessCall(0);
    expect(opts?.env).toBeDefined();
    expect(opts?.env?.["CURSOR_API_KEY"]).toBe("cursor-key-xyz");
  });

  it("reports failure on a non-zero exit code", async () => {
    mockFound();
    runSubprocessMock.mockResolvedValue(ok({ stdout: "", stderr: "bad thing", exitCode: 2 }));

    const d = new CursorDispatcher();
    const res = await d.dispatch("go", [], "/tmp");

    expect(res.success).toBe(false);
    expect(res.error).toBe("bad thing");
  });

  it("marks rateLimited=true with retryAfter from 'Retry-After: N' stderr", async () => {
    mockFound();
    runSubprocessMock.mockResolvedValue(
      ok({
        stdout: "",
        stderr: "Error: 429 Too Many Requests — retry-after: 30",
        exitCode: 1,
      }),
    );

    const d = new CursorDispatcher();
    const res = await d.dispatch("go", [], "/tmp");

    expect(res.success).toBe(false);
    expect(res.rateLimited).toBe(true);
    expect(res.retryAfter).toBe(30);
  });

  it("returns a timed-out DispatchResult when the subprocess times out", async () => {
    mockFound();
    runSubprocessMock.mockResolvedValue(
      ok({
        stdout: "",
        stderr: "",
        exitCode: 124,
        timedOut: true,
      }),
    );

    const d = new CursorDispatcher();
    const res = await d.dispatch("go", [], "/tmp", { timeoutMs: 100 });

    expect(res.success).toBe(false);
    expect(res.error).toMatch(/timed out/i);
  });

  it("propagates the provided timeoutMs to runSubprocess", async () => {
    mockFound();
    runSubprocessMock.mockResolvedValue(ok({ stdout: JSON.stringify({ result: "ok" }) }));

    const d = new CursorDispatcher();
    await d.dispatch("go", [], "/tmp", { timeoutMs: 9999 });

    const { opts } = captureSubprocessCall(0);
    expect(opts?.timeoutMs).toBe(9999);
  });

  it("reports 'unknown' quota in R1", async () => {
    const d = new CursorDispatcher();
    const q = await d.checkQuota();
    expect(q.service).toBe("cursor");
    expect(q.source).toBe("unknown");
  });

  it("has a stable id and reports itself as available", () => {
    const d = new CursorDispatcher();
    expect(d.id).toBe("cursor");
    expect(d.isAvailable()).toBe(true);
  });
});
