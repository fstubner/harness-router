/**
 * Generic CLI dispatcher for harness-router-mcp.
 *
 * Lets users add a new AI CLI tool to the router via YAML alone — no
 * TypeScript code changes required. The recipe (see `GenericCliRecipe` in
 * `../types.ts`) describes:
 *   - the bare command name (resolved via `which` + safeSpawn)
 *   - args that come before / after the prompt positional
 *   - optional `--model` and `--cwd`-style flags (only emitted when set)
 *   - env vars to forward from the host process
 *   - optional JSON extraction for response text + token usage
 *
 * Argv assembly:
 *   [...argsBeforePrompt, ?modelFlag, ?model, ?cwdFlag, ?workingDir, prompt, ...argsAfterPrompt]
 *
 * Behaviour mirrors the hand-tuned dispatchers (claude_code, codex, cursor,
 * gemini, opencode):
 *   - timeout via `streamSubprocess` (default 10 min)
 *   - rate-limit detection on the failure path (shared `detectRateLimitInText`)
 *   - file context appended to the prompt as a "Files to work with" block
 *
 * Trade-off: this dispatcher is intentionally less flexible than the
 * hand-tuned ones. It cannot:
 *   - emit live `tool_use` / `thinking` events (those need format-specific
 *     parsers — codex's JSONL, cursor's single JSON blob, etc.)
 *   - patch CLI-specific config files (gemini's settings.json mutex)
 *   - implement provider-specific auth flows
 *
 * If your CLI needs any of those, write a hand-tuned dispatcher. If it
 * looks like "command + flags + prompt + plain-text response," this is
 * the right tool.
 */

import which from "which";

import type {
  DispatchResult,
  DispatcherEvent,
  GenericCliRecipe,
  QuotaInfo,
  ServiceConfig,
} from "../types.js";

type GenericJsonlConfig = NonNullable<GenericCliRecipe["outputJsonl"]>;
type JsonlEmit = DispatcherEvent | { type: "__tokens"; tokens: { input: number; output: number } };
import { BaseDispatcher, type DispatchOpts, type DispatcherInitOpts } from "./base.js";
import { detectRateLimitInText } from "./shared/rate-limit-text.js";
import { streamSubprocess } from "./shared/stream-subprocess.js";

const DEFAULT_TIMEOUT_MS = 600_000; // 10 minutes

export class GenericCliDispatcher extends BaseDispatcher {
  readonly id: string;
  private readonly command: string;
  private readonly recipe: GenericCliRecipe;
  private readonly configuredModel: string | undefined;
  private readonly available: boolean;

  constructor(svc: ServiceConfig, opts: DispatcherInitOpts = {}) {
    super();
    this.id = svc.name;
    if (!svc.command) {
      throw new Error(`generic_cli service "${svc.name}" is missing required 'command' field`);
    }
    this.command = svc.command;
    this.recipe = svc.genericCli ?? {};
    this.configuredModel = svc.model;
    this.available = opts.cliPath !== null;
  }

  isAvailable(): boolean {
    return this.available;
  }

