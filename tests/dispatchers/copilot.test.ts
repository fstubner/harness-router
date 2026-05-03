/**
 * CopilotDispatcher unit tests.
 *
 * Same test pattern as the other CLI dispatchers: stub `runSubprocess` (which
 * `streamSubprocess` delegates to under test conditions) plus `which`, then
 * assert on the exact argv we send and the parsed `DispatchResult`.
 *
 * Specific concerns covered:
 *   - argv shape: -p prompt, --allow-all-tools, --no-color,
 *     --output-format json, --silent, --add-dir cwd, -m model
 *   - JSONL agent.message extraction
 *   - Policy denial (Access denied by policy settings) → clear CTA
 *   - Rate-limit detection on usage-limit / quota signals
 *   - Tool-use + thinking events emitted live
 *   - Bare command name (no resolved path) per the safe-spawn contract
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  RunSubprocessOpts,
  SubprocessResult,
} from "../../src/dispatchers/shared/subprocess.js";

vi.mock("../../src/dispatchers/shared/subprocess.js", () => ({
  runSubprocess: vi.fn(),
}));
vi.mock("which", () => ({ default: vi.fn() }));

const { runSubprocess } = await import("../../src/dispatchers/shared/subprocess.js");
const { default: which } = await import("which");
const { CopilotDispatcher } = await import("../../src/dispatchers/copilot.js");

const runMock = runSubprocess as unknown as ReturnType<typeof vi.fn>;
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

function captureCall(idx: number): {
  command: string;
  args: string[];
  opts: RunSubprocessOpts | undefined;
} {
  const call = runMock.mock.calls[idx];
  if (!call) throw new Error(`runSubprocess call #${idx} not recorded`);
  return {
    command: call[0] as string,
    args: call[1] as string[],
    opts: call[2] as RunSubprocessOpts | undefined,
  };
}

const savedEnv = { ...process.env };
beforeEach(() => {
  runMock.mockReset();
  whichMock.mockReset();
  whichMock.mockResolvedValue("/usr/local/bin/copilot");
});
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
  for (const [k, v] of Object.entries(savedEnv)) process.env[k] = v;
});

describe("CopilotDispatcher", () => {
  it("returns a clear error DispatchResult when the CLI is not on PATH", async () => {
    whichMock.mockResolvedValue(null);
    const d = new CopilotDispatcher();
    const res = await d.dispatch("hi", [], "");
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/copilot CLI not found.*npm install -g @github\/copilot/);
    expect(runMock).not.toHaveBeenCalled();
  });

  it("dispatches with the documented argv: -p prompt, --allow-all-tools, --no-color, --output-format json, --silent", async () => {
    runMock.mockResolvedValue(
      ok({
        stdout: JSON.stringify({ type: "agent.message", text: "ok" }),
      }),
    );

    const d = new CopilotDispatcher();
    await d.dispatch("say ok", [], "");

    const { command, args } = captureCall(0);
    // Bare command name — safeSpawn handles which() + Windows .cmd quoting
    // inside streamSubprocess.
    expect(command).toBe("copilot");
    expect(args[0]).toBe("-p");
    expect(args[1]).toBe("say ok");
    expect(args).toContain("--allow-all-tools");
    expect(args).toContain("--no-color");
    expect(args).toContain("--output-format");
    const idx = args.indexOf("--output-format");
    expect(args[idx + 1]).toBe("json");
    expect(args).toContain("--silent");
  });

  it("appends --add-dir <workingDir> when workingDir is non-empty", async () => {
    runMock.mockResolvedValue(
      ok({ stdout: JSON.stringify({ type: "agent.message", text: "ok" }) }),
    );
    const d = new CopilotDispatcher();
    await d.dispatch("hi", [], "/tmp/work");
    const { args, opts } = captureCall(0);
    expect(args).toContain("--add-dir");
    const idx = args.indexOf("--add-dir");
    expect(args[idx + 1]).toBe("/tmp/work");
    // Subprocess cwd is also set so the child runs from the workspace.
    expect(opts?.cwd).toBe("/tmp/work");
  });

  it("does NOT append --add-dir when workingDir is empty", async () => {
    runMock.mockResolvedValue(
      ok({ stdout: JSON.stringify({ type: "agent.message", text: "ok" }) }),
    );
    const d = new CopilotDispatcher();
    await d.dispatch("hi", [], "");
    const { args, opts } = captureCall(0);
    expect(args).not.toContain("--add-dir");
    expect(opts?.cwd).toBeUndefined();
  });

  it("forwards --model when modelOverride is set (`-m` is the short flag copilot uses)", async () => {
    runMock.mockResolvedValue(
      ok({ stdout: JSON.stringify({ type: "agent.message", text: "ok" }) }),
    );
    const d = new CopilotDispatcher();
    await d.dispatch("hi", [], "", { modelOverride: "gpt-5" });
    const { args } = captureCall(0);
    expect(args).toContain("-m");
    const idx = args.indexOf("-m");
    expect(args[idx + 1]).toBe("gpt-5");
  });

  it("extracts the last agent.message text from JSONL output", async () => {
    runMock.mockResolvedValue(
      ok({
        stdout: [
          JSON.stringify({ type: "session.started" }),
          JSON.stringify({ type: "agent.message", text: "first chunk" }),
          JSON.stringify({ type: "agent.message", text: "final answer" }),
        ].join("\n"),
      }),
    );
    const d = new CopilotDispatcher();
    const res = await d.dispatch("hi", [], "");
    expect(res.success).toBe(true);
    expect(res.output).toBe("final answer");
  });

  it("surfaces policy denial with a hand-tuned CTA pointing at github.com/settings/copilot", async () => {
    // Real-world failure mode: user is authed (gh auth login OK) but their
    // org / subscription doesn't include CLI access. The error often arrives
    // on stderr as plain text, NOT in the JSONL stream — copilot's policy
    // path bypasses the JSON formatter.
    runMock.mockResolvedValue(
      ok({
        stdout: "",
        stderr:
          "Error: Access denied by policy settings (Request ID: ABCD:1234)\n" +
          "Your Copilot CLI policy setting may be preventing access.\n",
        // copilot still exits 0 even on denial sometimes — exercise that.
        exitCode: 0,
      }),
    );
    const d = new CopilotDispatcher();
    const res = await d.dispatch("hi", [], "");
    expect(res.success).toBe(false);
    // Hand-tuned message: explicit URL, explicit "this is NOT auth" framing.
    expect(res.error).toMatch(/policy denied/i);
    expect(res.error).toContain("github.com/settings/copilot");
    expect(res.error).toMatch(/NOT an auth issue/);
  });

  it("flags rate-limit signals (usage limit / 429 / retry-after) on the failure path", async () => {
    runMock.mockResolvedValue(
      ok({
        exitCode: 1,
        stderr: "Error: 429 too many requests. retry-after: 60",
      }),
    );
    const d = new CopilotDispatcher();
    const res = await d.dispatch("hi", [], "");
    expect(res.success).toBe(false);
    expect(res.rateLimited).toBe(true);
    expect(res.retryAfter).toBe(60);
  });

  it("emits live tool_use events from JSONL", async () => {
    runMock.mockResolvedValue(
      ok({
        stdout: [
          JSON.stringify({ type: "agent.tool_use", name: "read_file", input: { path: "x" } }),
          JSON.stringify({ type: "agent.message", text: "done" }),
        ].join("\n"),
      }),
    );
    const d = new CopilotDispatcher();
    const events: Array<{ type: string; name?: string }> = [];
    for await (const evt of d.stream("hi", [], "")) {
      events.push(evt as { type: string; name?: string });
    }
    const toolUses = events.filter((e) => e.type === "tool_use");
    expect(toolUses).toHaveLength(1);
    expect(toolUses[0]!.name).toBe("read_file");
  });

  it("propagates the provided timeoutMs to runSubprocess", async () => {
    runMock.mockResolvedValue(
      ok({ stdout: JSON.stringify({ type: "agent.message", text: "ok" }) }),
    );
    const d = new CopilotDispatcher();
    await d.dispatch("hi", [], "", { timeoutMs: 7777 });
    const { opts } = captureCall(0);
    expect(opts?.timeoutMs).toBe(7777);
  });

  it("has a stable id and reports itself as available", () => {
    const d = new CopilotDispatcher();
    expect(d.id).toBe("copilot");
    expect(d.isAvailable()).toBe(true);
  });
});
