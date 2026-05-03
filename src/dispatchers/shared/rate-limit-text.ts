/**
 * Text-based rate-limit detection for CLI dispatchers.
 *
 * CLI harnesses (codex, cursor, gemini, claude-code) surface rate-limit /
 * quota errors as freeform stdout/stderr text rather than HTTP headers, so
 * we have to keyword-scan. This is the single source of truth — every CLI
 * dispatcher should call `detectRateLimitInText(combinedOutput)` and lift
 * the result onto its `DispatchResult`.
 *
 * Header-based detection (HTTP dispatchers) lives in `rate-limit-headers.ts`
 * and is unrelated. The two files are kept separate because their inputs
 * and semantics are different: structured headers vs. unstructured text.
 *
 * Keyword set is the union of every signal observed across providers:
 *   - "rate limit" / "rate-limit" / "ratelimited"   (generic phrasing)
 *   - "too many requests"                           (HTTP 429 status text)
 *   - "quota exceeded" / "usage limit"              (provider-specific)
 *   - "resource_exhausted"                          (Google / Gemini gRPC)
 *   - "ratelimiterror"                              (OpenAI SDK error name)
 *   - "429"                                         (status code in logs)
 *   - "retry-after: …"                              (Anthropic / others)
 *
 * History: cursor.ts and gemini.ts each had a near-duplicate of this helper
 * with diverged keyword sets — cursor missed `resource_exhausted`, gemini
 * missed `ratelimiterror`. Codex and claude-code had no detection at all.
 * This unified version was extracted to fix both gaps.
 */

export interface RateLimitDetection {
  rateLimited: boolean;
  /** Seconds to wait before retrying. null if no hint was found. */
  retryAfter: number | null;
}

const RATE_LIMIT_KEYWORDS_LOWER = [
  "rate limit",
  "rate-limit",
  "ratelimited",
  "ratelimiterror",
  "too many requests",
  "quota exceeded",
  "usage limit",
  "resource_exhausted",
] as const;

// Anchored 429 detection — bare "429" matches timestamps and IDs in long
// log dumps, so we require it at a word boundary AND in a context where
// HTTP status codes typically appear ("status 429", " 429 ", "HTTP 429",
// "code: 429"). The `\b429\b` form handles all of those without matching
// e.g. "request_id=42912ab".
const STATUS_429_RE = /(?:^|[\s:=([])429(?=\b)/;

/**
 * Inspect freeform CLI output (combined stdout + stderr) for rate-limit
 * signals. If found, also try to extract a retry-after hint.
 *
 * Conservative: returns `rateLimited: false` when the text is empty or
 * contains no recognised keyword, so callers can short-circuit on success.
 */
export function detectRateLimitInText(text: string): RateLimitDetection {
  if (!text) return { rateLimited: false, retryAfter: null };

  const lowered = text.toLowerCase();
  const flagged =
    RATE_LIMIT_KEYWORDS_LOWER.some((kw) => lowered.includes(kw)) || STATUS_429_RE.test(text);

  if (!flagged) return { rateLimited: false, retryAfter: null };

  // Try to lift a retry-after hint. Common shapes from the wild:
  //   "retry-after: 30"        (Anthropic, OpenAI)
  //   "Retry after 42 seconds" (some Gemini errors)
  //   "retry_after: 12.5"      (Google ServiceError)
  //
  // Anchoring matters: the previous `retry[_\s-]?after[:\s]+` matched
  // `retry-after-id: 12345` because "after" was followed by `-` (in the
  // char class) then `id` then `:`. We require a word-boundary AFTER
  // "after" and either `:` or whitespace as the value separator, which
  // rejects `retry-after-id` while still accepting all three real shapes.
  const m = /\bretry[_\s-]?after\b[:\s]+(\d+(?:\.\d+)?)/i.exec(text);
  const raw = m?.[1] ? Number.parseFloat(m[1]) : null;
  const retryAfter = raw !== null && Number.isFinite(raw) && raw >= 0 ? raw : null;
  return { rateLimited: true, retryAfter };
}
