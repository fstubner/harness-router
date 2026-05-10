/**
 * Unit tests for the v0.3 single-tool MCP surface.
 *
 * The 4-tool v0.2 surface (code, code_mixture, dashboard, get_quota_status)
 * collapsed to one tool: `code`, with `mode: "single" | "fanout"`.
 * Status data is exposed as resources, exercised in resources.test.ts.
 */

import { describe, expect, it } from "vitest";

import { invokeTool, TOOL_NAMES, handleDashboard, handleQuotaStatus } from "../../src/mcp/tools.js";
import { RuntimeHolder, type RuntimeState } from "../../src/mcp/config-hot-reload.js";
import { Router } from "../../src/router.js";
import { QuotaCache } from "../../src/quota.js";
import { QuotaStore } from "../../src/state/quota-store.js";
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
  const quota = new QuotaCache(dispatchers, {
    store: new QuotaStore({ path: ":memory:", skipMkdir: true }),
  });
  const router = new Router(config, quota, dispatchers);
  const state: RuntimeState = { config, dispatchers, quota, router, mtimeMs: 0 };
  return new RuntimeHolder(state);
}

// Discriminated-union helpers for the new CodeResult shape.
type SingleData = {
  mode: "single";
  route: {
    success: boolean;
    service: string;
    error?: string;
    routing?: { model: string; tier: string };
  };
};
type FanoutData = {
  mode: "fanout";
  results: Array<{ service: string; tier: string; output: string; success: boolean }>;
  error?: string;
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MCP tools — TOOL_NAMES", () => {
  it("exports a single tool: `code`", () => {
    expect(TOOL_NAMES).toEqual(["code"]);
  });
});

describe("code — mode: single (default)", () => {
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
    const data = r.data as SingleData;
    expect(data.mode).toBe("single");
    expect(data.route.success).toBe(true);
    expect(data.route.service).toBe("a");
    expect(data.route.routing?.model).toBe("model-a");
    expect(data.route.routing?.tier).toBe("subscription");
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
    const data = r.data as SingleData;
    expect(data.route.service).toBe("b");
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
    const data = r.data as SingleData;
    expect(data.route.service).toBe("b");
    expect(data.route.routing?.model).toBe("model-b");
  });

  it("returns success=false when every service is unavailable", async () => {
    const services = { a: makeService("a", { model: "model-a" }) };
    const dispatchers: Record<string, Dispatcher> = {
      a: new FakeDispatcher("a", { output: "nope", service: "a", success: true }, false),
    };
    const holder = buildHolder(services, dispatchers, ["model-a"]);
    const r = await invokeTool("code", { prompt: "hi" }, { holder });
    const data = r.data as SingleData;
    expect(data.route.success).toBe(false);
  });

  it("explicit mode: single is equivalent to default", async () => {
    const services = { a: makeService("a", { model: "model-a" }) };
    const dispatchers: Record<string, Dispatcher> = {
      a: new FakeDispatcher("a", { output: "from a", service: "a", success: true }),
    };
    const holder = buildHolder(services, dispatchers, ["model-a"]);
    const r = await invokeTool("code", { prompt: "hi", mode: "single" }, { holder });
    expect((r.data as SingleData).mode).toBe("single");
  });
});

