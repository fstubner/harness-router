/**
 * Unit tests for the MCP tool handlers.
 *
 * Bypass MCP transport entirely — call `invokeTool()` directly with mocked
 * router/quota/dispatcher state. Each of the 4 tools is exercised against
 * an in-memory holder so the test is fast and deterministic.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

import { invokeTool, TOOL_NAMES } from "../../src/mcp/tools.js";
import { RuntimeHolder, type RuntimeState } from "../../src/mcp/config-hot-reload.js";
import { Router } from "../../src/router.js";
import { QuotaCache } from "../../src/quota.js";
import type { Dispatcher } from "../../src/dispatchers/base.js";
import type {
  DispatchResult,
  DispatcherEvent,
  QuotaInfo,
  RouterConfig,
  ServiceConfig,
} from "../../src/types.js";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

class FakeDispatcher implements Dispatcher {
  readonly id: string;
  constructor(
    id: string,
    private readonly response: DispatchResult = {
      output: "hello",
      service: id,
      success: true,
    },
    private readonly available = true,
  ) {
    this.id = id;
  }
  async dispatch(): Promise<DispatchResult> {
    return this.response;
  }
  async checkQuota(): Promise<QuotaInfo> {
    return { service: this.id, source: "unknown" };
  }
  async *stream(): AsyncIterable<DispatcherEvent> {
    yield { type: "completion", result: this.response };
  }
  isAvailable(): boolean {
    return this.available;
  }
}

function makeService(name: string, over: Partial<ServiceConfig> = {}): ServiceConfig {
  return {
    name,
    enabled: true,
    type: "cli",
    harness: name,
    command: name,
    model: `${name}-model`,
    tier: "subscription",
    maxOutputTokens: 64_000,
    maxInputTokens: 1_000_000,
    ...over,
  };
}

function buildHolder(
  services: Record<string, ServiceConfig>,
  dispatchers: Record<string, Dispatcher>,
  modelPriority?: readonly string[],
): RuntimeHolder {
  const priority =
    modelPriority ??
    Object.values(services)
      .map((s) => s.model ?? "")
      .filter(Boolean);
  const config: RouterConfig = { services, modelPriority: priority };
  const quota = new QuotaCache(dispatchers, { stateFile: ":memory-not-used:" });
  const router = new Router(config, quota, dispatchers);
  const state: RuntimeState = { config, dispatchers, quota, router, mtimeMs: 0 };
  return new RuntimeHolder(state);
}

beforeEach(() => {
  vi.spyOn(QuotaCache.prototype, "saveLocalCountsSync").mockImplementation(() => undefined);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MCP tools — TOOL_NAMES", () => {
  it("exports exactly the 4 tool names", () => {
    expect(TOOL_NAMES).toHaveLength(4);
    expect(new Set(TOOL_NAMES)).toEqual(
      new Set(["code", "code_mixture", "dashboard", "get_quota_status"]),
    );
  });
});

describe("MCP tools — code", () => {
  it("routes to the highest-priority service and returns a routing block", async () => {
    const services = {
      a: makeService("a", { model: "model-a" }),
      b: makeService("b", { model: "model-b" }),
    };
    const dispatchers: Record<string, Dispatcher> = {
      a: new FakeDispatcher("a", { output: "from a", service: "a", success: true }),
      b: new FakeDispatcher("b", { output: "from b", service: "b", success: true }),
    };
    const holder = buildHolder(services, dispatchers, ["model-a", "model-b"]);

    const r = await invokeTool("code", { prompt: "hi" }, { holder });
    expect(r.kind).toBe("json");
    const data = r.data as {
      success: boolean;
      service: string;
      routing?: { model: string; tier: string };
    };
    expect(data.success).toBe(true);
    expect(data.service).toBe("a");
    expect(data.routing?.model).toBe("model-a");
    expect(data.routing?.tier).toBe("subscription");
  });

  it("forces a specific service via hints.service", async () => {
    const services = {
      a: makeService("a", { model: "model-a" }),
      b: makeService("b", { model: "model-b" }),
    };
    const dispatchers: Record<string, Dispatcher> = {
      a: new FakeDispatcher("a", { output: "from a", service: "a", success: true }),
      b: new FakeDispatcher("b", { output: "from b", service: "b", success: true }),
    };
    const holder = buildHolder(services, dispatchers, ["model-a", "model-b"]);

    const r = await invokeTool("code", { prompt: "hi", hints: { service: "b" } }, { holder });
    const data = r.data as { service: string };
    expect(data.service).toBe("b");
  });

  it("bumps an override model to the front via hints.model", async () => {
    const services = {
      a: makeService("a", { model: "model-a" }),
      b: makeService("b", { model: "model-b" }),
    };
    const dispatchers: Record<string, Dispatcher> = {
      a: new FakeDispatcher("a", { output: "from a", service: "a", success: true }),
      b: new FakeDispatcher("b", { output: "from b", service: "b", success: true }),
    };
    const holder = buildHolder(services, dispatchers, ["model-a", "model-b"]);

    const r = await invokeTool("code", { prompt: "hi", hints: { model: "model-b" } }, { holder });
    const data = r.data as { service: string; routing?: { model: string } };
    expect(data.service).toBe("b");
    expect(data.routing?.model).toBe("model-b");
  });

  it("returns success=false when every service is unavailable", async () => {
    const services = { a: makeService("a", { model: "model-a" }) };
    const dispatchers: Record<string, Dispatcher> = {
      a: new FakeDispatcher("a", { output: "nope", service: "a", success: true }, false),
    };
    const holder = buildHolder(services, dispatchers, ["model-a"]);
    const r = await invokeTool("code", { prompt: "hi" }, { holder });
    const data = r.data as { success: boolean; error?: string };
    expect(data.success).toBe(false);
  });
});

describe("MCP tools — code_mixture", () => {
  it("fans out to all available services in parallel", async () => {
    const services = {
      a: makeService("a"),
      b: makeService("b"),
      c: makeService("c"),
    };
    const dispatchers: Record<string, Dispatcher> = {
      a: new FakeDispatcher("a", { output: "A", service: "a", success: true }),
      b: new FakeDispatcher("b", { output: "B", service: "b", success: true }),
      c: new FakeDispatcher("c", { output: "C", service: "c", success: true }),
    };
    const holder = buildHolder(services, dispatchers);

    const r = await invokeTool("code_mixture", { prompt: "hi" }, { holder });
    expect(r.kind).toBe("json");
    const data = r.data as {
      results: Array<{ service: string; success: boolean; output: string; tier: string }>;
    };
    expect(data.results).toHaveLength(3);
    for (const item of data.results) {
      expect(item.success).toBe(true);
      expect(["A", "B", "C"]).toContain(item.output);
      expect(item.tier).toBe("subscription");
    }
  });

  it("honours the explicit services whitelist", async () => {
    const services = { a: makeService("a"), b: makeService("b") };
    const dispatchers: Record<string, Dispatcher> = {
      a: new FakeDispatcher("a"),
      b: new FakeDispatcher("b"),
    };
    const holder = buildHolder(services, dispatchers);
    const r = await invokeTool("code_mixture", { prompt: "hi", services: ["b"] }, { holder });
    const data = r.data as { results: Array<{ service: string }> };
    expect(data.results).toHaveLength(1);
    expect(data.results[0]!.service).toBe("b");
  });

  it("returns an empty results array (with error) when nothing is available", async () => {
    const services = { a: makeService("a") };
    const dispatchers: Record<string, Dispatcher> = {
      a: new FakeDispatcher("a", { output: "", service: "a", success: true }, false),
    };
    const holder = buildHolder(services, dispatchers);
    const r = await invokeTool("code_mixture", { prompt: "hi" }, { holder });
    const data = r.data as { results: unknown[]; error?: string };
    expect(data.results).toEqual([]);
    expect(data.error).toBeDefined();
  });
});

describe("MCP tools — introspection", () => {
  it("get_quota_status returns combined quota + breaker state per service", async () => {
    const services = { a: makeService("a") };
    const dispatchers: Record<string, Dispatcher> = { a: new FakeDispatcher("a") };
    const holder = buildHolder(services, dispatchers);
    const r = await invokeTool("get_quota_status", {}, { holder });
    expect(r.kind).toBe("json");
    const data = r.data as Record<string, { circuitBreaker: { tripped: boolean } }>;
    expect(data.a).toBeDefined();
    expect(data.a!.circuitBreaker).toEqual({ tripped: false, failures: 0 });
  });

  it("dashboard returns multi-line text including token limits and model priority", async () => {
    const services = {
      a: makeService("a", { model: "model-a", maxOutputTokens: 64_000, maxInputTokens: 1_000_000 }),
    };
    const dispatchers: Record<string, Dispatcher> = { a: new FakeDispatcher("a") };
    const holder = buildHolder(services, dispatchers, ["model-a"]);
    const r = await invokeTool("dashboard", {}, { holder });
    expect(r.kind).toBe("text");
    const text = r.data as string;
    expect(text).toContain("harness-router-mcp");
    expect(text).toMatch(/output-cap/);
    expect(text).toMatch(/context/);
    expect(text).toContain("model-a");
  });
});
