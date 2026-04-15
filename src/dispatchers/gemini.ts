/**
 * Gemini CLI dispatcher for coding-agent-mcp.
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
 * Quota: reactive only in R1; deferred proactive check to R3.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import which from "which";
import type {
  DispatchResult,
  QuotaInfo,
  ServiceConfig,
  ThinkingLevel,
} from "../types.js";
import type { Dispatcher, DispatchOpts } from "./base.js";
import { runSubprocess } from "./shared/subprocess.js";
import { resolveCliCommand } from "./shared/windows-cmd.js";

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
// ---------------------------------------------------------------------------

let lockChain: Promise<void> = Promise.resolve();

function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const prev = lockChain;
  let release!: () => void;
  lockChain = new Promise<void>((r) => {
    release = r;
  });
  return prev.then(async () => {
    try {
      return await fn();
    } finally {
      release();
    }
  });
}

/**
 * Test-only accessor: waits for the lock chain to drain. Exported so tests
 * can assert serialization without relying on timing.
 */
export function _geminiLockIdle(): Promise<void> {
  return lockChain;
}

function settingsPath(): string {
  const override = process.env["GEMINI_SETTINGS_PATH"];
  if (override) return override;
  return path.join(os.homedir(), ".gemini", "settings.json");
}

/**
 * Patch ~/.gemini/settings.json with the requested thinking level, invoke
 * `fn`, then restore the original contents. If `level` is null/undefined,
 * `fn` is called without touching the settings file.
 *
 * The module-level lock is acquired for the entire patch → fn → restore
 * cycle so concurrent callers don't interleave.
 */
async function withThinkingOverride<T>(
  level: ThinkingLevel | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  if (!level) return fn();
  const mapped = THINKING_MAP[level];
  if (!mapped) return fn();

  return withLock(async () => {
    const file = settingsPath();
    await fs.mkdir(path.dirname(file), { recursive: true });

    let originalText: string | null = null;
    let settings: Record<string, unknown> = {};
    try {
      originalText = await fs.readFile(file, "utf8");
      try {
        const parsed = JSON.parse(originalText) as unknown;
        if (parsed && typeof parsed === "object") {
          settings = parsed as Record<string, unknown>;
        }
      } catch {
        // Fall through with an empty settings object — we'll restore the
        // original text verbatim afterwards.
      }
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e?.code !== "ENOENT") {
        // Unexpected read error; bubble up so the caller knows.
        throw err;
      }
      // File simply doesn't exist yet.
    }

    // Inject thinking level → modelConfigs.generateContentConfig.thinkingLevel
    const modelConfigs = getOrCreateObject(settings, "modelConfigs");
    const generateContentConfig = getOrCreateObject(
      modelConfigs,
      "generateContentConfig",
    );
    generateContentConfig["thinkingLevel"] = mapped;

    await fs.writeFile(file, JSON.stringify(settings, null, 2), "utf8");

    try {
      return await fn();
    } finally {
      if (originalText !== null) {
        // Restore verbatim to preserve whitespace and any fields we didn't touch.
        try {
          await fs.writeFile(file, originalText, "utf8");
        } catch {
          // Best-effort restore; swallow to avoid masking the dispatch result.
        }
      } else {
        // We created the file; remove just our addition.
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
    }
  });
}