describe("code — mode: fanout", () => {
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

    const r = await invokeTool("code", { prompt: "hi", mode: "fanout" }, { holder });
    expect(r.kind).toBe("json");
    const data = r.data as FanoutData;
    expect(data.mode).toBe("fanout");
    expect(data.results).toHaveLength(3);
    for (const item of data.results) {
      expect(item.success).toBe(true);
      expect(["A", "B", "C"]).toContain(item.output);
      expect(item.tier).toBe("subscription");
    }
  });

  it("returns an empty results array (with error) when nothing is available", async () => {
    const services = { a: makeService("a") };
    const dispatchers: Record<string, Dispatcher> = {
      a: new FakeDispatcher("a", { output: "", service: "a", success: true }, false),
    };
    const holder = buildHolder(services, dispatchers);
    const r = await invokeTool("code", { prompt: "hi", mode: "fanout" }, { holder });
    const data = r.data as FanoutData;
    expect(data.results).toEqual([]);
    expect(data.error).toBeDefined();
  });

  it("expands the `models` axis to ALL routes per model (multi-harness fanout)", async () => {
    // Two services per model — one subscription, one metered. Fanout
    // dispatches to BOTH because that's the comparison the user wanted.
    const services = {
      a_sub: makeService("a_sub", { model: "model-a", tier: "subscription" }),
      a_metered: makeService("a_metered", { model: "model-a", tier: "metered" }),
      b_metered: makeService("b_metered", { model: "model-b", tier: "metered" }),
    };
    const dispatchers: Record<string, Dispatcher> = {
      a_sub: new FakeDispatcher("a_sub", { output: "from-sub", service: "a_sub", success: true }),
      a_metered: new FakeDispatcher("a_metered", {
        output: "from-metered-a",
        service: "a_metered",
        success: true,
      }),
      b_metered: new FakeDispatcher("b_metered", {
        output: "from-metered-b",
        service: "b_metered",
        success: true,
      }),
    };
    const holder = buildHolder(services, dispatchers, ["model-a", "model-b"]);
    const r = await invokeTool(
      "code",
      { prompt: "hi", mode: "fanout", models: ["model-a", "model-b"] },
      { holder },
    );
    const data = r.data as FanoutData;
    // Both model-a routes (sub + metered) AND the model-b metered route.
    expect(data.results).toHaveLength(3);
    const byService = new Map(data.results.map((it) => [it.service, it]));
    expect(byService.get("a_sub")).toBeDefined();
    expect(byService.get("a_metered")).toBeDefined();
    expect(byService.get("b_metered")).toBeDefined();
  });

  it("returns an error when none of the requested models has a route", async () => {
    const services = { a: makeService("a", { model: "model-a" }) };
    const dispatchers: Record<string, Dispatcher> = { a: new FakeDispatcher("a") };
    const holder = buildHolder(services, dispatchers, ["model-a"]);
    const r = await invokeTool(
      "code",
      { prompt: "hi", mode: "fanout", models: ["model-z"] },
      { holder },
    );
    const data = r.data as FanoutData;
    expect(data.results).toEqual([]);
    expect(data.error).toMatch(/model-z/);
  });

  it("falls back to mixtureDefault when models is omitted", async () => {
    const services = {
      a: makeService("a", { model: "model-a" }),
      b: makeService("b", { model: "model-b" }),
      c: makeService("c", { model: "model-c" }),
    };
    const dispatchers: Record<string, Dispatcher> = {
      a: new FakeDispatcher("a"),
      b: new FakeDispatcher("b"),
      c: new FakeDispatcher("c"),
    };
    const holder = buildHolder(services, dispatchers, ["model-a", "model-b", "model-c"]);
    const state = holder.state;
    holder.replace({
      ...state,
      config: { ...state.config, mixtureDefault: ["a", "c"] },
    });
    const r = await invokeTool("code", { prompt: "hi", mode: "fanout" }, { holder });
    const data = r.data as FanoutData;
    const names = new Set(data.results.map((it) => it.service));
    expect(names).toEqual(new Set(["a", "c"]));
  });

  it("explicit `models` overrides mixtureDefault", async () => {
    // models: takes precedence over mixture_default. Useful when the
    // user wants to do a one-off comparison different from the wizard's
    // pre-configured fan-out set.
    const services = {
      a_sub: makeService("a_sub", { model: "model-a" }),
      b_sub: makeService("b_sub", { model: "model-b" }),
      c_sub: makeService("c_sub", { model: "model-c" }),
    };
    const dispatchers: Record<string, Dispatcher> = {
      a_sub: new FakeDispatcher("a_sub"),
      b_sub: new FakeDispatcher("b_sub"),
      c_sub: new FakeDispatcher("c_sub"),
    };
    const holder = buildHolder(services, dispatchers, ["model-a", "model-b", "model-c"]);
    const state = holder.state;
    holder.replace({
      ...state,
      config: { ...state.config, mixtureDefault: ["a_sub"] },
    });
    const r = await invokeTool(
      "code",
      { prompt: "hi", mode: "fanout", models: ["model-b", "model-c"] },
      { holder },
    );
    const data = r.data as FanoutData;
    const names = new Set(data.results.map((it) => it.service));
    expect(names).toEqual(new Set(["b_sub", "c_sub"]));
  });
});

describe("status helpers (consumed by resources)", () => {
  it("handleQuotaStatus returns combined quota + breaker state per service", async () => {
    const services = { a: makeService("a") };
    const dispatchers: Record<string, Dispatcher> = { a: new FakeDispatcher("a") };
    const holder = buildHolder(services, dispatchers);
    const data = await handleQuotaStatus({ holder });
    expect(data.a).toBeDefined();
    expect((data.a as { circuitBreaker: { tripped: boolean } }).circuitBreaker).toEqual({
      tripped: false,
      failures: 0,
    });
  });

  it("handleDashboard returns multi-line text including model priority", async () => {
    const services = {
      a: makeService("a", { model: "model-a", maxOutputTokens: 64_000, maxInputTokens: 1_000_000 }),
    };
    const dispatchers: Record<string, Dispatcher> = { a: new FakeDispatcher("a") };
    const holder = buildHolder(services, dispatchers, ["model-a"]);
    const text = await handleDashboard({ holder });
    expect(text).toContain("harness-router");
    expect(text).toMatch(/output-cap/);
    expect(text).toMatch(/context/);
    expect(text).toContain("model-a");
  });
});
