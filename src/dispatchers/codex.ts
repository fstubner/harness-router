/**
 * OpenAI Codex CLI dispatcher for harness-router.
 *
 * Dispatch:  codex exec "<prompt>" --full-auto --json --skip-git-repo-check
 *                  [--model <m>] [--cd <dir>]
 *   codex exec:               non-interactive mode.
 *   --full-auto:              bypass per-action approval prompts.
 *   --json:                   newline-delimited JSON events for structured parsing.
 *   --skip-git-repo-check:    skip codex 0.125+'s session-level trusted-directory
 *                             prompt. Required because the router invokes codex
 *                             headlessly from arbitrary cwds (onboarding probes,
 *                             non-repo workspaces) — there is no terminal to
 *                             accept the prompt on. The user has already opted
 *                             into delegated execution by configuring the router,
 *                             which mirrors the implicit trust granted to the
 *                             other harnesses (claude_code/cursor/gemini).
 *
 * Quota: Reactive only. Codex uses token-based pricing (no hard monthly limit);
 * circuit breaker handles exhaustion from 429 responses.
 *
 * R3: emits JSONL events as they're parsed — `tool_use` and `thinking`
 * events surface mid-run, `completion` fires once the child exits.
 */

import which from "which";
import type { DispatchResult, DispatcherEvent, QuotaInfo, ServiceConfig } from "../types.js";
import { BaseDispatcher, type DispatchOpts, type DispatcherInitOpts } from "./base.js";
import { detectRateLimitInText } from "./shared/rate-limit-text.js";
import { streamSubprocess } from "./shared/stream-subprocess.js";

const DEFAULT_TIMEOUT_MS = 600_000; // 10 minutes

interface CodexJsonEvent {
  type?: string;
  item?: {
    type?: string;
    text?: string;
    name?: string;
    input?: unknown;
  };
  message?: string | { content?: string };
  /**
   * Codex emits a top-level `error` event on quota / rate-limit / runtime
   * failures, e.g.:
   *   {"type":"error","message":"You've hit your usage limit. ... try again at May 5th, 2026 11:45 AM."}
   * and a `turn.failed` follow-up:
   *   {"type":"turn.failed","error":{"message":"You've hit your usage limit. …"}}
   * Either shape carries the user-actionable error text. The dispatcher
   * was previously ignoring these — surfacing only the noisy stderr from
   * codex's internal MCP transport instead. We now lift the message into
   * `result.error` and run rate-limit detection over it.
   */
  error?: { message?: string };
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    prompt_tokens?: number;
    completion_tokens?: number;
  };
}

export class CodexDispatcher extends BaseDispatcher {
  readonly id = "codex";
  private readonly available: boolean;

  constructor(_svc?: ServiceConfig, opts: DispatcherInitOpts = {}) {
    super();
    this.available = opts.cliPath !== null;
  }

  isAvailable(): boolean {
    return this.available;
  }

