/**
 * GenericCliDispatcher unit tests.
 *
 * Same mock pattern as the other dispatcher tests: stub `runSubprocess`
 * (which streamSubprocess delegates to under test conditions) and `which`,
 * then assert on the exact argv we send through.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type {
  RunSubprocessOpts,
  SubprocessResult,
} from "../../src/dispatchers/shared/subprocess.js";
import type { ServiceConfig } from "../../src/types.js";

vi.mock("../../src/dispatchers/shared/subprocess.js", () => ({
  runSubprocess: vi.fn(),
}));
vi.mock("which", () => ({ default: vi.fn() }));

const { runSubprocess } = await import("../../src/dispatchers/shared/subprocess.js");
const { default: which } = await import("which");
const { GenericCliDispatcher } = await import("../../src/dispatchers/generic-cli.js");

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

function svcOf(overrides: Partial<ServiceConfig> = {}): ServiceConfig {
  return {
    name: "my_cli",
    enabled: true,
    type: "generic_cli",
    harness: "my_cli",
    command: "my-cli",
    tier: 2,
    weight: 1,
    cliCapability: 1,
    escalateOn: [],
    capabilities: {},
    ...overrides,
  };
}

const savedEnv = { ...process.env };

beforeEach(() => {
  runSubprocessMock.mockReset();
  whichMock.mockReset();
  whichMock.mockResolvedValue("/usr/local/bin/my-cli");
});

afterEach(() => {
  for (const k of Object.keys(process.env)) {
    if (!(k in savedEnv)) delete process.env[k];
  }
  for (const [k, v] of Object.entries(savedEnv)) {
    process.env[k] = v;
  }
});

describe("GenericCliDispatcher", () => {
  it("returns an error DispatchResult when the CLI is not on PATH", async () => {
    whichMock.mockResolvedValue(null);
    const d = new GenericCliDispatcher(svcOf());
    const res = await d.dispatch("hi", [], "");
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/my-cli CLI not found/i);
    expect(runSubprocessMock).not.toHaveBeenCalled();
  });

  it("throws on construction when `command` is missing", () => {
    const bad = svcOf();
    delete (bad as { command?: string }).command;
    expect(() => new GenericCliDispatcher(bad)).toThrow(/missing required 'command'/);
  });

  it("dispatches `<command> <prompt>` with no recipe — minimal case", async () => {
    runSubprocessMock.mockResolvedValue(ok({ stdout: "hello back" }));
    const d = new GenericCliDispatcher(svcOf());
    const res = await d.dispatch("say hi", [], "");

    expect(res.success).toBe(true);
    expect(res.output).toBe("hello back");
    const { command, args } = captureSubprocessCall(0);
    expect(command).toBe("my-cli");
    // With no recipe at all, the only arg is the prompt itself.
    expect(args).toEqual(["say hi"]);
  });

  it("emits args in the documented order: argsBefore, model, cwd, prompt, argsAfter", async () => {
    runSubprocessMock.mockResolvedValue(ok({ stdout: "ok" }));
    const d = new GenericCliDispatcher(
      svcOf({
        model: "gpt-test",
        genericCli: {
          argsBeforePrompt: ["run", "--no-color"],
          argsAfterPrompt: ["--verbose"],
          modelFlag: "--model",
          cwdFlag: "--workdir",
        },
      }),
    );
    await d.dispatch("do thing", [], "/tmp/work");
    const { args } = captureSubprocessCall(0);
    expect(args).toEqual([
      "run",
      "--no-color",
      "--model",
      "gpt-test",
      "--workdir",
      "/tmp/work",
      "do thing",
      "--verbose",
    ]);
  });

  it("modelOverride wins over the configured model", async () => {
    runSubprocessMock.mockResolvedValue(ok({ stdout: "ok" }));
    const d = new GenericCliDispatcher(
      svcOf({ model: "default-model", genericCli: { modelFlag: "--model" } }),
    );
    await d.dispatch("hi", [], "", { modelOverride: "override-model" });
    const { args } = captureSubprocessCall(0);
    const idx = args.indexOf("--model");
    expect(args[idx + 1]).toBe("override-model");
  });

  it("omits the model flag when no model is configured AND no override given", async () => {
    runSubprocessMock.mockResolvedValue(ok({ stdout: "ok" }));
    const d = new GenericCliDispatcher(svcOf({ genericCli: { modelFlag: "--model" } }));
    await d.dispatch("hi", [], "");
    const { args } = captureSubprocessCall(0);
    expect(args).not.toContain("--model");
  });

  it("omits the cwd flag when workingDir is empty (but still respects subprocess cwd)", async () => {
    runSubprocessMock.mockResolvedValue(ok({ stdout: "ok" }));
    const d = new GenericCliDispatcher(svcOf({ genericCli: { cwdFlag: "--workdir" } }));
    await d.dispatch("hi", [], "");
    const { args, opts } = captureSubprocessCall(0);
    expect(args).not.toContain("--workdir");
    // workingDir was empty so subprocess cwd is also unset.
    expect(opts?.cwd).toBeUndefined();
  });

  it("forwards configured env vars (and only those that are actually set)", async () => {
    runSubprocessMock.mockResolvedValue(ok({ stdout: "ok" }));
    process.env["MY_CLI_API_KEY"] = "key-abc";
    // MY_CLI_CONFIG intentionally unset — should NOT appear in the env map.
    const d = new GenericCliDispatcher(
      svcOf({ genericCli: { forwardEnv: ["MY_CLI_API_KEY", "MY_CLI_CONFIG"] } }),
    );
    await d.dispatch("hi", [], "");
    const { opts } = captureSubprocessCall(0);
    expect(opts?.env?.MY_CLI_API_KEY).toBe("key-abc");
    expect(opts?.env?.MY_CLI_CONFIG).toBeUndefined();
  });

  it("appends a 'Files to work with' block to the prompt when files are supplied", async () => {
    runSubprocessMock.mockResolvedValue(ok({ stdout: "ok" }));
    const d = new GenericCliDispatcher(svcOf());
    await d.dispatch("refactor", ["src/a.ts", "src/b.ts"], "");
    const { args } = captureSubprocessCall(0);
    // The prompt is the only positional in the minimal recipe. Files are
    // appended to its text.
    const prompt = args[0]!;
    expect(prompt).toContain("refactor");
    expect(prompt).toContain("Files to work with:");
    expect(prompt).toContain("src/a.ts");
    expect(prompt).toContain("src/b.ts");
  });

  it("extracts response text via outputJsonPath when set", async () => {
    runSubprocessMock.mockResolvedValue(
      ok({
        stdout: JSON.stringify({
          result: "the answer",
          usage: { input: 11, output: 13 },
        }),
      }),
    );
    const d = new GenericCliDispatcher(
      svcOf({
        genericCli: {
          outputJsonPath: "result",
          tokensJsonPath: "usage",
        },
      }),
    );
    const res = await d.dispatch("hi", [], "");
    expect(res.success).toBe(true);
    expect(res.output).toBe("the answer");
    expect(res.tokensUsed).toEqual({ input: 11, output: 13 });
  });

  it("supports nested JSON paths for the response text", async () => {
    runSubprocessMock.mockResolvedValue(
      ok({
        stdout: JSON.stringify({
          choices: [{ message: { content: "deep answer" } }],
        }),
      }),
    );
    const d = new GenericCliDispatcher(
      svcOf({ genericCli: { outputJsonPath: "choices.0.message.content" } }),
    );
    const res = await d.dispatch("hi", [], "");
    expect(res.output).toBe("deep answer");
  });

  it("falls back to plain stdout when the JSON path is configured but parse fails", async () => {
    runSubprocessMock.mockResolvedValue(ok({ stdout: "not even json" }));
    const d = new GenericCliDispatcher(svcOf({ genericCli: { outputJsonPath: "result" } }));
    const res = await d.dispatch("hi", [], "");
    // A misconfigured path shouldn't break the dispatch — surface the raw
    // stdout so the caller has at least something useful to show.
    expect(res.output).toBe("not even json");
    expect(res.success).toBe(true);
  });

  it("flags rate-limit signals on the failure path", async () => {
    runSubprocessMock.mockResolvedValue(
      ok({
        exitCode: 1,
        stderr: "Error: 429 too many requests. retry-after: 45",
      }),
    );
    const d = new GenericCliDispatcher(svcOf());
    const res = await d.dispatch("hi", [], "");
    expect(res.success).toBe(false);
    expect(res.rateLimited).toBe(true);
    expect(res.retryAfter).toBe(45);
  });

  it("propagates the provided timeoutMs to runSubprocess", async () => {
    runSubprocessMock.mockResolvedValue(ok({ stdout: "ok" }));
    const d = new GenericCliDispatcher(svcOf());
    await d.dispatch("hi", [], "", { timeoutMs: 7777 });
    const { opts } = captureSubprocessCall(0);
    expect(opts?.timeoutMs).toBe(7777);
  });

  it("sets the dispatcher id from svc.name (used by code_with_<harness> routing)", () => {
    const d = new GenericCliDispatcher(svcOf({ name: "totally_custom" }));
    expect(d.id).toBe("totally_custom");
  });

  // Prompt delivery modes (positional vs flag vs stdin).

  it("prompt_delivery: 'flag' uses [promptFlag, <text>] AFTER model/cwd flags", async () => {
    // Regression for the audit gap: with model_flag set and prompt-as-flag,
    // the previous schema produced argv like `[--prompt, --model, gpt, hi]`
    // — the CLI saw `--prompt` taking value `--model` and lost the prompt.
    // The new flag-delivery mode emits the promptFlag pair AFTER model/cwd
    // so the order is `[run, --model, gpt, --workdir, /tmp, --prompt, hi]`.
    runSubprocessMock.mockResolvedValue(ok({ stdout: "ok" }));
    const d = new GenericCliDispatcher(
      svcOf({
        model: "gpt-test",
        genericCli: {
          argsBeforePrompt: ["run"],
          modelFlag: "--model",
          cwdFlag: "--workdir",
          promptDelivery: "flag",
          promptFlag: "--prompt",
        },
      }),
    );
    await d.dispatch("hello world", [], "/tmp/work");
    const { args } = captureSubprocessCall(0);
    expect(args).toEqual([
      "run",
      "--model",
      "gpt-test",
      "--workdir",
      "/tmp/work",
      "--prompt",
      "hello world",
    ]);
  });

  it("prompt_delivery: 'flag' without prompt_flag yields a clear error (no broken argv)", async () => {
    const d = new GenericCliDispatcher(svcOf({ genericCli: { promptDelivery: "flag" } }));
    const res = await d.dispatch("hi", [], "");
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/missing promptFlag/i);
    expect(runSubprocessMock).not.toHaveBeenCalled();
  });

  it("prompt_delivery: 'stdin' writes prompt to child stdin and omits the positional", async () => {
    runSubprocessMock.mockResolvedValue(ok({ stdout: "ok" }));
    const d = new GenericCliDispatcher(
      svcOf({
        genericCli: {
          argsBeforePrompt: ["run", "--input", "-"],
          promptDelivery: "stdin",
        },
      }),
    );
    await d.dispatch("piped prompt", [], "");
    const { args, opts } = captureSubprocessCall(0);
    // Prompt is NOT in argv.
    expect(args).toEqual(["run", "--input", "-"]);
    // It went to stdinInput instead.
    expect(opts?.stdinInput).toBe("piped prompt");
  });

  it("prompt_delivery: 'stdin' still appends the files block to the piped text", async () => {
    runSubprocessMock.mockResolvedValue(ok({ stdout: "ok" }));
    const d = new GenericCliDispatcher(svcOf({ genericCli: { promptDelivery: "stdin" } }));
    await d.dispatch("refactor", ["src/a.ts"], "");
    const { opts } = captureSubprocessCall(0);
    expect(opts?.stdinInput).toContain("refactor");
    expect(opts?.stdinInput).toContain("Files to work with:");
    expect(opts?.stdinInput).toContain("src/a.ts");
  });

  it("default prompt_delivery is positional (back-compat with the original schema)", async () => {
    runSubprocessMock.mockResolvedValue(ok({ stdout: "ok" }));
    const d = new GenericCliDispatcher(svcOf({ genericCli: { argsBeforePrompt: ["run"] } }));
    await d.dispatch("hi", [], "");
    const { args, opts } = captureSubprocessCall(0);
    expect(args).toEqual(["run", "hi"]);
    expect(opts?.stdinInput).toBeUndefined();
  });

  // Per-file argv expansion (args_per_file).

  it("expands args_per_file once per input file with {path} substitution", async () => {
    runSubprocessMock.mockResolvedValue(ok({ stdout: "ok" }));
    const d = new GenericCliDispatcher(
      svcOf({
        genericCli: {
          argsBeforePrompt: ["run"],
          argsPerFile: ["--file", "{path}"],
        },
      }),
    );
    await d.dispatch("refactor", ["src/a.ts", "src/b.ts"], "");
    const { args } = captureSubprocessCall(0);
    expect(args).toEqual(["run", "--file", "src/a.ts", "--file", "src/b.ts", "refactor"]);
  });

  it("argsPerFile suppresses the `Files to work with:` block (files travel via argv)", async () => {
    runSubprocessMock.mockResolvedValue(ok({ stdout: "ok" }));
    const d = new GenericCliDispatcher(
      svcOf({ genericCli: { argsPerFile: ["--file", "{path}"] } }),
    );
    await d.dispatch("refactor", ["src/a.ts"], "");
    const { args } = captureSubprocessCall(0);
    // The prompt is the LAST positional. It must NOT contain the file-list
    // block since the files were emitted as argv pairs.
    const prompt = args[args.length - 1]!;
    expect(prompt).toBe("refactor");
    expect(prompt).not.toContain("Files to work with");
  });

  it("argsPerFile passes through entries without {path} verbatim per iteration", async () => {
    // Some CLIs use a separator like `--input` followed by `<path>` followed
    // by `--end-input`. The verbatim entries support that idiom.
    runSubprocessMock.mockResolvedValue(ok({ stdout: "ok" }));
    const d = new GenericCliDispatcher(
      svcOf({
        genericCli: {
          argsPerFile: ["--input", "{path}", "--end-input"],
        },
      }),
    );
    await d.dispatch("refactor", ["a.ts", "b.ts"], "");
    const { args } = captureSubprocessCall(0);
    expect(args.slice(0, -1)).toEqual([
      "--input",
      "a.ts",
      "--end-input",
      "--input",
      "b.ts",
      "--end-input",
    ]);
  });

  it("argsPerFile with no files falls through to the default file-list-in-prompt path (which also no-ops)", async () => {
    runSubprocessMock.mockResolvedValue(ok({ stdout: "ok" }));
    const d = new GenericCliDispatcher(
      svcOf({ genericCli: { argsPerFile: ["--file", "{path}"] } }),
    );
    await d.dispatch("hi", [], "");
    const { args } = captureSubprocessCall(0);
    // No files supplied → no per-file expansion, no files block.
    expect(args).toEqual(["hi"]);
  });

  // JSONL streaming output mode.

  it("output_jsonl: emits live tool_use + thinking events and concatenates text deltas", async () => {
    // Three JSONL frames: a tool_use, a thinking chunk, two text deltas.
    // We mock runSubprocess so the whole stream comes back in one stdout
    // chunk; the dispatcher's line splitter still produces the same events.
    const stream = [
      JSON.stringify({ type: "tool_use", item: { name: "read_file" }, args: { path: "x.ts" } }),
      JSON.stringify({ type: "thinking", reflection: "let me think" }),
      JSON.stringify({ delta: { content: "Hello " } }),
      JSON.stringify({ delta: { content: "world", usage: { input: 7, output: 3 } } }),
      "",
    ].join("\n");
    runSubprocessMock.mockResolvedValue(ok({ stdout: stream }));

    const d = new GenericCliDispatcher(
      svcOf({
        genericCli: {
          outputJsonl: {
            textDeltaPath: "delta.content",
            toolNamePath: "item.name",
            toolInputPath: "args",
            thinkingPath: "reflection",
            tokensPath: "delta.usage",
          },
        },
      }),
    );

    const events: Array<{ type: string; chunk?: string; name?: string; output?: string }> = [];
    let final: { output?: string; tokensUsed?: { input: number; output: number } } | undefined;
    for await (const evt of d.stream("hi", [], "")) {
      if (evt.type === "completion") {
        final = evt.result;
      } else {
        events.push(evt as { type: string; chunk?: string; name?: string });
      }
    }

    // Live events: tool_use, thinking, two stdout deltas.
    expect(events.map((e) => e.type)).toEqual(["tool_use", "thinking", "stdout", "stdout"]);
    expect(events.find((e) => e.type === "tool_use")?.name).toBe("read_file");
    // Final completion concatenates the deltas and lifts the usage.
    expect(final?.output).toBe("Hello world");
    expect(final?.tokensUsed).toEqual({ input: 7, output: 3 });
  });

  it("output_jsonl: silently skips lines that aren't valid JSON (informational chatter)", async () => {
    // Some CLIs interleave plain log lines with the JSONL stream. We must
    // not abort the dispatch on those — just skip the line.
    const stream = [
      "Starting agent...", // plain text — skipped
      JSON.stringify({ delta: { content: "answer" } }),
      "",
    ].join("\n");
    runSubprocessMock.mockResolvedValue(ok({ stdout: stream }));

    const d = new GenericCliDispatcher(
      svcOf({ genericCli: { outputJsonl: { textDeltaPath: "delta.content" } } }),
    );
    const out: string[] = [];
    let final: { output?: string } | undefined;
    for await (const evt of d.stream("hi", [], "")) {
      if (evt.type === "stdout") out.push(evt.chunk);
      if (evt.type === "completion") final = evt.result;
    }
    expect(out).toEqual(["answer"]);
    expect(final?.output).toBe("answer");
  });

  it("zero-exit + empty stdout is now SUCCESS (audit pass A: BUG-A6)", async () => {
    // The dispatcher previously required textOutput.length > 0 alongside
    // exitCode === 0 to declare success. Some CLIs (formatters, linters,
    // side-effect tools) intentionally write nothing on success. The fix
    // treats any zero exit as success regardless of stdout content.
    runSubprocessMock.mockResolvedValue(ok({ stdout: "", stderr: "", exitCode: 0 }));
    const d = new GenericCliDispatcher(svcOf());
    const res = await d.dispatch("apply formatter", [], "");
    expect(res.success).toBe(true);
    expect(res.output).toBe("");
  });
});
