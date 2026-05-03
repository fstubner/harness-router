/**
 * OpenCodeDispatcher unit tests.
 *
 * Same mocking pattern as the other dispatcher tests: stub `runSubprocess`
 * (which `streamSubprocess` delegates to under test conditions) and `which`,
 * then assert on the exact argv we send to `opencode run`.
 */

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
const { OpenCodeDispatcher } = await import("../../src/dispatchers/opencode.js");

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

function mockFound(commandPath = "/usr/local/bin/opencode"): void {
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

describe("OpenCodeDispatcher", () => {
  it("returns an error DispatchResult when the CLI is not found", async () => {
    whichMock.mockResolvedValue(null);
    const d = new OpenCodeDispatcher();

    const res = await d.dispatch("hi", [], "");

    expect(res.success).toBe(false);
    expect(res.service).toBe("opencode");
    expect(res.error).toMatch(/opencode CLI not found/i);
    expect(res.output).toBe("");
    expect(runSubprocessMock).not.toHaveBeenCalled();
  });

  it("dispatches with `opencode run <prompt>` and captures plain-text stdout", async () => {
    mockFound();
    runSubprocessMock.mockResolvedValue(ok({ stdout: "ok\n" }));

    const d = new OpenCodeDispatcher();
    const res = await d.dispatch("say ok", [], "/tmp/work");

    expect(res.success).toBe(true);
    expect(res.service).toBe("opencode");
    expect(res.output).toBe("ok"); // trimmed
    expect(res.durationMs).toBe(42);

    const { command, args, opts } = captureSubprocessCall(0);
    // Bare command name; safeSpawn (used inside streamSubprocess) does
    // the which() resolution and Windows .cmd quoting.
    expect(command).toBe("opencode");
    // Expect: ["run", "say ok"]. The opencode 1.14+ CLI's `run`
    // subcommand has NO `--cwd` flag — the working directory is set on
    // the spawned process via `subOpts.cwd` instead. An older version
    // of this dispatcher emitted `--cwd <path>` which the current CLI
    // rejects, printing the usage banner and exiting non-zero.
    expect(args[0]).toBe("run");
    expect(args).not.toContain("--cwd");
    // workingDir flows through subprocess cwd, not argv.
    expect(opts?.cwd).toBe("/tmp/work");
    // Prompt is the last positional.
    expect(args[args.length - 1]).toBe("say ok");
  });

  it("appends focus-files block to the prompt", async () => {
    mockFound();
    runSubprocessMock.mockResolvedValue(ok({ stdout: "done" }));

    const d = new OpenCodeDispatcher();
    await d.dispatch("refactor it", ["src/a.ts", "src/b.ts"], "");

    const { args } = captureSubprocessCall(0);
    const prompt = args[args.length - 1]!;
    expect(prompt).toContain("refactor it");
    expect(prompt).toContain("Focus on these files:");
    expect(prompt).toContain("src/a.ts");
    expect(prompt).toContain("src/b.ts");
  });

  it("forwards --model when modelOverride is set", async () => {
    mockFound();
    runSubprocessMock.mockResolvedValue(ok({ stdout: "ok" }));

    const d = new OpenCodeDispatcher();
    await d.dispatch("hi", [], "", { modelOverride: "claude-opus-4-6" });

    const { args } = captureSubprocessCall(0);
    expect(args).toContain("--model");
    const idx = args.indexOf("--model");
    expect(args[idx + 1]).toBe("claude-opus-4-6");
  });

  it("forwards configured model from ServiceConfig when no override given", async () => {
    mockFound();
    runSubprocessMock.mockResolvedValue(ok({ stdout: "ok" }));

    const svc = { name: "opencode", model: "gpt-5.4" } as any;
    const d = new OpenCodeDispatcher(svc);
    await d.dispatch("hi", [], "", {});

    const { args } = captureSubprocessCall(0);
    expect(args).toContain("--model");
    const idx = args.indexOf("--model");
    expect(args[idx + 1]).toBe("gpt-5.4");
  });

  it("forwards provider env vars when set", async () => {
    mockFound();
    runSubprocessMock.mockResolvedValue(ok({ stdout: "ok" }));
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    process.env.OPENAI_API_KEY = "sk-oa-test";

    const d = new OpenCodeDispatcher();
    await d.dispatch("hi", [], "/tmp/work");

    const { opts } = captureSubprocessCall(0);
    expect(opts?.env?.ANTHROPIC_API_KEY).toBe("sk-ant-test");
    expect(opts?.env?.OPENAI_API_KEY).toBe("sk-oa-test");
  });

  it("returns success=false with stderr error on non-zero exit", async () => {
    mockFound();
    runSubprocessMock.mockResolvedValue(
      ok({
        exitCode: 1,
        stderr: "auth failed: please run `opencode auth login`",
      }),
    );

    const d = new OpenCodeDispatcher();
    const res = await d.dispatch("hi", [], "");

    expect(res.success).toBe(false);
    expect(res.error).toContain("auth failed");
    expect(res.service).toBe("opencode");
  });

  it("flags rate-limited responses with retryAfter when present", async () => {
    mockFound();
    runSubprocessMock.mockResolvedValue(
      ok({
        exitCode: 1,
        stderr: "Error: 429 Too Many Requests. retry-after: 30",
      }),
    );

    const d = new OpenCodeDispatcher();
    const res = await d.dispatch("hi", [], "");

    expect(res.success).toBe(false);
    expect(res.rateLimited).toBe(true);
    expect(res.retryAfter).toBe(30);
  });

  it("propagates the provided timeoutMs to runSubprocess", async () => {
    mockFound();
    runSubprocessMock.mockResolvedValue(ok({ stdout: "ok" }));

    const d = new OpenCodeDispatcher();
    await d.dispatch("hi", [], "/tmp/work", { timeoutMs: 12_345 });

    const { opts } = captureSubprocessCall(0);
    expect(opts?.timeoutMs).toBe(12_345);
  });
});
