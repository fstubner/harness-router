/**
 * Gemini CLI dispatcher for harness-router.
 *
 * Dispatch:  gemini -p "<prompt>" [--file <path> ...] --output-format json
 *                   [--model <override>]
 *
 * Thinking level: Gemini CLI has no per-invocation flag for thinking level
 * (feature request: github.com/google-gemini/gemini-cli/issues/21974). The
 * Python reference works around this by patching
 *   ~/.gemini/settings.json → modelConfigs.generateContentConfig.thinkingLevel
 * around each dispatch. We reproduce that here using a zero-dependency
 * promise-chain mutex so concurrent dispatches (e.g. via code_mixture) cannot
 * stomp on each other's settings.
 *
 * Override ~/.gemini/settings.json path with GEMINI_SETTINGS_PATH env var
 * (used by tests).
 *
 * Auth:  GEMINI_API_KEY forwarded from process.env when present.
 * Quota: reactive only; deferred proactive check to a later revision.
 *
 * R3: stream()-first. The CLI emits one JSON blob at end-of-run so chunks
 * are forwarded verbatim; completion event parses the full buffer.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import which from "which";
import type {
  DispatchResult,
  DispatcherEvent,
  QuotaInfo,
  ServiceConfig,
  ThinkingLevel,
} from "../types.js";
import { BaseDispatcher, type DispatchOpts, type DispatcherInitOpts } from "./base.js";
import { detectRateLimitInText } from "./shared/rate-limit-text.js";
import { streamSubprocess } from "./shared/stream-subprocess.js";

const DEFAULT_TIMEOUT_MS = 600_000; // 10 minutes

const THINKING_MAP: Record<ThinkingLevel, string> = {
  low: "LOW",
  medium: "MEDIUM",
  high: "HIGH",
};

interface GeminiJsonResponse {
  response?: unknown;
  text?: unknown;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    prompt_tokens?: number;
    completion_tokens?: number;
  };
}

// ---------------------------------------------------------------------------
// Module-level mutex: serialises concurrent Gemini dispatches so the settings
// patch/restore around each call cannot interleave. Zero dependencies.
//
// The lock is exposed via `acquireGeminiLock()` (returns a release function)
// rather than a wrapping callback — this lets the dispatcher hold the lock
// across a streaming subprocess invocation while still yielding events live
// to the caller. The previous `withLock(fn)` wrapper buffered all events and
// only released after the subprocess exited, which defeated streaming.
// ---------------------------------------------------------------------------

let lockChain: Promise<void> = Promise.resolve();

async function acquireGeminiLock(): Promise<() => void> {
  const prev = lockChain;
  let release!: () => void;
  lockChain = new Promise<void>((r) => {
    release = r;
  });
  await prev;
  return release;
}

export function _geminiLockIdle(): Promise<void> {
  return lockChain;
}

function settingsPath(): string {
  const override = process.env["GEMINI_SETTINGS_PATH"];
  if (override) return override;
  return path.join(os.homedir(), ".gemini", "settings.json");
}

/**
 * Acquire the gemini settings-patch lock and write the desired thinking
 * level into `~/.gemini/settings.json`. Returns an async teardown function
 * that restores the original settings and releases the lock — call it from
 * a `finally` block so the lock can't leak on errors or generator
 * cancellation.
 *
 * When `level` is undefined or unknown, no patch is performed and the
 * teardown is a no-op (lock not acquired) — caller pays no synchronisation
 * cost.
 */
async function setupThinkingOverride(
  level: ThinkingLevel | undefined,
): Promise<() => Promise<void>> {
  if (!level) return async () => {};
  const mapped = THINKING_MAP[level];
  if (!mapped) return async () => {};

  const release = await acquireGeminiLock();
  const file = settingsPath();
  let originalText: string | null = null;

  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    let settings: Record<string, unknown> = {};
    try {
      originalText = await fs.readFile(file, "utf8");
      try {
        const parsed = JSON.parse(originalText) as unknown;
        if (parsed && typeof parsed === "object") {
          settings = parsed as Record<string, unknown>;
        }
      } catch {
        // Malformed JSON — fall through with empty settings; we'll restore
        // the original text verbatim afterwards.
      }
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      // ENOENT is expected (no existing settings file). Anything else
      // bubbles up to the outer catch which calls release(). Don't release
      // here — that would double-resolve the lock promise.
      if (e?.code !== "ENOENT") throw err;
    }

    const modelConfigs = getOrCreateObject(settings, "modelConfigs");
    const generateContentConfig = getOrCreateObject(modelConfigs, "generateContentConfig");
    generateContentConfig["thinkingLevel"] = mapped;
    await fs.writeFile(file, JSON.stringify(settings, null, 2), "utf8");
  } catch (err) {
    release();
    throw err;
  }

  return async () => {
    try {
      if (originalText !== null) {
        try {
          await fs.writeFile(file, originalText, "utf8");
        } catch {
          // best-effort restore
        }
      } else {
        try {
          const raw = await fs.readFile(file, "utf8");
          const restored = JSON.parse(raw) as Record<string, unknown>;
          const mc = restored["modelConfigs"];
          if (mc && typeof mc === "object") {
            const gcc = (mc as Record<string, unknown>)["generateContentConfig"];
            if (gcc && typeof gcc === "object") {
              delete (gcc as Record<string, unknown>)["thinkingLevel"];
            }
          }
          await fs.writeFile(file, JSON.stringify(restored, null, 2), "utf8");
        } catch {
          // best-effort cleanup
        }
      }
    } finally {
      release();
    }
  };
}

