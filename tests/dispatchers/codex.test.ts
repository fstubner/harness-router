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
const { CodexDispatcher } = await import("../../src/dispatchers/codex.js");

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

/** Typed accessor for the positional `runSubprocess(command, args, opts?)` call. */
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

function mockFound(commandPath = "/usr/local/bin/codex"): void {
  whichMock.mockResolvedValue(commandPath);
}

const savedEnv = { ...process.env };

beforeEach(() => {
  runSubprocessMock.mockReset();
  whichMock.mockReset();
});

afterEach(() => {
  // Restore env to avoid bleed across tests.
  for (const k of Object.keys(process.env)) {
    if (!(k in savedEnv)) delete process.env[k];
  }
  for (const [k, v] of Object.entries(savedEnv)) {
    process.env[k] = v;
  }
});

describe("CodexDispatcher", () => {
  it("returns an error DispatchResult when the CLI is not found", async () => {
    whichMock.mockResolvedValue(null);
    const d = new CodexDispatcher();

    const res = await d.dispatch("hi", [], "");

    expect(res.success).toBe(false);
    expect(res.service).toBe("codex");
    expect(res.error).toMatch(/codex CLI not found/i);
    expect(runSubprocessMock).not.toHaveBeenCalled();
  });

  it("passes the bare command name (`codex`) to runSubprocess", async () => {
    mockFound();
    runSubprocessMock.mockResolvedValue(ok({ stdout: "ok" }));

    const d = new CodexDispatcher();
    await d.dispatch("hi", [], "");

    const { command } = captureSubprocessCall(0);
    // Bare-name contract: safeSpawn (inside streamSubprocess) handles which()
    // resolution and Windows .cmd quoting. Dispatchers must NOT pre-resolve.
    expect(command).toBe("codex");
  });

  it("includes --skip-git-repo-check so codex 0.125+ runs in non-git cwds", async () => {
    mockFound();
    runSubprocessMock.mockResolvedValue(ok({ stdout: "ok" }));

    const d = new CodexDispatcher();
    await d.dispatch("hi", [], "");

    const { args } = captureSubprocessCall(0);
    // Locks the flag in: without it, codex 0.125+ would refuse to run in any
    // workingDir that isn't a trusted git repo (onboarding probes, scratch
    // dirs, /tmp, etc.) — there's no terminal to accept the prompt headlessly.
    expect(args).toContain("--skip-git-repo-check");
    expect(args).toContain("--full-auto");
    expect(args).toContain("--json");
  });

  it("flags rate-limit signals in stderr and lifts retry-after onto the result", async () => {
    mockFound();
    runSubprocessMock.mockResolvedValue(
      ok({
        exitCode: 1,
        stderr: "Error: rate limit exceeded for 5h window. retry-after: 90",
      }),
    );

    const d = new CodexDispatcher();
    const res = await d.dispatch("hi", [], "");

    // The router's breaker reads `rateLimited` + `retryAfter` to honour the
    // backoff; without this lift, codex failures looked like generic
    // exit-code errors and the breaker treated them as opaque.
    expect(res.success).toBe(false);
    expect(res.rateLimited).toBe(true);
    expect(res.retryAfter).toBe(90);
  });

  it("extracts the last agent_message item from JSONL output", async () => {
    mockFound();
    const jsonl = [
      JSON.stringify({ type: "thread.started" }),
      JSON.stringify({
        type: "item.completed",
        item: { id: "1", type: "agent_message", text: "first" },
        usage: { input_tokens: 4, output_tokens: 5 },
      }),
      JSON.stringify({
        type: "item.completed",
        item: { id: "2", type: "agent_message", text: "final answer" },
        usage: { input_tokens: 2, output_tokens: 3 },
      }),
    ].join("\n");
    runSubprocessMock.mockResolvedValue(ok({ stdout: jsonl }));

    const d = new CodexDispatcher();
    const res = await d.dispatch("write code", [], "");

    expect(res.success).toBe(true);
    expect(res.service).toBe("codex");
    expect(res.output).toBe("final answer");
    // Usage is summed across events.
    expect(res.tokensUsed).toEqual({ input: 6, output: 8 });
  });

  it("appends --cd <workingDir> when workingDir is non-empty", async () => {
    mockFound();
    runSubprocessMock.mockResolvedValue(
      ok({
        stdout: JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: "ok" },
        }),
      }),
    );

    const d = new CodexDispatcher();
    await d.dispatch("go", [], "/tmp/project");

    const { args } = captureSubprocessCall(0);
    expect(args).toContain("--cd");
    const idx = args.indexOf("--cd");
    expect(args[idx + 1]).toBe("/tmp/project");
  });

  it("does NOT append --cd when workingDir is empty", async () => {
    mockFound();
    runSubprocessMock.mockResolvedValue(
      ok({
        stdout: JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: "ok" },
        }),
      }),
    );

    const d = new CodexDispatcher();
    await d.dispatch("go", [], "");

    const { args } = captureSubprocessCall(0);
    expect(args).not.toContain("--cd");
  });

  it("forwards OPENAI_API_KEY from process.env to the subprocess", async () => {
    process.env["OPENAI_API_KEY"] = "sk-test-12345";
    mockFound();
    runSubprocessMock.mockResolvedValue(
      ok({
        stdout: JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: "ok" },
        }),
      }),
    );

    const d = new CodexDispatcher();
    await d.dispatch("go", [], "");

    const { opts } = captureSubprocessCall(0);
    expect(opts?.env).toBeDefined();
    expect(opts?.env?.["OPENAI_API_KEY"]).toBe("sk-test-12345");
  });

  it("does NOT forward OPENAI_API_KEY when the env var is unset", async () => {
    delete process.env["OPENAI_API_KEY"];
    mockFound();
    runSubprocessMock.mockResolvedValue(
      ok({
        stdout: JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: "ok" },
        }),
      }),
    );

    const d = new CodexDispatcher();
    await d.dispatch("go", [], "");

    const { opts } = captureSubprocessCall(0);
    // env should either be undefined or not contain the key.
    if (opts?.env) {
      expect(opts.env["OPENAI_API_KEY"]).toBeUndefined();
    }
  });

  it("passes --model <override> through to the subprocess", async () => {
    mockFound();
    runSubprocessMock.mockResolvedValue(
      ok({
        stdout: JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: "ok" },
        }),
      }),
    );

    const d = new CodexDispatcher();
    await d.dispatch("go", [], "", { modelOverride: "o4-mini" });

    const { args } = captureSubprocessCall(0);
    expect(args).toContain("--model");
    const idx = args.indexOf("--model");
    expect(args[idx + 1]).toBe("o4-mini");
  });

  it("reports failure on a non-zero exit code", async () => {
    mockFound();
    runSubprocessMock.mockResolvedValue(ok({ stdout: "", stderr: "something broke", exitCode: 2 }));

    const d = new CodexDispatcher();
    const res = await d.dispatch("go", [], "");

    expect(res.success).toBe(false);
    expect(res.error).toBe("something broke");
  });

  it('surfaces JSONL `{type:"error"}` events as the error and flags rate-limit (regression: usage-limit was buried in stderr noise)', async () => {
    // This is the real-world failure mode the codex dispatcher missed
    // until 0.1.0. Codex emits an `error` JSONL event on stdout AND exits
    // 0; we must:
    //   1. Treat the dispatch as failure (success: false)
    //   2. Surface the human-readable message as `error`
    //   3. Run rate-limit detection on the message (not just stderr,
    //      which contains unrelated transport noise)
    mockFound();
    const stdout = [
      JSON.stringify({ type: "thread.started", thread_id: "abc" }),
      JSON.stringify({ type: "turn.started" }),
      JSON.stringify({
        type: "error",
        message:
          "You've hit your usage limit. Upgrade to Pro or try again at May 5th, 2026 11:45 AM.",
      }),
      JSON.stringify({
        type: "turn.failed",
        error: { message: "You've hit your usage limit." },
      }),
      "",
    ].join("\n");
    // Stderr has unrelated noise — codex's internal GitHub-MCP transport
    // failing because of stale tokens for an MCP server configured INSIDE
    // codex. This is NOT what we want to surface as the error.
    const stderr =
      "Reading additional input from stdin...\n" +
      "ERROR rmcp::transport::worker: worker quit with fatal: Transport channel closed, when AuthRequired(...)\n";
    runSubprocessMock.mockResolvedValue(
      ok({ stdout, stderr, exitCode: 0 }), // codex exits 0 even on usage-limit
    );

    const d = new CodexDispatcher();
    const res = await d.dispatch("go", [], "");

    expect(res.success).toBe(false);
    expect(res.error).toBe("You've hit your usage limit.");
    // Output preferred fallback is the error message (since no agent_message
    // arrived before the failure).
    expect(res.output).toBe("You've hit your usage limit.");
    // The rate-limit detector should fire on "usage limit" in the error
    // message — this is what trips the router's circuit breaker.
    expect(res.rateLimited).toBe(true);
    // Should NOT include the unrelated GitHub-MCP transport spam.
    expect(res.error).not.toContain("rmcp::transport::worker");
    expect(res.error).not.toContain("AuthRequired");
  });

  it("reports 'unknown' quota in R1", async () => {
    const d = new CodexDispatcher();
    const q = await d.checkQuota();
    expect(q.service).toBe("codex");
    expect(q.source).toBe("unknown");
  });

  it("has a stable id and reports itself as available", () => {
    const d = new CodexDispatcher();
    expect(d.id).toBe("codex");
    expect(d.isAvailable()).toBe(true);
  });
});
