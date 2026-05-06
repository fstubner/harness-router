/**
 * OpenCode CLI dispatcher for harness-router.
 *
 * Dispatch:  opencode run "<prompt>" [--model <model>] [--cwd <dir>]
 *
 *   `opencode run` is the non-interactive subcommand — accepts a positional
 *   prompt and prints the agent's response to stdout, then exits. The TUI
 *   (`opencode` with no args) is not used by the router.
 *
 * Auth: OpenCode is provider-agnostic and supports multiple subscriptions in
 *   one install — `opencode auth login <provider>` for Anthropic (Claude
 *   Pro/Max OAuth), OpenAI (ChatGPT subscription), Google, and others, plus
 *   API-key configuration for any provider. We forward common provider env
 *   vars (ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, OPENROUTER_API_KEY)
 *   so a config that points at a paid API works without editing OpenCode's
 *   own auth state.
 *
 * Quota: reactive only — no per-provider quota endpoint we can poll
 *   uniformly. Circuit breaker handles repeated failures.
 *
 * Output format: OpenCode's `run` subcommand writes the agent's text response
 *   directly to stdout as plain text (no JSON envelope). We treat the entire
 *   stdout as the dispatch output and rely on stderr for diagnostics. If a
 *   future OpenCode version adds a `--format json` flag, parse it here in
 *   preference to the plain stdout.
 */

import which from "which";
import type { DispatchResult, DispatcherEvent, QuotaInfo, ServiceConfig } from "../types.js";
import { BaseDispatcher, type DispatchOpts, type DispatcherInitOpts } from "./base.js";
import { detectRateLimitInText } from "./shared/rate-limit-text.js";
import { streamSubprocess } from "./shared/stream-subprocess.js";

const DEFAULT_TIMEOUT_MS = 600_000; // 10 minutes

/** Provider env vars OpenCode commonly reads. Forward any that are set. */
const FORWARDABLE_ENV: readonly string[] = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "OPENROUTER_API_KEY",
  "GROQ_API_KEY",
  "OPENCODE_CONFIG", // override config.json path
];

export class OpenCodeDispatcher extends BaseDispatcher {
  readonly id = "opencode";
  private readonly configuredModel: string | undefined;
  private readonly available: boolean;

  constructor(svc?: ServiceConfig, opts: DispatcherInitOpts = {}) {
    super();
    this.configuredModel = svc?.model;
    this.available = opts.cliPath !== null;
  }

  isAvailable(): boolean {
    return this.available;
  }

  async checkQuota(): Promise<QuotaInfo> {
    return { service: "opencode", source: "unknown" };
  }

  stream(
    prompt: string,
    files: string[],
    workingDir: string,
    opts: DispatchOpts = {},
  ): AsyncIterable<DispatcherEvent> {
    return this.#runStream(prompt, files, workingDir, opts);
  }

  async *#runStream(
    prompt: string,
    files: string[],
    workingDir: string,
    opts: DispatchOpts,
  ): AsyncGenerator<DispatcherEvent> {
    const foundPath = await which("opencode", { nothrow: true });
    if (!foundPath) {
      yield {
        type: "completion",
        result: {
          output: "",
          service: "opencode",
          success: false,
          error: "opencode CLI not found — install via https://opencode.ai or npm i -g opencode-ai",
        },
      };
      return;
    }

    let fullPrompt = prompt;
    if (files.length > 0) {
      const fileList = files.map((p) => `  - ${p}`).join("\n");
      fullPrompt = `${prompt}\n\nFocus on these files:\n${fileList}`;
    }

    const effectiveModel = opts.modelOverride ?? this.configuredModel;

    // `opencode run [message..]` — the prompt is the trailing positional.
    // The subcommand has no `--cwd` flag (verified against opencode 1.14.x);
    // we set the subprocess cwd via `subOpts.cwd` below, which is the
    // canonical way and matches every other dispatcher in this codebase.
    // A previous version of this dispatcher passed `--cwd <path>`; that
    // worked against older opencode releases but the current CLI rejects
    // it as an unknown option and prints the usage banner instead of
    // running. Removing the flag is the fix.
    const args: string[] = ["run"];
    if (effectiveModel) {
      args.push("--model", effectiveModel);
    }
    args.push(fullPrompt);

    const extraEnv: Record<string, string> = {};
    for (const key of FORWARDABLE_ENV) {
      const v = process.env[key];
      if (v) extraEnv[key] = v;
    }

    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const subOpts: Parameters<typeof streamSubprocess>[2] = { timeoutMs };
    if (workingDir) subOpts.cwd = workingDir;
    if (Object.keys(extraEnv).length > 0) subOpts.env = extraEnv;

    const stdoutBuf: string[] = [];
    const stderrBuf: string[] = [];
    let exitCode = -1;
    let durationMs = 0;
    let timedOut = false;

    for await (const evt of streamSubprocess("opencode", args, subOpts)) {
      if ("stream" in evt) {
        if (evt.stream === "stdout") {
          stdoutBuf.push(evt.chunk);
          yield { type: "stdout", chunk: evt.chunk };
        } else {
          stderrBuf.push(evt.chunk);
          yield { type: "stderr", chunk: evt.chunk };
        }
      } else {
        exitCode = evt.exitCode;
        durationMs = evt.durationMs;
        timedOut = evt.timedOut;
      }
    }

    const stdout = stdoutBuf.join("");
    const stderr = stderrBuf.join("");

    if (timedOut) {
      yield {
        type: "completion",
        result: {
          output: stdout,
          service: "opencode",
          success: false,
          error: `Timed out after ${timeoutMs}ms`,
          durationMs,
        },
      };
      return;
    }

    const trimmedOut = stdout.trim();
    const trimmedErr = stderr.trim();

    if (exitCode === 0 && trimmedOut.length > 0) {
      yield {
        type: "completion",
        result: {
          output: trimmedOut,
          service: "opencode",
          success: true,
          durationMs,
        },
      };
      return;
    }

    // Error path — surface the actionable bit. Auth-shaped errors are common
    // for fresh installs; the onboarding flow will recognise them and
    // suggest `opencode auth login`.
    const errorDetail = trimmedErr || trimmedOut || `Exit code ${exitCode}`;
    const { rateLimited, retryAfter } = detectRateLimitInText(`${stdout}\n${stderr}`);
    const result: DispatchResult = {
      output: trimmedOut,
      service: "opencode",
      success: false,
      error: errorDetail,
      durationMs,
    };
    if (rateLimited) {
      result.rateLimited = true;
      if (retryAfter !== null) result.retryAfter = retryAfter;
    }
    yield { type: "completion", result };
  }
}