  async checkQuota(): Promise<QuotaInfo> {
    // Generic CLIs have no proactive quota endpoint — circuit breaker handles
    // exhaustion via the reactive `rateLimited` flag.
    return { service: this.id, source: "unknown" };
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
    const foundPath = await which(this.command, { nothrow: true });
    if (!foundPath) {
      yield {
        type: "completion",
        result: {
          output: "",
          service: this.id,
          success: false,
          error: `${this.command} CLI not found on PATH`,
        },
      };
      return;
    }

    // File handling. Two paths:
    //  - With `argsPerFile`: files travel via argv (one expansion per file,
    //    inserted into argv below). The prompt text is NOT augmented — the
    //    CLI is expected to read the files itself.
    //  - Without `argsPerFile` (default): files are appended to the prompt
    //    text as a "Files to work with: …" block, matching the hand-tuned
    //    dispatchers' shape for CLIs that don't have a dedicated --file
    //    flag.
    const usePerFileArgs = !!this.recipe.argsPerFile && files.length > 0;
    let fullPrompt = prompt;
    if (files.length > 0 && !usePerFileArgs) {
      const fileList = files.map((p) => `  - ${p}`).join("\n");
      fullPrompt = `${prompt}\n\nFiles to work with:\n${fileList}`;
    }

    const effectiveModel = opts.modelOverride ?? this.configuredModel;
    const promptDelivery = this.recipe.promptDelivery ?? "positional";

    // Validate prompt delivery config early — surfacing the misconfiguration
    // here is much friendlier than silently emitting broken argv.
    if (promptDelivery === "flag" && !this.recipe.promptFlag) {
      yield {
        type: "completion",
        result: {
          output: "",
          service: this.id,
          success: false,
          error: `generic_cli "${this.id}" sets promptDelivery: "flag" but is missing promptFlag`,
        },
      };
      return;
    }

    // Argv assembly. Each chunk is appended only if its prerequisite value
    // is present — this matches the conditional-flag idiom used by the
    // hand-tuned dispatchers.
    const args: string[] = [...(this.recipe.argsBeforePrompt ?? [])];
    if (this.recipe.modelFlag && effectiveModel) {
      args.push(this.recipe.modelFlag, effectiveModel);
    }
    if (this.recipe.cwdFlag && workingDir) {
      args.push(this.recipe.cwdFlag, workingDir);
    }
    // Per-file expansion. The template entries are emitted once per file
    // with `{path}` replaced. Entries without `{path}` are passed through
    // verbatim so paired-flag idioms (`[--file, {path}]`) work as expected.
    if (usePerFileArgs) {
      for (const filePath of files) {
        for (const entry of this.recipe.argsPerFile!) {
          args.push(entry.includes("{path}") ? entry.replace(/\{path\}/g, filePath) : entry);
        }
      }
    }
    // Prompt slot. Three delivery modes:
    //   - positional: prompt is one argv entry (default)
    //   - flag:       prompt is `[promptFlag, <text>]`
    //   - stdin:      prompt is fed on stdin; no argv entry for it
    let stdinInput: string | undefined;
    if (promptDelivery === "stdin") {
      stdinInput = fullPrompt;
    } else if (promptDelivery === "flag") {
      // promptFlag presence checked above.
      args.push(this.recipe.promptFlag!, fullPrompt);
    } else {
      args.push(fullPrompt);
    }
    args.push(...(this.recipe.argsAfterPrompt ?? []));

    // Env forwarding. Only set vars that are actually present in the host
    // environment — empty strings would override a different default in the
    // child's config.
    const extraEnv: Record<string, string> = {};
    for (const key of this.recipe.forwardEnv ?? []) {
      const v = process.env[key];
      if (v) extraEnv[key] = v;
    }

    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const subOpts: Parameters<typeof streamSubprocess>[2] = { timeoutMs };
    if (workingDir) subOpts.cwd = workingDir;
    if (Object.keys(extraEnv).length > 0) subOpts.env = extraEnv;
    if (stdinInput !== undefined) subOpts.stdinInput = stdinInput;

    const stdoutBuf: string[] = [];
    const stderrBuf: string[] = [];
    let exitCode = -1;
    let durationMs = 0;
    let timedOut = false;

    // JSONL streaming state — used only when `outputJsonl` is set on the
    // recipe. Splits stdout chunks on `\n` so we can emit live tool_use /
    // thinking / stdout events mid-run, plus accumulate the concatenated
    // text response for the final completion event.
    const jsonl = this.recipe.outputJsonl;
    let lineBuffer = "";
    const jsonlTextDeltas: string[] = [];
    let jsonlTokens: { input: number; output: number } | undefined;

    for await (const evt of streamSubprocess(this.command, args, subOpts)) {
      if ("stream" in evt) {
        if (evt.stream === "stdout") {
          stdoutBuf.push(evt.chunk);
          if (jsonl) {
            // Parse line-by-line. Live-emit text deltas, tool_use, thinking.
            // Suppress the raw stdout passthrough — callers that opt into
            // JSONL want structured events, not the raw JSONL frames.
            lineBuffer += evt.chunk;
            let nl = lineBuffer.indexOf("\n");
            while (nl >= 0) {
              const line = lineBuffer.slice(0, nl);
              lineBuffer = lineBuffer.slice(nl + 1);
              for (const out of parseJsonlLine(line, jsonl)) {
                if (out.type === "stdout") jsonlTextDeltas.push(out.chunk);
                if (out.type === "__tokens") {
                  jsonlTokens = out.tokens;
                } else {
                  yield out;
                }
              }
              nl = lineBuffer.indexOf("\n");
            }
          } else {
            yield { type: "stdout", chunk: evt.chunk };
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

    // Flush any trailing partial JSONL line (no terminating newline).
    if (jsonl && lineBuffer.length > 0) {
      for (const out of parseJsonlLine(lineBuffer, jsonl)) {
        if (out.type === "stdout") jsonlTextDeltas.push(out.chunk);
        if (out.type === "__tokens") {
          jsonlTokens = out.tokens;
        } else {
          yield out;
        }
      }
      lineBuffer = "";
    }

    const stdout = stdoutBuf.join("");
    const stderr = stderrBuf.join("");

    if (timedOut) {
      yield {
        type: "completion",
        result: {
          output: stdout,
          service: this.id,
          success: false,
          error: `Timed out after ${timeoutMs}ms`,
          durationMs,
        },
      };
      return;
    }

    // Output extraction. Three cases, mutually exclusive:
    //  - JSONL streaming (`outputJsonl`): text was accumulated during the
    //    stream; concat the deltas. Tokens come from any event whose
    //    `tokensPath` resolved.
    //  - Buffered JSON (`outputJsonPath`): parse stdout once, pull out the
    //    configured field. Falls back to raw stdout on parse failure so a
    //    misconfigured path doesn't break the dispatch.
    //  - Plain text (default): trim stdout.
    let textOutput: string;
    let tokensUsed: { input: number; output: number } | undefined;
    if (jsonl) {
      textOutput = jsonlTextDeltas.join("");
      tokensUsed = jsonlTokens;
    } else if (this.recipe.outputJsonPath) {
      const parsed = extractJsonFields(
        stdout,
        this.recipe.outputJsonPath,
        this.recipe.tokensJsonPath,
      );
      textOutput = parsed?.text ?? stdout.trim();
      tokensUsed = parsed?.tokensUsed;
    } else {
      textOutput = stdout.trim();
    }

    // Success classification. We treat a zero exit code as success even
    // when the text output is empty — some CLIs (formatters, side-effect
    // tools) intentionally write nothing. The audit flagged this; the
    // earlier behaviour matched cursor/opencode but excluded a real use
    // case for `generic_cli`.
    if (exitCode === 0) {
      const result: DispatchResult = {
        output: textOutput,
        service: this.id,
        success: true,
        durationMs,
      };
      if (tokensUsed) result.tokensUsed = tokensUsed;
      yield { type: "completion", result };
      return;
    }

    // Failure path. Surface the most actionable text we have, and lift any
    // rate-limit signal so the router's circuit breaker honours retry-after.
    const errorDetail = stderr.trim() || stdout.trim() || `Exit code ${exitCode}`;
    const { rateLimited, retryAfter } = detectRateLimitInText(`${stdout}\n${stderr}`);
    const result: DispatchResult = {
      output: textOutput,
      service: this.id,
      success: false,
      error: errorDetail,
      durationMs,
    };
    if (rateLimited) {
      result.rateLimited = true;
      if (retryAfter !== null) result.retryAfter = retryAfter;
    }
    if (tokensUsed) result.tokensUsed = tokensUsed;
    yield { type: "completion", result };
  }
}

interface ExtractedFields {
  text: string | null;
  tokensUsed?: { input: number; output: number };
}

/**
 * Best-effort JSON extraction. `textPath` and `tokensPath` are dotted paths
 * (`a.b.c`) into the parsed JSON. Numeric segments are interpreted as array
 * indices. Returns `text: null` when the path doesn't resolve to a string.
 *
 * Token shapes recognised (in priority order):
 *   { input, output }
 *   { input_tokens, output_tokens }
 *   { prompt_tokens, completion_tokens }
 */
function extractJsonFields(
  raw: string,
  textPath: string,
  tokensPath: string | undefined,
): ExtractedFields | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let data: unknown;
  try {
    data = JSON.parse(trimmed);
  } catch {
    return null;
  }
  const text = readPath(data, textPath);
  const out: ExtractedFields = { text: typeof text === "string" ? text.trim() : null };
  if (tokensPath) {
    const usage = readPath(data, tokensPath);
    if (usage && typeof usage === "object") {
      const u = usage as Record<string, unknown>;
      const input =
        (typeof u.input === "number" ? u.input : undefined) ??
        (typeof u.input_tokens === "number" ? u.input_tokens : undefined) ??
        (typeof u.prompt_tokens === "number" ? u.prompt_tokens : undefined);
      const output =
        (typeof u.output === "number" ? u.output : undefined) ??
        (typeof u.output_tokens === "number" ? u.output_tokens : undefined) ??
        (typeof u.completion_tokens === "number" ? u.completion_tokens : undefined);
      if (typeof input === "number" && typeof output === "number") {
        out.tokensUsed = { input, output };
      }
    }
  }
  return out;
}

function readPath(value: unknown, path: string): unknown {
  if (!path) return value;
  let cursor: unknown = value;
  for (const segment of path.split(".")) {
    if (cursor === null || typeof cursor !== "object") return undefined;
    if (Array.isArray(cursor)) {
      const idx = Number.parseInt(segment, 10);
      if (!Number.isFinite(idx) || idx < 0 || idx >= cursor.length) return undefined;
      cursor = cursor[idx];
    } else {
      cursor = (cursor as Record<string, unknown>)[segment];
    }
  }
  return cursor;
}

/**
 * Parse one JSONL line into dispatcher events. Silently skips lines that
 * aren't valid JSON or don't match any configured path — we don't want
 * stray informational chatter (which some CLIs interleave with the JSONL
 * stream) to abort the dispatch.
 *
 * Yields:
 *   - `{ type: "stdout", chunk }`  for each non-empty `textDeltaPath` hit
 *   - `{ type: "tool_use", … }`    for each `toolNamePath` hit
 *   - `{ type: "thinking", … }`    for each `thinkingPath` hit
 *   - `{ type: "__tokens", … }`    a sentinel for the dispatcher's loop
 *                                  to capture; never yielded to the caller.
 */
function parseJsonlLine(line: string, cfg: GenericJsonlConfig): JsonlEmit[] {
  const trimmed = line.trim();
  if (!trimmed) return [];
  let event: unknown;
  try {
    event = JSON.parse(trimmed);
  } catch {
    return [];
  }
  const out: JsonlEmit[] = [];

  const text = readPath(event, cfg.textDeltaPath);
  if (typeof text === "string" && text.length > 0) {
    out.push({ type: "stdout", chunk: text });
  }

  if (cfg.toolNamePath) {
    const toolName = readPath(event, cfg.toolNamePath);
    if (typeof toolName === "string" && toolName.length > 0) {
      const input = cfg.toolInputPath ? readPath(event, cfg.toolInputPath) : undefined;
      out.push({ type: "tool_use", name: toolName, input });
    }
  }

  if (cfg.thinkingPath) {
    const thinking = readPath(event, cfg.thinkingPath);
    if (typeof thinking === "string" && thinking.length > 0) {
      out.push({ type: "thinking", chunk: thinking });
    }
  }

  if (cfg.tokensPath) {
    const usage = readPath(event, cfg.tokensPath);
    if (usage && typeof usage === "object") {
      const u = usage as Record<string, unknown>;
      const input =
        (typeof u.input === "number" ? u.input : undefined) ??
        (typeof u.input_tokens === "number" ? u.input_tokens : undefined) ??
        (typeof u.prompt_tokens === "number" ? u.prompt_tokens : undefined);
      const output =
        (typeof u.output === "number" ? u.output : undefined) ??
        (typeof u.output_tokens === "number" ? u.output_tokens : undefined) ??
        (typeof u.completion_tokens === "number" ? u.completion_tokens : undefined);
      if (typeof input === "number" && typeof output === "number") {
        out.push({ type: "__tokens", tokens: { input, output } });
      }
    }
  }

  return out;
}