function getOrCreateObject(
  parent: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
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

export class GeminiDispatcher implements Dispatcher {
  readonly id = "gemini_cli";
  private readonly thinkingLevel: ThinkingLevel | undefined;
  private readonly configuredModel: string | undefined;

  constructor(svc?: ServiceConfig) {
    this.thinkingLevel = svc?.thinkingLevel;
    this.configuredModel = svc?.model;
  }

  isAvailable(): boolean {
    return true;
  }

  async checkQuota(): Promise<QuotaInfo> {
    // Proactive quota check deferred to R3. The Python version runs a minimal
    // prompt to scrape the stats field — that burns tokens and takes time, so
    // we skip it until needed.
    return { service: "gemini_cli", source: "unknown" };
  }

  async dispatch(
    prompt: string,
    files: string[],
    workingDir: string,
    opts: DispatchOpts = {},
  ): Promise<DispatchResult> {
    const foundPath = await which("gemini", { nothrow: true });
    if (!foundPath) {
      return {
        output: "",
        service: "gemini_cli",
        success: false,
        error: "gemini CLI not found",
      };
    }
    const resolved = await resolveCliCommand("gemini");

    const effectiveModel = opts.modelOverride ?? this.configuredModel;

    const args: string[] = [...resolved.prefixArgs];
    if (effectiveModel) {
      args.push("--model", effectiveModel);
    }
    args.push("-p", prompt, "--output-format", "json");
    for (const file of files) {
      args.push("--file", file);
    }

    // Forward GEMINI_API_KEY if set.
    const extraEnv: Record<string, string> = {};
    const apiKey = process.env["GEMINI_API_KEY"];
    if (apiKey) {
      extraEnv["GEMINI_API_KEY"] = apiKey;
    }

    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    const subOpts: Parameters<typeof runSubprocess>[2] = { timeoutMs };
    if (workingDir) subOpts.cwd = workingDir;
    if (Object.keys(extraEnv).length > 0) subOpts.env = extraEnv;

    // Acquire the settings lock *around* the subprocess invocation so
    // concurrent dispatches cannot race on ~/.gemini/settings.json.
    const sub = await withThinkingOverride(this.thinkingLevel, () =>
      runSubprocess(resolved.command, args, subOpts),
    );

    if (sub.timedOut) {
      return {
        output: sub.stdout,
        service: "gemini_cli",
        success: false,
        error: `Timed out after ${timeoutMs}ms`,
        durationMs: sub.durationMs,
      };
    }

    const parsed = parseGeminiJson(sub.stdout) ?? parseGeminiJson(sub.stderr);
    const parsedText = parsed?.text ?? "";

    if (sub.exitCode === 0) {
      const output =
        parsedText || sub.stdout.trim() || sub.stderr.trim();
      const result: DispatchResult = {
        output,
        service: "gemini_cli",
        success: true,
        durationMs: sub.durationMs,
      };
      if (parsed?.tokensUsed) {
        result.tokensUsed = parsed.tokensUsed;
      }
      return result;
    }

    // Non-zero exit — detect rate limit.
    const combined = `${sub.stdout}\n${sub.stderr}`;
    const { rateLimited, retryAfter } = detectRateLimit(combined);
    const errorDetail =
      sub.stderr.trim() || sub.stdout.trim() || `Exit code ${sub.exitCode}`;

    const result: DispatchResult = {
      output: parsedText || sub.stdout.trim(),
      service: "gemini_cli",
      success: false,
      error: errorDetail,
      durationMs: sub.durationMs,
    };
    if (rateLimited) {
      result.rateLimited = true;
      if (retryAfter !== null) result.retryAfter = retryAfter;
    }
    if (parsed?.tokensUsed) {
      result.tokensUsed = parsed.tokensUsed;
    }
    return result;
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
  const text =
    typeof textCandidate === "string" ? textCandidate.trim() : "";

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

function detectRateLimit(text: string): {
  rateLimited: boolean;
  retryAfter: number | null;
} {
  const lowered = text.toLowerCase();
  const flagged =
    lowered.includes("rate limit") ||
    lowered.includes("quota exceeded") ||
    lowered.includes("resource_exhausted") ||
    lowered.includes("too many requests") ||
    text.includes("429");

  if (!flagged) return { rateLimited: false, retryAfter: null };

  const m = /retry[_\s-]after[:\s]+(\d+(?:\.\d+)?)/i.exec(text);
  const retryAfter = m?.[1] ? Number.parseFloat(m[1]) : null;
  return {
    rateLimited: true,
    retryAfter: retryAfter !== null && Number.isFinite(retryAfter) ? retryAfter : null,
  };
}