function getOrCreateObject(parent: Record<string, unknown>, key: string): Record<string, unknown> {
  const existing = parent[key];
  if (existing && typeof existing === "object" && !Array.isArray(existing)) {
    return existing as Record<string, unknown>;
  }
  const fresh: Record<string, unknown> = {};
  parent[key] = fresh;
  return fresh;
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

export class GeminiDispatcher extends BaseDispatcher {
  readonly id = "gemini_cli";
  private readonly thinkingLevel: ThinkingLevel | undefined;
  private readonly configuredModel: string | undefined;
  private readonly available: boolean;

  constructor(svc?: ServiceConfig, opts: DispatcherInitOpts = {}) {
    super();
    this.thinkingLevel = svc?.thinkingLevel;
    this.configuredModel = svc?.model;
    this.available = opts.cliPath !== null;
  }

  isAvailable(): boolean {
    return this.available;
  }

  async checkQuota(): Promise<QuotaInfo> {
    return { service: "gemini_cli", source: "unknown" };
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
    const foundPath = await which("gemini", { nothrow: true });
    if (!foundPath) {
      yield {
        type: "completion",
        result: {
          output: "",
          service: "gemini_cli",
          success: false,
          error: "gemini CLI not found",
        },
      };
      return;
    }

    const effectiveModel = opts.modelOverride ?? this.configuredModel;

    const args: string[] = [];
    if (effectiveModel) {
      args.push("--model", effectiveModel);
    }
    args.push("-p", prompt, "--output-format", "json");
    for (const file of files) {
      args.push("--file", file);
    }

    const extraEnv: Record<string, string> = {};
    const apiKey = process.env["GEMINI_API_KEY"];
    if (apiKey) {
      extraEnv["GEMINI_API_KEY"] = apiKey;
    }

    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    const subOpts: Parameters<typeof streamSubprocess>[2] = { timeoutMs };
    if (workingDir) subOpts.cwd = workingDir;
    if (Object.keys(extraEnv).length > 0) subOpts.env = extraEnv;

    // Acquire the settings-patch lock and apply the thinking override before
    // spawning the subprocess. Hold it across the streaming loop so events
    // pass through live, and release it in `finally` so generator
    // cancellation (e.g. consumer breaks early) still restores settings.
    //
    // Cancellation chain (from outermost to innermost):
    //   consumer `break`  →  V8 sends `.return()` to outer router generator
    //                     →  withRouterStreamSpan's finally calls iter.return()
    //                     →  this #runStream's `for await` on streamSubprocess
    //                        triggers its own .return() handler, which kills
    //                        the child
    //                     →  this finally block runs synchronously and calls
    //                        teardown() to restore settings.json + release lock
    // The fix in withRouterStreamSpan (audit pass A: BUG-A4) is what makes
    // this chain reliable — without it, teardown was deferred to GC.
    const stdoutBuf: string[] = [];
    const stderrBuf: string[] = [];
    let exitCode = -1;
    let durationMs = 0;
    let timedOut = false;

    const teardown = await setupThinkingOverride(this.thinkingLevel);
    try {
      for await (const evt of streamSubprocess("gemini", args, subOpts)) {
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
    } finally {
      await teardown();
    }

    const stdout = stdoutBuf.join("");
    const stderr = stderrBuf.join("");

    if (timedOut) {
      yield {
        type: "completion",
        result: {
          output: stdout,
          service: "gemini_cli",
          success: false,
          error: `Timed out after ${timeoutMs}ms`,
          durationMs,
        },
      };
      return;
    }

    const parsed = parseGeminiJson(stdout) ?? parseGeminiJson(stderr);
    const parsedText = parsed?.text ?? "";

    if (exitCode === 0) {
      const output = parsedText || stdout.trim() || stderr.trim();
      const result: DispatchResult = {
        output,
        service: "gemini_cli",
        success: true,
        durationMs,
      };
      if (parsed?.tokensUsed) result.tokensUsed = parsed.tokensUsed;
      yield { type: "completion", result };
      return;
    }

    const combined = `${stdout}\n${stderr}`;
    const { rateLimited, retryAfter } = detectRateLimitInText(combined);
    const errorDetail = stderr.trim() || stdout.trim() || `Exit code ${exitCode}`;

    const result: DispatchResult = {
      output: parsedText || stdout.trim(),
      service: "gemini_cli",
      success: false,
      error: errorDetail,
      durationMs,
    };
    if (rateLimited) {
      result.rateLimited = true;
      if (retryAfter !== null) result.retryAfter = retryAfter;
    }
    if (parsed?.tokensUsed) result.tokensUsed = parsed.tokensUsed;
    yield { type: "completion", result };
  }
}

interface ParsedGeminiOutput {
  text: string;
  tokensUsed?: { input: number; output: number };
}

function parseGeminiJson(raw: string): ParsedGeminiOutput | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  let data: unknown;
  try {
    data = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object") return null;

  const obj = data as GeminiJsonResponse;
  const textCandidate = obj.response ?? obj.text;
  const text = typeof textCandidate === "string" ? textCandidate.trim() : "";

  const parsed: ParsedGeminiOutput = { text };

  if (obj.usage) {
    const input = obj.usage.input_tokens ?? obj.usage.prompt_tokens;
    const output = obj.usage.output_tokens ?? obj.usage.completion_tokens;
    if (typeof input === "number" && typeof output === "number") {
      parsed.tokensUsed = { input, output };
    }
  }

  return parsed;
}
