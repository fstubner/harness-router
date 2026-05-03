/**
 * GitHub Copilot CLI dispatcher for harness-router-mcp.
 *
 * Dispatch:  copilot -p "<prompt>" --allow-all-tools --no-color
 *                    --output-format json --silent
 *                    [--add-dir <cwd>] [-m <model>]
 *
 * Flags:
 *   -p, --prompt <text>       Non-interactive prompt mode (required for headless).
 *   --allow-all-tools         Allow all tools to run without per-action confirmation
 *                             (also satisfiable via env COPILOT_ALLOW_ALL=true).
 *                             Required for non-interactive — prompts would
 *                             otherwise block waiting for confirmation.
 *   --no-color                Strip ANSI from output.
 *   --output-format json      JSONL events on stdout, one object per line.
 *   --silent                  Drop environment / banner / redacted noise so the
 *                             stream is just agent events.
 *   --add-dir <cwd>           Whitelist the working directory for file access.
 *                             Without this, copilot's tool sandbox refuses to
 *                             read/write outside its default-allowed roots.
 *
 * Auth: subscription-based. Users authenticate via `copilot` (interactive
 *   first run) or `gh auth login` with the right scope. We don't ship an
 *   `auth login` subcommand because copilot uses the GitHub host's auth.
 *
 * Policy: org-level Copilot policy can block CLI access ("Access denied by
 *   policy settings"). The dispatcher detects this and surfaces a clear CTA
 *   pointing at https://github.com/settings/copilot rather than a generic
 *   auth error — common confusion when the user IS authed but their account
 *   doesn't have CLI access enabled.
 *
 * Quota: reactive. We watch for "rate limit" / "usage limit" signals in
 *   stderr + JSONL and lift them onto the dispatch result.
 *
 * Output parsing: copilot emits one JSON object per line on stdout when
 *   `--output-format json` is set. The object shape varies by event:
 *     {type:"session.*", data: {...}}     lifecycle (startup, finish)
 *     {type:"agent.message", text: "..."} chat content
 *     {type:"agent.tool_use", name, ...}  tool invocations
 *     {type:"error", message: "..."}      runtime errors
 *   The exact schema isn't fully documented at the time of writing. The
 *   parser is defensive: it pulls `text` / `message` from any event, treats
 *   the last non-empty agent message as the output, and surfaces top-level
 *   errors. Lines that aren't valid JSON are ignored (some events may print
 *   plain text directly to stdout — we let those flow through as raw chunks).
 */

import which from "which";

import type { DispatchResult, DispatcherEvent, QuotaInfo, ServiceConfig } from "../types.js";
import { BaseDispatcher, type DispatchOpts, type DispatcherInitOpts } from "./base.js";
import { detectRateLimitInText } from "./shared/rate-limit-text.js";
import { streamSubprocess } from "./shared/stream-subprocess.js";

const DEFAULT_TIMEOUT_MS = 600_000; // 10 minutes

/**
 * Match copilot's policy-denial error text. Works against both the plain
 * stderr message and a JSONL `{type:"error", message:"..."}` body. Anchored
 * loosely so wording variations across copilot versions still match.
 */
const POLICY_DENIAL_RE = /access\s+denied\s+by\s+policy\s+settings/i;

interface CopilotEvent {
  type?: string;
  text?: string;
  message?: string;
  data?: { message?: string; status?: string };
  // The agent-message variant; copilot has gone through several shapes.
  // Defensive: also accept `content`.
  content?: string;
  // Tool-use shape.
  name?: string;
  input?: unknown;
  // Usage / token accounting on completion events.
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    prompt_tokens?: number;
    completion_tokens?: number;
  };
  error?: { message?: string } | string;
}

export class CopilotDispatcher extends BaseDispatcher {
  readonly id = "copilot";
  private readonly available: boolean;

  constructor(_svc?: ServiceConfig, opts: DispatcherInitOpts = {}) {
    super();
    this.available = opts.cliPath !== null;
  }

  isAvailable(): boolean {
    return this.available;
  }

