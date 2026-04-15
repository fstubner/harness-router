/**
 * Cursor headless CLI dispatcher for coding-agent-mcp.
 *
 * Dispatch:  agent -p --trust --workspace <dir> --output-format json "<prompt>"
 *                  [--model <override>]
 *
 *   agent is the Cursor headless CLI (installed via cursor.com/install). The
 *   command name is literally 'agent', not 'cursor'.
 *   -p / --print            Non-interactive, prints response and exits.
 *   --trust                 Skip the workspace-trust prompt (required for headless).
 *   --workspace <dir>       Set the workspace directory. Defaults to HOME when the
 *                           caller did not supply one — matches the Python reference.
 *   --output-format json    Emits a single JSON object with a top-level "result".
 *
 * Auth: reads CURSOR_API_KEY from process.env and forwards it to the subprocess.
 * Quota: no proactive quota endpoint; reactive only via circuit breaker.
 */

import os from "node:os";
import which from "which";
import type { DispatchResult, QuotaInfo } from "../types.js";
import type { Dispatcher, DispatchOpts } from "./base.js";
import { runSubprocess } from "./shared/subprocess.js";
import { resolveCliCommand } from "./shared/windows-cmd.js";

const DEFAULT_TIMEOUT_MS = 600_000; // 10 minutes

interface CursorJsonResult {
  result?: unknown;
  output?: unknown;
  text?: unknown;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    prompt_tokens?: number;
    completion_tokens?: number;
  };
}

export class CursorDispatcher implements Dispatcher {
  readonly id = "cursor";

  isAvailable(): boolean {
    // Synchronous check; runtime availability is re-verified at dispatch time.
    return true;
  }

  async checkQuota(): Promise<QuotaInfo> {
    // No proactive quota API for the Cursor CLI — reactive only. Deferred to R3.
    return { service: "cursor", source: "unknown" };
  }

  async dispatch(
    prompt: string,
    files: string[],
    workingDir: string,
    opts: DispatchOpts = {},
  ): Promise<DispatchResult> {
    const foundPath = await which("agent", { nothrow: true });
    if (!foundPath) {
      return {
        output: "",
        service: "cursor",
        success: false,
        error: "agent CLI not found — install via cursor.com/install",
      };
    }
    const resolved = await resolveCliCommand("agent");

    // Inline file paths so the Cursor agent is aware of them.
    let fullPrompt = prompt;
    if (files.length > 0) {
      const fileList = files.map((p) => `  - ${p}`).join("\n");
      fullPrompt = `${prompt}\n\nFocus on these files:\n${fileList}`;
    }

    // If the caller didn't supply a workingDir, default to HOME (matches Python).
    const effectiveDir = workingDir || os.homedir();

    const args: string[] = [
      ...resolved.prefixArgs,
      "-p",
      "--trust",
      "--workspace",
      effectiveDir,
      "--output-format",
      "json",
      fullPrompt,
    ];

    if (opts.modelOverride) {
      args.push("--model", opts.modelOverride);
    }

    // Forward CURSOR_API_KEY if the caller set it in process.env.
    const extraEnv: Record<string, string> = {};
    const apiKey = process.env["CURSOR_API_KEY"];
    if (apiKey) {
      extraEnv["CURSOR_API_KEY"] = apiKey;
    }

    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    const subOpts: Parameters<typeof runSubprocess>[2] = {
      timeoutMs,
      cwd: effectiveDir,
    };
    if (Object.keys(extraEnv).length > 0) subOpts.env = extraEnv;
    const sub = await runSubprocess(resolved.command, args, subOpts);

    if (sub.timedOut) {
      return {
        output: sub.stdout,
        service: "cursor",
        success: false,
        error: `Timed out after ${timeoutMs}ms`,
        durationMs: sub.durationMs,
      };
    }

    // Try stdout first; fall back to stderr (cmd /c can shuffle streams).
    const parsed = parseCursorJson(sub.stdout) ?? parseCursorJson(sub.stderr);
    const parsedText = parsed?.text ?? null;

    if (sub.exitCode === 0 && parsedText) {
      const result: DispatchResult = {
        output: parsedText,
        service: "cursor",
        success: true,
        durationMs: sub.durationMs,
      };
      if (parsed?.tokensUsed) {
        result.tokensUsed = parsed.tokensUsed;
      }
      return result;
    }

    // Error path — detect rate limit in combined output.
    const combined = `${sub.stdout}\n${sub.stderr}`;
    const { rateLimited, retryAfter } = detectRateLimit(combined);

    const errorDetail =
      sub.stderr.trim() || sub.stdout.trim() || `Exit code ${sub.exitCode}`;

    const result: DispatchResult = {
      output: parsedText ?? errorDetail,
      service: "cursor",
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

interface ParsedCursorOutput {
  text: string | null;
  tokensUsed?: { input: number; output: number };
}

/**
 * Parse `agent --output-format json` output.
 *
 * The CLI emits a single JSON object with a top-level "result" field. Some
 * variants may place the text under "output" or "text" instead — we check all.
 *
 * Returns null only when `raw` is empty. If `raw` is non-empty but unparseable,
 * returns { text: null } so callers can distinguish "no output" from "bad output".
 */
function parseCursorJson(raw: string): ParsedCursorOutput | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // The JSON may occupy a single line or span multiple lines. Try line-by-line
  // first (matches Python), then fall back to the whole blob.
  const lines = trimmed.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    const parsed = tryParseJsonObj(line);
    if (parsed) return parsed;
  }
  return tryParseJsonObj(trimmed) ?? { text: null };
}

function tryParseJsonObj(s: string): ParsedCursorOutput | null {
  let data: unknown;
  try {
    data = JSON.parse(s);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object") return null;

  const obj = data as CursorJsonResult;
  const textCandidate = obj.result ?? obj.output ?? obj.text;
  const text =
    typeof textCandidate === "string" && textCandidate.length > 0
      ? textCandidate.trim()
      : null;

  const parsed: ParsedCursorOutput = { text };

  if (obj.usage) {
    const input = obj.usage.input_tokens ?? obj.usage.prompt_tokens;
    const output = obj.usage.output_tokens ?? obj.usage.completion_tokens;
    if (typeof input === "number" && typeof output === "number") {
      parsed.tokensUsed = { input, output };
    }
  }

  return parsed;
}

/**
 * Scan combined stdout+stderr for rate-limit markers. Mirrors the Python
 * reference's _detect_rate_limit. Retry-after is an optional numeric value;
 * returns null when no explicit delay was found.
 */
function detectRateLimit(text: string): {
  rateLimited: boolean;
  retryAfter: number | null;
} {
  const lowered = text.toLowerCase();
  const flagged =
    lowered.includes("rate limit") ||
    lowered.includes("too many requests") ||
    lowered.includes("quota exceeded") ||
    lowered.includes("ratelimiterror") ||
    text.includes("429");

  if (!flagged) return { rateLimited: false, retryAfter: null };

  const m = /retry[_\s-]after[:\s]+(\d+(?:\.\d+)?)/i.exec(text);
  const retryAfter = m?.[1] ? Number.parseFloat(m[1]) : null;
  return {
    rateLimited: true,
    retryAfter: retryAfter !== null && Number.isFinite(retryAfter) ? retryAfter : null,
  };
}
