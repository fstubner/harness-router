import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ServiceConfig } from "../../src/types.js";

const { OpenAICompatibleDispatcher } = await import("../../src/dispatchers/openai-compatible.js");

type FetchMock = ReturnType<typeof vi.fn>;

const realFetch = globalThis.fetch;
let fetchMock: FetchMock;

function baseSvc(overrides: Partial<ServiceConfig> = {}): ServiceConfig {
  return {
    name: "test-provider",
    enabled: true,
    type: "openai_compatible",
    tier: 1,
    weight: 1,
    cliCapability: 0,
    escalateOn: [],
    capabilities: {},
    baseUrl: "https://api.example.com/v1",
    apiKey: "sk-test-abc",
    model: "test-model",
    ...overrides,
  };
}

function mockJsonResponse(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  const status = init.status ?? 200;
  const headers = new Headers({
    "content-type": "application/json",
    ...(init.headers ?? {}),
  });
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers,
  });
}

function chatCompletion(content: string): Record<string, unknown> {
  return {
    id: "cmpl-1",
    object: "chat.completion",
    created: 1,
    model: "test-model",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 11, completion_tokens: 13, total_tokens: 24 },
  };
}

beforeEach(() => {
  fetchMock = vi.fn();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("OpenAICompatibleDispatcher", () => {
  it("POSTs to <baseUrl>/chat/completions with Bearer auth and expected body", async () => {
    fetchMock.mockResolvedValue(mockJsonResponse(chatCompletion("hello there")));

    const d = new OpenAICompatibleDispatcher(baseSvc());
    const res = await d.dispatch("say hi", [], "");

    expect(res.success).toBe(true);
    expect(res.output).toBe("hello there");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0] as [
      string,
      RequestInit & { headers: Record<string, string> },
    ];
    expect(url).toBe("https://api.example.com/v1/chat/completions");
    expect(init.method).toBe("POST");
    expect(init.headers["Authorization"]).toBe("Bearer sk-test-abc");
    expect(init.headers["Content-Type"]).toBe("application/json");

    const parsedBody = JSON.parse(init.body as string) as {
      model: string;
      messages: { role: string; content: string }[];
      stream: boolean;
    };
    expect(parsedBody.model).toBe("test-model");
    expect(parsedBody.stream).toBe(false);
    expect(parsedBody.messages[0]?.role).toBe("system");
    expect(parsedBody.messages[1]?.role).toBe("user");
    expect(parsedBody.messages[1]?.content).toContain("say hi");
  });

  it("strips trailing slashes from baseUrl", async () => {
    fetchMock.mockResolvedValue(mockJsonResponse(chatCompletion("ok")));

    const d = new OpenAICompatibleDispatcher(baseSvc({ baseUrl: "https://api.example.com/v1///" }));
    await d.dispatch("go", [], "");

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe("https://api.example.com/v1/chat/completions");
  });

  it("populates usage.prompt/completion tokens into tokensUsed", async () => {
    fetchMock.mockResolvedValue(mockJsonResponse(chatCompletion("ok")));

    const d = new OpenAICompatibleDispatcher(baseSvc());
    const res = await d.dispatch("go", [], "");

    expect(res.tokensUsed).toEqual({ input: 11, output: 13 });
  });

  it("uses modelOverride when provided", async () => {
    fetchMock.mockResolvedValue(mockJsonResponse(chatCompletion("ok")));

    const d = new OpenAICompatibleDispatcher(baseSvc());
    await d.dispatch("go", [], "", { modelOverride: "override-model" });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit & { body: string }];
    const body = JSON.parse(init.body) as { model: string };
    expect(body.model).toBe("override-model");
  });

  it("returns rateLimited:true with retryAfter from Retry-After header on 429", async () => {
    fetchMock.mockResolvedValue(
      mockJsonResponse(
        { error: { message: "Too many requests" } },
        {
          status: 429,
          headers: {
            "retry-after": "42",
            "x-ratelimit-remaining": "0",
          },
        },
      ),
    );

    const d = new OpenAICompatibleDispatcher(baseSvc());
    const res = await d.dispatch("go", [], "");

    expect(res.success).toBe(false);
    expect(res.rateLimited).toBe(true);
    expect(res.retryAfter).toBe(42);
    expect(res.rateLimitHeaders?.["retry-after"]).toBe("42");
    expect(res.rateLimitHeaders?.["x-ratelimit-remaining"]).toBe("0");
  });

  it("does not set retryAfter when Retry-After header is absent on 429", async () => {
    fetchMock.mockResolvedValue(
      mockJsonResponse({ error: { message: "Slow down" } }, { status: 429 }),
    );

    const d = new OpenAICompatibleDispatcher(baseSvc());
    const res = await d.dispatch("go", [], "");

    expect(res.success).toBe(false);
    expect(res.rateLimited).toBe(true);
    expect(res.retryAfter).toBeUndefined();
  });

  it("returns a formatted error message on HTTP 400+", async () => {
    fetchMock.mockResolvedValue(
      mockJsonResponse({ error: { message: "invalid model" } }, { status: 400 }),
    );

    const d = new OpenAICompatibleDispatcher(baseSvc());
    const res = await d.dispatch("go", [], "");

    expect(res.success).toBe(false);
    expect(res.rateLimited).toBeUndefined();
    expect(res.error).toBe("HTTP 400: invalid model");
  });

  it("includes reasoning_effort in body when thinkingLevel is set", async () => {
    fetchMock.mockResolvedValue(mockJsonResponse(chatCompletion("ok")));

    const d = new OpenAICompatibleDispatcher(baseSvc({ thinkingLevel: "high" }));
    await d.dispatch("go", [], "");

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit & { body: string }];
    const body = JSON.parse(init.body) as { reasoning_effort?: string };
    expect(body.reasoning_effort).toBe("high");
  });

  it("omits Authorization header when apiKey is empty (local endpoints)", async () => {
    fetchMock.mockResolvedValue(mockJsonResponse(chatCompletion("ok")));

    const d = new OpenAICompatibleDispatcher(
      baseSvc({
        apiKey: "",
        baseUrl: "http://localhost:11434/v1",
      }),
    );
    await d.dispatch("go", [], "");

    const [url, init] = fetchMock.mock.calls[0] as [
      string,
      RequestInit & { headers: Record<string, string> },
    ];
    expect(url).toBe("http://localhost:11434/v1/chat/completions");
    expect(init.headers["Authorization"]).toBeUndefined();
  });

  it("reports network errors with the underlying message", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));

    const d = new OpenAICompatibleDispatcher(baseSvc());
    const res = await d.dispatch("go", [], "");

    expect(res.success).toBe(false);
    expect(res.error).toMatch(/ECONNREFUSED/);
  });

  it("uses svc.name as the dispatcher id", () => {
    const d = new OpenAICompatibleDispatcher(baseSvc({ name: "openrouter" }));
    expect(d.id).toBe("openrouter");
    expect(d.isAvailable()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// SSE streaming path (audit pass B: GAP — was completely untested)
// ---------------------------------------------------------------------------

/**
 * Build a Response whose body is a ReadableStream that emits each SSE
 * frame in sequence. Used to drive the streaming path with realistic
 * `data: {…}\n\n` framing.
 */
function sseResponse(frames: string[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      for (const f of frames) controller.enqueue(enc.encode(f));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: new Headers({ "content-type": "text/event-stream" }),
  });
}

function frame(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

describe("OpenAICompatibleDispatcher.stream — SSE", () => {
  it("yields stdout chunks for each delta and a completion at end-of-stream", async () => {
    fetchMock.mockResolvedValue(
      sseResponse([
        frame({ choices: [{ delta: { content: "Hello " } }] }),
        frame({ choices: [{ delta: { content: "world" } }] }),
        frame({ usage: { prompt_tokens: 5, completion_tokens: 2 } }),
        "data: [DONE]\n\n",
      ]),
    );

    const d = new OpenAICompatibleDispatcher(baseSvc());
    const events: Array<{ type: string; chunk?: string }> = [];
    let final:
      | { output: string; success: boolean; tokensUsed?: { input: number; output: number } }
      | undefined;
    for await (const evt of d.stream("say hi", [], "")) {
      if (evt.type === "completion") final = evt.result;
      else events.push(evt as { type: string; chunk?: string });
    }
    // Two text deltas surface as live stdout events.
    expect(events.map((e) => e.type)).toEqual(["stdout", "stdout"]);
    expect(events[0]!.chunk).toBe("Hello ");
    expect(events[1]!.chunk).toBe("world");
    // Completion has the concatenated output and lifts usage.
    expect(final?.success).toBe(true);
    expect(final?.output).toBe("Hello world");
    expect(final?.tokensUsed).toEqual({ input: 5, output: 2 });
  });

  it("sends `stream: true` in the request body", async () => {
    fetchMock.mockResolvedValue(sseResponse(["data: [DONE]\n\n"]));
    const d = new OpenAICompatibleDispatcher(baseSvc());
    for await (const _ of d.stream("hi", [], "")) {
      // drain
    }
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit & { body: string }];
    const body = JSON.parse(init.body) as { stream: boolean };
    expect(body.stream).toBe(true);
  });

  it("flags rate-limited (429) responses with retryAfter", async () => {
    const r = new Response(JSON.stringify({ error: { message: "Slow down" } }), {
      status: 429,
      headers: new Headers({ "content-type": "application/json", "retry-after": "30" }),
    });
    fetchMock.mockResolvedValue(r);
    const d = new OpenAICompatibleDispatcher(baseSvc());
    let final: { rateLimited?: boolean; retryAfter?: number } | undefined;
    for await (const evt of d.stream("hi", [], "")) {
      if (evt.type === "completion") final = evt.result;
    }
    expect(final?.rateLimited).toBe(true);
    expect(final?.retryAfter).toBe(30);
  });

  it("returns an HTTP-N error completion for non-2xx", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "bad request" } }), { status: 400 }),
    );
    const d = new OpenAICompatibleDispatcher(baseSvc());
    let final: { success: boolean; error?: string } | undefined;
    for await (const evt of d.stream("hi", [], "")) {
      if (evt.type === "completion") final = evt.result;
    }
    expect(final?.success).toBe(false);
    expect(final?.error).toMatch(/HTTP 400.*bad request/i);
  });

  it("flushes a trailing frame that lacks the terminating `\\n\\n`", async () => {
    // Tests the buffer.trim() flush path at the end of the stream.
    fetchMock.mockResolvedValue(
      sseResponse([`data: ${JSON.stringify({ choices: [{ delta: { content: "tail" } }] })}`]),
    );
    const d = new OpenAICompatibleDispatcher(baseSvc());
    let final: { output: string } | undefined;
    for await (const evt of d.stream("hi", [], "")) {
      if (evt.type === "completion") final = evt.result;
    }
    expect(final?.output).toBe("tail");
  });

  it("cancels the reader when the consumer abandons iteration mid-stream (audit pass A: BUG-A5)", async () => {
    // Build a stream that emits one frame and then would block forever
    // unless cancel() is called.
    let cancelled = false;
    let pulledOnce = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulledOnce) return; // park here; consumer must cancel
        pulledOnce = true;
        const enc = new TextEncoder();
        controller.enqueue(enc.encode(frame({ choices: [{ delta: { content: "x" } }] })));
      },
      cancel() {
        cancelled = true;
      },
    });
    fetchMock.mockResolvedValue(
      new Response(stream, {
        status: 200,
        headers: new Headers({ "content-type": "text/event-stream" }),
      }),
    );

    const d = new OpenAICompatibleDispatcher(baseSvc());
    const iter = d.stream("hi", [], "")[Symbol.asyncIterator]();
    await iter.next(); // pull the first stdout chunk
    await iter.return?.(); // simulate consumer break
    // The reader.cancel() runs in the generator's finally; give it a tick.
    await new Promise((r) => setImmediate(r));
    expect(cancelled).toBe(true);
  });
});