  async checkQuota(): Promise<QuotaInfo> {
    return { service: "copilot", source: "unknown" };
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
    const foundPath = await which("copilot", { nothrow: true });
    if (!foundPath) {
      yield {
        type: "completion",
        result: {
          output: "",
          service: "copilot",
          success: false,
          error: "copilot CLI not found — install via `npm install -g @github/copilot`",
        },
      };
      return;
    }

    let fullPrompt = prompt;
    if (files.length > 0) {
      const fileList = files.map((p) => `  ${p}`).join("\n");
      fullPrompt = `${prompt}\n\nFiles to work with:\n${fileList}`;
    }

    // Argv. The prompt goes via `-p`, NOT as a positional — copilot rejects
    // positional prompts. `--allow-all-tools` is required for non-interactive
    // mode (otherwise tools would prompt for per-action confirmation, which
    // would block forever in a headless session).
    const args: string[] = [
      "-p",
      fullPrompt,
      "--allow-all-tools",
      "--no-color",
      "--output-format",
      "json",
      "--silent",
    ];
    if (workingDir) {
      args.push("--add-dir", workingDir);
    }
    if (opts.modelOverride) {
      args.push("-m", opts.modelOverride);
    }

    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const subOpts: Parameters<typeof streamSubprocess>[2] = { timeoutMs };
    if (workingDir) subOpts.cwd = workingDir;

    const stdoutBuf: string[] = [];
    const stderrBuf: string[] = [];
    let exitCode = -1;
    let durationMs = 0;
    let timedOut = false;

    // Streaming JSONL parser state. Same pattern as the codex dispatcher.
    let lineBuffer = "";
    let lastText = "";
    let inputTokens = 0;
    let outputTokens = 0;
    let sawUsage = false;
    let sawAnyJson = false;
    let copilotErrorMessage: string | undefined;

    const emitLine = (line: string): DispatcherEvent[] => {
      const out: DispatcherEvent[] = [];
      const trimmed = line.trim();
      if (!trimmed) return out;
      let event: CopilotEvent;
      try {
        event = JSON.parse(trimmed) as CopilotEvent;
      } catch {
        // Plain-text lines (e.g. policy denial text) are NOT JSON — let them
        // flow through unparsed. Don't set sawAnyJson so the fallback path
        // can still surface stderr for these cases.
        return out;
      }
      sawAnyJson = true;

      // Capture user-actionable error events. Copilot has at least two shapes
      // (top-level `error` and nested `data.message`). Be defensive.
      const errMsg =
        typeof event.error === "string"
          ? event.error
          : (event.error?.message ?? (event.type === "error" ? event.message : undefined));
      if (typeof errMsg === "string" && errMsg.length > 0) {
        copilotErrorMessage = errMsg;
      }

      // Agent message text — accumulate the last one as the final answer.
      // Try several known shapes: `text` (newer), `content` (older),
      // `message` (string variant), `data.message` (nested).
      const textCandidate =
        event.text ??
        event.content ??
        (typeof event.message === "string" ? event.message : undefined) ??
        event.data?.message;
      if (
        typeof textCandidate === "string" &&
        textCandidate.length > 0 &&
        // Don't treat error messages as agent text.
        event.type !== "error"
      ) {
        // Only treat as agent message if the type looks content-bearing.
        // Heuristic: agent.* and message.* event types contribute to text;
        // session.* and lifecycle events don't.
        const t = event.type ?? "";
        if (t.startsWith("agent.") || t === "message" || t === "agent_message") {
          lastText = textCandidate;
        }
      }

      // Tool use — emit live for streaming consumers.
      if (
        event.type &&
        (event.type === "agent.tool_use" || event.type === "tool_use") &&
        typeof event.name === "string"
      ) {
        out.push({
          type: "tool_use",
          name: event.name,
          input: event.input,
        });
      } else if (
        event.type &&
        (event.type === "agent.thinking" || event.type === "thinking") &&
        typeof textCandidate === "string"
      ) {
        out.push({ type: "thinking", chunk: textCandidate });
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

    for await (const evt of streamSubprocess("copilot", args, subOpts)) {
      if ("stream" in evt) {
        if (evt.stream === "stdout") {
          stdoutBuf.push(evt.chunk);
          yield { type: "stdout", chunk: evt.chunk };
          lineBuffer += evt.chunk;
          let nl = lineBuffer.indexOf("\n");
          while (nl >= 0) {
            const line = lineBuffer.slice(0, nl);
            lineBuffer = lineBuffer.slice(nl + 1);
            for (const o of emitLine(line)) yield o;
            nl = lineBuffer.indexOf("\n");
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
    // Flush trailing JSONL line.
    if (lineBuffer.length > 0) {
      for (const o of emitLine(lineBuffer)) yield o;
    }

    const stdout = stdoutBuf.join("");
    const stderr = stderrBuf.join("");

    if (timedOut) {
      yield {
        type: "completion",
        result: {
          output: stdout,
          service: "copilot",
          success: false,
          error: `Timed out after ${timeoutMs}ms`,
          durationMs,
        },
      };
      return;
    }

    // Detect policy denial separately — it's the most common confusing
    // failure for new users (their GitHub account is authed but their
    // org/subscription policy hasn't enabled CLI access). The error often
    // arrives on stderr as plain text, NOT in the JSONL stream.
    const combined = `${stdout}\n${stderr}\n${copilotErrorMessage ?? ""}`;
    const isPolicyDenial = POLICY_DENIAL_RE.test(combined);

    const parsedText = sawAnyJson ? lastText.trim() : "";
    // Failure detection: explicit error event OR non-zero exit OR policy denial.
    const sawErrorEvent = copilotErrorMessage !== undefined;
    const success = exitCode === 0 && !sawErrorEvent && !isPolicyDenial;

    // Output preference: parsed agent text > captured error message > raw
    // stdout > raw stderr.
    const output =
      parsedText || (sawErrorEvent ? copilotErrorMessage! : "") || stdout.trim() || stderr.trim();

    const result: DispatchResult = {
      output,
      service: "copilot",
      success,
      durationMs,
    };
    if (sawUsage) {
      result.tokensUsed = { input: inputTokens, output: outputTokens };
    }

    if (!success) {
      // Error message priority:
      //   1. Policy denial (most actionable — hand-tuned hint + URL)
      //   2. Captured JSONL error event
      //   3. stderr (when copilot prints plain-text errors that bypass
      //      the JSONL formatter — the typical path)
      //   4. Generic exit-code message
      if (isPolicyDenial) {
        result.error =
          "Copilot CLI policy denied access. " +
          "Check your subscription / org policy at https://github.com/settings/copilot " +
          "(this is NOT an auth issue — you may be logged in but your account doesn't have CLI access enabled).";
      } else {
        result.error = copilotErrorMessage ?? stderr.trim() ?? `Exit code ${exitCode}`;
      }

      // Rate-limit / quota detection. Run over the most-informative haystack.
      const haystack = [copilotErrorMessage ?? "", stdout, stderr].join("\n");
      const { rateLimited, retryAfter } = detectRateLimitInText(haystack);
      if (rateLimited) {
        result.rateLimited = true;
        if (retryAfter !== null) result.retryAfter = retryAfter;
      }
    }

    yield { type: "completion", result };
  }
}