  async checkQuota(): Promise<QuotaInfo> {
    return { service: "codex", source: "unknown" };
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
    const foundPath = await which("codex", { nothrow: true });
    if (!foundPath) {
      yield {
        type: "completion",
        result: {
          output: "",
          service: "codex",
          success: false,
          error: "codex CLI not found",
        },
      };
      return;
    }

    let fullPrompt = prompt;
    if (files.length > 0) {
      const fileList = files.map((p) => `  ${p}`).join("\n");
      fullPrompt = `${prompt}\n\nFiles to work with:\n${fileList}`;
    }

    const args: string[] = ["exec", fullPrompt, "--full-auto", "--json", "--skip-git-repo-check"];
    if (opts.modelOverride) {
      args.push("--model", opts.modelOverride);
    }
    if (workingDir) {
      args.push("--cd", workingDir);
    }

    const extraEnv: Record<string, string> = {};
    const apiKey = process.env["OPENAI_API_KEY"];
    if (apiKey) {
      extraEnv["OPENAI_API_KEY"] = apiKey;
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

    // Incremental JSONL parser — splits on newlines as chunks arrive so we
    // can emit tool_use / thinking events mid-run rather than waiting for
    // the child to exit. Aggregates usage + last agent_message for the
    // final completion event.
    let lineBuffer = "";
    let lastText = "";
    let inputTokens = 0;
    let outputTokens = 0;
    let sawUsage = false;
    let sawAnyJson = false;
    // Captures the user-actionable message from codex's `{type: "error"}`
    // or `{type: "turn.failed", error: {message}}` JSONL events. When set,
    // this becomes the `error` field on the failure result — replacing the
    // noisy stderr (codex's GitHub-MCP transport spam) with the rate-limit
    // / quota / runtime message the user actually needs to see.
    let codexErrorMessage: string | undefined;

    const emitLine = (line: string): DispatcherEvent[] => {
      const out: DispatcherEvent[] = [];
      const trimmed = line.trim();
      if (!trimmed) return out;
      let event: CodexJsonEvent;
      try {
        event = JSON.parse(trimmed) as CodexJsonEvent;
      } catch {
        return out;
      }
      sawAnyJson = true;

      if (event.type === "item.completed" && event.item && event.item.type === "agent_message") {
        const t = event.item.text;
        if (typeof t === "string" && t.length > 0) {
          lastText = t;
        }
      }
      if (event.type === "message" && event.message) {
        // Codex variants: some emit `message.content`, others a flat
        // `message: "..."` string. Handle both.
        const content = typeof event.message === "string" ? event.message : event.message.content;
        if (typeof content === "string" && content.length > 0) {
          lastText = content;
        }
      }

      // Quota / runtime / fatal-error events. Capture the message so the
      // dispatcher's failure result surfaces the human-readable cause
      // (e.g. "You've hit your usage limit, try again at …").
      if (event.type === "error" && typeof event.message === "string") {
        codexErrorMessage = event.message;
      } else if (event.type === "turn.failed" && event.error?.message) {
        codexErrorMessage = event.error.message;
      }

      if (event.item && event.item.type === "tool_use" && typeof event.item.name === "string") {
        out.push({
          type: "tool_use",
          name: event.item.name,
          input: event.item.input,
        });
      } else if (event.type === "thinking" && event.item?.text) {
        out.push({ type: "thinking", chunk: event.item.text });
      }

      if (event.usage) {
        const inTok = event.usage.input_tokens ?? event.usage.prompt_tokens ?? 0;
        const outTok = event.usage.output_tokens ?? event.usage.completion_tokens ?? 0;
        if (inTok || outTok) {
          inputTokens += inTok;
          outputTokens += outTok;
          sawUsage = true;
        }
      }
      return out;
    };

    for await (const evt of streamSubprocess("codex", args, subOpts)) {
      if ("stream" in evt) {
        if (evt.stream === "stdout") {
          stdoutBuf.push(evt.chunk);
          yield { type: "stdout", chunk: evt.chunk };
          lineBuffer += evt.chunk;
          let newlineIdx = lineBuffer.indexOf("\n");
          while (newlineIdx >= 0) {
            const line = lineBuffer.slice(0, newlineIdx);
            lineBuffer = lineBuffer.slice(newlineIdx + 1);
            for (const out of emitLine(line)) yield out;
            newlineIdx = lineBuffer.indexOf("\n");
          }
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

    // Flush any trailing partial line.
    if (lineBuffer.length > 0) {
      for (const out of emitLine(lineBuffer)) yield out;
      lineBuffer = "";
    }

    const stdout = stdoutBuf.join("");
    const stderr = stderrBuf.join("");

    if (timedOut) {
      yield {
        type: "completion",
        result: {
          output: stdout,
          service: "codex",
          success: false,
          error: `Timed out after ${timeoutMs}ms`,
          durationMs,
        },
      };
      return;
    }

    // Stderr path (Windows cmd /c can shuffle streams). If nothing parsed
    // from stdout, try stderr now.
    if (!sawAnyJson && stderr) {
      for (const line of stderr.split(/\r?\n/)) {
        for (const out of emitLine(line)) yield out;
      }
    }

    const parsedText = sawAnyJson ? lastText.trim() : "";
    // Treat the call as failed if we saw a top-level error event in the
    // JSONL stream, even when codex's exit code is 0. This catches the
    // quota / rate-limit / fatal-runtime case where codex prints the
    // error event then exits cleanly: the dispatch DID fail from the
    // user's perspective.
    const sawErrorEvent = codexErrorMessage !== undefined;
    const success = exitCode === 0 && !sawErrorEvent;
    // Output: prefer parsed agent text; if absent (typical on failure),
    // fall back to the human-readable error message; only fall through
    // to raw stdout/stderr as a last resort.
    const output =
      parsedText || (sawErrorEvent ? codexErrorMessage! : "") || stdout.trim() || stderr.trim();

    const result: DispatchResult = {
      output,
      service: "codex",
      success,
      durationMs,
    };
    if (sawUsage) {
      result.tokensUsed = { input: inputTokens, output: outputTokens };
    }
    if (!success) {
      // Error-message priority on the failure path:
      //   1. The codex JSONL `{type:"error"}` / `turn.failed` message
      //      — this is the user-actionable text (rate-limit, quota,
      //      fatal runtime). Always preferred when available.
      //   2. stderr — fallback when the JSONL stream gave us nothing.
      //      Note: codex's stderr commonly includes startup chatter
      //      (e.g. the GitHub-MCP transport's `Bearer error="invalid_token"`
      //      that fires regardless of dispatch success). We use it only
      //      when we have nothing better.
      //   3. Generic exit-code message when both are empty.
      result.error = codexErrorMessage ?? stderr.trim() ?? `Exit code ${exitCode}`;
      // Rate-limit / quota detection. Run over the JSONL error message
      // (most informative) AND over stdout+stderr as a backstop. The
      // shared detector matches `usage limit`, `rate limit`,
      // `too many requests`, `quota exceeded`, `429`, etc.
      const haystack = [codexErrorMessage ?? "", stdout, stderr].join("\n");
      const { rateLimited, retryAfter } = detectRateLimitInText(haystack);
      if (rateLimited) {
        result.rateLimited = true;
        if (retryAfter !== null) result.retryAfter = retryAfter;
      }
    }

    yield { type: "completion", result };
  }
}
