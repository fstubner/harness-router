/**
 * OpenAI-compatible HTTP dispatcher for coding-agent-mcp.
 *
 * Handles any provider that speaks POST /v1/chat/completions:
 *   - Ollama        (http://localhost:11434/v1)
 *   - LM Studio     (http://localhost:1234/v1)
 *   - OpenRouter    (https://openrouter.ai/api/v1)
 *   - OpenAI API    (https://api.openai.com/v1)
 *   - Any other OpenAI-compatible endpoint
 *
 * Transport: global `fetch` (Node 24+). No subprocess, no extra deps.
 * Quota:     reactive — parses x-ratelimit-* headers on every response.
 *            Local endpoints (Ollama, LM Studio) have no rate limits.
 */

import type { DispatchResult, QuotaInfo, ServiceConfig } from "../types.js";
import type { Dispatcher, DispatchOpts } from "./base.js";
import { parseRetryAfter } from "./shared/rate-limit-headers.js";

const CHAT_PATH = "/v1/chat/completions";
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_SYSTEM_PROMPT =
  "You are an expert software engineer. " +
  "Respond with clear, working code and concise explanations.";
const _MAX_FILE_BYTES = 512 * 1024; // 512 KB per file

interface ChatChoice {
  message?: {
    content?: unknown;
    role?: unknown;
  };
}

interface ChatCompletionResponse {
  choices?: ChatChoice[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  error?: {
    message?: unknown;
    type?: unknown;
  };
}

export class OpenAICompatibleDispatcher implements Dispatcher {
  readonly id: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly apiKey: string;
  private readonly thinkingLevel?: string | undefined;

  constructor(svc: ServiceConfig) {
    this.id = svc.name;
    const base = svc.baseUrl ?? "";
    this.baseUrl = base.replace(/\/+$/, "");
    this.model = svc.model ?? "";
    this.apiKey = svc.apiKey ?? "";
    if (svc.thinkingLevel) this.thinkingLevel = svc.thinkingLevel;
  }

  isAvailable(): boolean {
    return true;
  }

  async checkQuota(): Promise<QuotaInfo> {
    return { service: this.id, source: "unknown" };
  }

  async dispatch(
    prompt: string,
    files: string[],
    _workingDir: string,
    opts: DispatchOpts = {},
  ): Promise<DispatchResult> {
    const start = Date.now();

    const fullPrompt = await buildPromptWithFiles(prompt, files);
    const url = `${this.baseUrl}${CHAT_PATH}`;

    const model = opts.modelOverride ?? this.model;

    const body: Record<string, unknown> = {
      model,
      messages: [
        { role: "system", content: DEFAULT_SYSTEM_PROMPT },
        { role: "user", content: fullPrompt },
      ],
      stream: false,
    };
    if (this.thinkingLevel) {
      // OpenAI reasoning models (o-series, gpt-5.x) accept reasoning_effort.
      // Local endpoints (Ollama/LM Studio) silently ignore unknown fields.
      body["reasoning_effort"] = this.thinkingLevel.toLowerCase();
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
    };
    if (this.apiKey) {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }

    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    // Avoid keeping the event loop alive just for a request timeout.
    timer.unref?.();

    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      const errMsg = err instanceof Error ? err.message : String(err);
      const aborted =
        (err as { name?: string } | null)?.name === "AbortError";
      return {
        output: "",
        service: this.id,
        success: false,
        error: aborted ? `Timed out after ${timeoutMs}ms` : errMsg,
        durationMs: Date.now() - start,
      };
    }
    clearTimeout(timer);

    const responseHeaders = headersToObject(res.headers);
    const durationMs = Date.now() - start;

    let parsedBody: ChatCompletionResponse | null = null;
    let rawBody = "";
    try {
      rawBody = await res.text();
      if (rawBody) {
        try {
          parsedBody = JSON.parse(rawBody) as ChatCompletionResponse;
        } catch {
          parsedBody = null;
        }
      }
    } catch {
      // Body read failed — treat as empty.
    }

    if (res.status === 429) {
      const retryAfter = parseRetryAfter(responseHeaders);
      const result: DispatchResult = {
        output: "",
        service: this.id,
        success: false,
        error: `Rate limited by ${this.id}`,
        rateLimited: true,
        rateLimitHeaders: responseHeaders,
        durationMs,
      };
      if (retryAfter !== null) {
        result.retryAfter = retryAfter;
      }
      return result;
    }

    if (res.status >= 400) {
      const errMessage = extractErrorMessage(parsedBody, rawBody);
      return {
        output: "",
        service: this.id,
        success: false,
        error: `HTTP ${res.status}: ${errMessage}`,
        durationMs,
        rateLimitHeaders: responseHeaders,
      };
    }

    const content = parsedBody ? extractContent(parsedBody) : null;
    if (content === null) {
      return {
        output: "",
        service: this.id,
        success: false,
        error: `Unexpected response shape: ${rawBody.slice(0, 300)}`,
        durationMs,
        rateLimitHeaders: responseHeaders,
      };
    }

    const result: DispatchResult = {
      output: content,
      service: this.id,
      success: true,
      durationMs,
      // Carries x-ratelimit-* so quota tracker can update proactively.
      rateLimitHeaders: responseHeaders,
    };

    if (parsedBody?.usage) {
      const input = parsedBody.usage.prompt_tokens;
      const output = parsedBody.usage.completion_tokens;
      if (typeof input === "number" && typeof output === "number") {
        result.tokensUsed = { input, output };
      }
    }

    return result;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function headersToObject(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  h.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

function extractContent(body: ChatCompletionResponse): string | null {
  const choices = body.choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first = choices[0];
  if (!first || typeof first !== "object") return null;
  const msg = first.message;
  if (!msg || typeof msg !== "object") return null;
  const content = (msg as { content?: unknown }).content;
  return typeof content === "string" ? content : null;
}

function extractErrorMessage(
  body: ChatCompletionResponse | null,
  rawBody: string,
): string {
  if (body?.error) {
    if (typeof body.error.message === "string") return body.error.message;
  }
  return rawBody.slice(0, 200) || "(empty body)";
}

async function buildPromptWithFiles(
  prompt: string,
  files: string[],
): Promise<string> {
  if (files.length === 0) return prompt;
  const parts: string[] = [prompt];
  const { stat, readFile } = await import("node:fs/promises");
  const { extname } = await import("node:path");
  for (const filePath of files) {
    try {
      const info = await stat(filePath);
      if (!info.isFile()) {
        parts.push(`\n# Not a file: ${filePath}`);
        continue;
      }
      if (info.size > _MAX_FILE_BYTES) {
        parts.push(
          `\n# Skipped ${filePath}: file too large (${Math.floor(
            info.size / 1024,
          )} KB > ${_MAX_FILE_BYTES / 1024} KB limit)`,
        );
        continue;
      }
      const content = await readFile(filePath, "utf8");
      const ext = extname(filePath).replace(/^\./, "");
      parts.push(`\n\n\`\`\`${ext}\n# ${filePath}\n${content}\n\`\`\``);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
        parts.push(`\n# File not found: ${filePath}`);
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        parts.push(`\n# Could not read ${filePath}: ${msg}`);
      }
    }
  }
  return parts.join("\n");
}
