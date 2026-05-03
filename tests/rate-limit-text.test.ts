/**
 * Tests for the unified `detectRateLimitInText` helper.
 *
 * Coverage focus: provider-specific phrasings + the 429 anchoring fix.
 * This is the single source of truth used by codex/cursor/gemini/
 * claude-code dispatchers, so a regression here regresses every CLI path.
 */

import { describe, expect, it } from "vitest";
import { detectRateLimitInText } from "../src/dispatchers/shared/rate-limit-text.js";

describe("detectRateLimitInText", () => {
  it("returns false on empty input", () => {
    expect(detectRateLimitInText("")).toEqual({ rateLimited: false, retryAfter: null });
  });

  it("returns false when no keyword matches", () => {
    const r = detectRateLimitInText("Reading additional input from stdin...");
    expect(r.rateLimited).toBe(false);
  });

  it("flags generic 'rate limit' phrasing", () => {
    const r = detectRateLimitInText("Error: rate limit exceeded for org");
    expect(r.rateLimited).toBe(true);
  });

  it("flags hyphenated 'rate-limit'", () => {
    expect(detectRateLimitInText("rate-limited until tomorrow").rateLimited).toBe(true);
  });

  it("flags Google's RESOURCE_EXHAUSTED (gemini)", () => {
    const r = detectRateLimitInText("status: RESOURCE_EXHAUSTED quota for project foo");
    expect(r.rateLimited).toBe(true);
  });

  it("flags 'too many requests' (HTTP 429 status text)", () => {
    expect(detectRateLimitInText("HTTP 429 Too Many Requests").rateLimited).toBe(true);
  });

  it("flags OpenAI SDK 'RateLimitError'", () => {
    expect(detectRateLimitInText("openai.RateLimitError: rate-limited").rateLimited).toBe(true);
  });

  it("flags 'quota exceeded'", () => {
    expect(detectRateLimitInText("Daily quota exceeded.").rateLimited).toBe(true);
  });

  it("flags 'usage limit'", () => {
    expect(detectRateLimitInText("you have hit your hourly usage limit").rateLimited).toBe(true);
  });

  // 429 anchoring — the subtle bit.

  it("flags '429' when it appears as an HTTP status (delimited by space)", () => {
    expect(detectRateLimitInText("HTTP 429 returned").rateLimited).toBe(true);
  });

  it("flags '429' after a colon (e.g. `status: 429`)", () => {
    expect(detectRateLimitInText("status: 429").rateLimited).toBe(true);
  });

  it("flags '429' at start of string", () => {
    expect(detectRateLimitInText("429 Too Many Requests").rateLimited).toBe(true);
  });

  it("does NOT flag '429' inside an unrelated identifier", () => {
    // Bare \b would match this — STATUS_429_RE's leading-edge anchor must not.
    const r = detectRateLimitInText("request_id=42912abc done");
    expect(r.rateLimited).toBe(false);
  });

  it("does NOT flag a timestamp containing '429'", () => {
    // e.g. 2026-04-29T23:38:07.429Z — preceded by '.', not a status delimiter.
    const r = detectRateLimitInText("2026-04-29T23:38:07.429Z log message");
    expect(r.rateLimited).toBe(false);
  });

  // Retry-after extraction.

  it("extracts retry-after when present (`retry-after: 30`)", () => {
    const r = detectRateLimitInText("Error: rate limit. retry-after: 30");
    expect(r).toEqual({ rateLimited: true, retryAfter: 30 });
  });

  it("extracts fractional retry-after (`retry_after: 12.5`)", () => {
    const r = detectRateLimitInText("RESOURCE_EXHAUSTED retry_after: 12.5");
    expect(r.retryAfter).toBeCloseTo(12.5);
  });

  it("returns retryAfter=null when keyword matches but no hint is present", () => {
    const r = detectRateLimitInText("rate limit hit, please slow down");
    expect(r).toEqual({ rateLimited: true, retryAfter: null });
  });

  it("rejects negative retry-after values", () => {
    const r = detectRateLimitInText("rate limit retry-after: -5");
    // Negative values are nonsense — we treat them as absent.
    expect(r.retryAfter).toBeNull();
  });

  it("does NOT extract retry-after-id (matches the real retry-after when both are present)", () => {
    // Regression: the previous `retry[_\s-]?after[:\s]+(\d+)` regex
    // matched the FIRST occurrence of `retry-after-id: 12345` because the
    // `-` between "after" and "id" was inside the char class. The fix
    // requires a word boundary after "after". We keep the keyword scan
    // flagged either way (the line contains "rate limit"), but the
    // extracted value should be 30, not 12345.
    const r = detectRateLimitInText(
      "Error: rate limit hit. retry-after-id: 12345  retry-after: 30",
    );
    expect(r.rateLimited).toBe(true);
    expect(r.retryAfter).toBe(30);
  });

  it("does NOT match `retry-after-id` alone (no real retry-after present)", () => {
    // If the text only mentions `retry-after-id`, we should NOT extract a
    // value — that ID is not a delay.
    const r = detectRateLimitInText("Error: rate limit hit. retry-after-id: 12345");
    expect(r.rateLimited).toBe(true);
    expect(r.retryAfter).toBeNull();
  });
});
