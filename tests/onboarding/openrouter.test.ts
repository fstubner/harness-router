/**
 * Tests for the OpenRouter catalog client.
 *
 * The catalog is convenience for the wizard, not a routing dependency, so
 * the tests focus on:
 *   - happy-path parsing (filter to the 3 providers we care about)
 *   - graceful handling of every failure mode (404, network error, malformed
 *     JSON, abort)
 *   - returning empty rather than throwing — callers must always be able to
 *     fall through to free-text input
 */

import { describe, expect, it, vi } from "vitest";

import {
  fetchOpenRouterCatalog,
  fetchOpenRouterCatalogVerbose,
} from "../../src/onboarding/openrouter.js";

function mockFetch(impl: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    let u: string;
    if (typeof url === "string") u = url;
    else if (url instanceof URL) u = url.href;
    else u = url.url;
    return impl(u, init);
  }) as unknown as typeof fetch;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const sampleCatalog = {
  data: [
    { id: "anthropic/claude-opus-4.7", name: "Claude Opus 4.7", context_length: 200000 },
    { id: "anthropic/claude-sonnet-4.6", name: "Claude Sonnet 4.6", context_length: 200000 },
    { id: "openai/gpt-5.4", name: "GPT-5.4", context_length: 1_000_000 },
    { id: "google/gemini-2.5-pro", name: "Gemini 2.5 Pro", context_length: 2_000_000 },
    // Non-target providers — should be filtered out:
    { id: "meta-llama/llama-3-70b", name: "Llama 3 70B" },
    { id: "mistralai/mistral-large", name: "Mistral Large" },
    // Malformed entries — should be skipped:
    { id: "no-slash" },
    { id: "" },
    null,
    { /* missing id */ name: "x" },
  ],
};

describe("fetchOpenRouterCatalog — happy path", () => {
  it("returns the 4 supported-provider models, ignoring others and malformed rows", async () => {
    const fetchFn = mockFetch(() => jsonResponse(sampleCatalog));
    const models = await fetchOpenRouterCatalog({ fetchFn });
    expect(models.map((m) => m.canonical).sort()).toEqual([
      "claude-opus-4.7",
      "claude-sonnet-4.6",
      "gemini-2.5-pro",
      "gpt-5.4",
    ]);
  });

  it("strips the provider prefix from canonical names", async () => {
    const fetchFn = mockFetch(() => jsonResponse(sampleCatalog));
    const models = await fetchOpenRouterCatalog({ fetchFn });
    for (const m of models) {
      expect(m.canonical).not.toContain("/");
      expect(m.openrouter_id).toContain("/");
    }
  });

  it("classifies each model with a recognised provider", async () => {
    const fetchFn = mockFetch(() => jsonResponse(sampleCatalog));
    const models = await fetchOpenRouterCatalog({ fetchFn });
    const providers = new Set(models.map((m) => m.provider));
    expect(providers).toEqual(new Set(["anthropic", "openai", "google"]));
  });

  it("preserves context_window when present", async () => {
    const fetchFn = mockFetch(() => jsonResponse(sampleCatalog));
    const models = await fetchOpenRouterCatalog({ fetchFn });
    const opus = models.find((m) => m.canonical === "claude-opus-4.7");
    expect(opus?.context_window).toBe(200000);
  });
});

describe("fetchOpenRouterCatalog — failure modes (always return empty)", () => {
  it("returns [] on HTTP 500", async () => {
    const fetchFn = mockFetch(() => jsonResponse({ error: "boom" }, 500));
    const models = await fetchOpenRouterCatalog({ fetchFn });
    expect(models).toEqual([]);
  });

  it("returns [] on network error", async () => {
    const fetchFn = mockFetch(() => {
      throw new Error("ECONNREFUSED");
    });
    const models = await fetchOpenRouterCatalog({ fetchFn });
    expect(models).toEqual([]);
  });

  it("returns [] on malformed JSON shape", async () => {
    const fetchFn = mockFetch(() => jsonResponse({ wrong: "shape" }));
    const models = await fetchOpenRouterCatalog({ fetchFn });
    expect(models).toEqual([]);
  });

  it("returns [] when the response is not JSON-parseable", async () => {
    const fetchFn = mockFetch(
      () =>
        new Response("<html>not json</html>", {
          headers: { "content-type": "text/html" },
        }),
    );
    const models = await fetchOpenRouterCatalog({ fetchFn });
    expect(models).toEqual([]);
  });
});

describe("fetchOpenRouterCatalogVerbose", () => {
  it("returns an error string on 4xx so callers can show diagnostics", async () => {
    const fetchFn = mockFetch(() => jsonResponse({}, 404));
    const result = await fetchOpenRouterCatalogVerbose({ fetchFn });
    expect(result.models).toEqual([]);
    expect(result.error).toMatch(/404/);
  });

  it("returns no error on success even when the catalog filters to 0 models", async () => {
    // Catalog with only non-target providers — valid response, just empty after filter.
    const fetchFn = mockFetch(() =>
      jsonResponse({ data: [{ id: "meta-llama/llama-3-70b", name: "Llama" }] }),
    );
    const result = await fetchOpenRouterCatalogVerbose({ fetchFn });
    expect(result.models).toEqual([]);
    expect(result.error).toBeUndefined();
  });
});

describe("timeout", () => {
  it("aborts after the configured timeout", async () => {
    // fetch that never resolves until aborted
    const fetchFn = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    }) as unknown as typeof fetch;
    const result = await fetchOpenRouterCatalogVerbose({ fetchFn, timeoutMs: 50 });
    expect(result.models).toEqual([]);
    expect(result.error).toBeDefined();
  });
});
