/**
 * Algorithm tests for the model-first router prototype (`RouterV2`).
 *
 * These cover routing semantics, not dispatcher mechanics. Each test builds
 * hand-rolled fake dispatchers with deterministic behaviour, threads them
 * through the router, and asserts the (model, service, tier) triple the
 * router picks (and, where relevant, the order it falls through them).
 */

import { describe, expect, it } from "vitest";

import {
  RouterV2,
  type ModelFirstConfig,
  type RouterV2Deps,
} from "../src/router-v2.js";
import type { Dispatcher } from "../src/dispatchers/base.js";
import type {
  DispatchResult,
  DispatcherEvent,
  QuotaInfo,
} from "../src/types.js";
import { CircuitBreaker } from "../src/circuit-breaker.js";
import { QuotaCache } from "../src/quota.js";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface FakeDispatcherOpts {
  /** When true, each call yields a successful completion event. */
  succeed?: boolean;
  /** When true, each call yields a rate-limited completion. */
  rateLimit?: boolean;
  /** When true, `isAvailable()` returns false (CLI not on PATH). */
  unavailable?: boolean;
  /** Records each prompt the dispatcher was asked to handle. */
  log: Array<{ prompt: string; modelOverride: string | undefined }>;
}

class FakeDispatcher implements Dispatcher {
  readonly id: string;
  readonly opts: FakeDispatcherOpts;
  constructor(id: string, opts: FakeDispatcherOpts) {
    this.id = id;
    this.opts = opts;
  }
  async dispatch(): Promise<DispatchResult> {
    throw new Error("RouterV2 only uses stream()");
  }
  async *stream(
    prompt: string,
    _files: string[],
    _workingDir: string,
    opts?: { modelOverride?: string },
  ): AsyncIterable<DispatcherEvent> {
    this.opts.log.push({ prompt, modelOverride: opts?.modelOverride });
    if (this.opts.rateLimit) {
      yield {
        type: "completion",
        result: {
          output: "",
          service: this.id,
          success: false,
          rateLimited: true,
          error: "rate-limited (fake)",
        },
      };
      return;
    }
    yield {
      type: "completion",
      result: {
        output: `from ${this.id} via ${opts?.modelOverride ?? "default"}`,
        service: this.id,
        success: this.opts.succeed !== false,
      },
    };
  }
  async checkQuota(): Promise<QuotaInfo> {
    return { service: this.id, source: "unknown" };
  }
  isAvailable(): boolean {
    return !this.opts.unavailable;
  }
}

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

interface SetupInput {
  modelPriority: readonly string[];
  modelRoutes: ModelFirstConfig["modelRoutes"];
  /** Per-service quota score 0..1 (default 1.0). */
  quotas?: Readonly<Record<string, number>>;
  /** Per-service dispatcher behaviour. */
  services: Readonly<Record<string, FakeDispatcherOpts>>;
}

function setup(input: SetupInput): {
  router: RouterV2;
  deps: RouterV2Deps;
  logs: Record<string, FakeDispatcherOpts["log"]>;
} {
  const dispatchers: Record<string, Dispatcher> = {};
  const breakers: Record<string, CircuitBreaker> = {};
  const logs: Record<string, FakeDispatcherOpts["log"]> = {};

  for (const [name, opts] of Object.entries(input.services)) {
    const log: FakeDispatcherOpts["log"] = [];
    logs[name] = log;
    dispatchers[name] = new FakeDispatcher(name, { ...opts, log });
    breakers[name] = new CircuitBreaker();
  }

  // Real QuotaCache, override getQuotaScore to a deterministic stub.
  const quota = new QuotaCache(dispatchers);
  const quotas = input.quotas ?? {};
  quota.getQuotaScore = async (name: string): Promise<number> => {
    return quotas[name] ?? 1.0;
  };

  const config: ModelFirstConfig = {
    modelPriority: input.modelPriority,
    modelRoutes: input.modelRoutes,
  };
  const deps: RouterV2Deps = { config, dispatchers, quota, breakers };
  return { router: new RouterV2(deps), deps, logs };
}

async function pick(
  router: RouterV2,
  opts?: Parameters<RouterV2["pickRoute"]>[0],
): Promise<{ model: string; service: string; tier: string } | null> {
  const decision = await router.pickRoute(opts);
  return decision
    ? { model: decision.model, service: decision.service, tier: decision.tier }
    : null;
}

async function streamAll(
  router: RouterV2,
  opts?: Parameters<RouterV2["stream"]>[3],
): Promise<{
  events: DispatcherEvent[];
  decisions: Array<string>; // serialised "model:tier→service"
}> {
  const events: DispatcherEvent[] = [];
  const decisions: string[] = [];
  for await (const { event, decision } of router.stream("test prompt", [], "/cwd", opts)) {
    events.push(event);
    if (decision) {
      const tag = `${decision.model}:${decision.tier}→${decision.service}`;
      if (decisions[decisions.length - 1] !== tag) decisions.push(tag);
    }
  }
  return { events, decisions };
}

// ---------------------------------------------------------------------------
// pickRoute — model priority walk
// ---------------------------------------------------------------------------

describe("RouterV2.pickRoute — basics", () => {
  it("picks the first available subscription CLI for the highest-priority model", async () => {
    const { router } = setup({
      modelPriority: ["gpt-5", "claude-opus", "claude-sonnet"],
      modelRoutes: {
        "gpt-5": { subscription: ["codex", "copilot"] },
        "claude-opus": { subscription: ["claude_code"] },
        "claude-sonnet": { subscription: ["claude_code", "cursor"] },
      },
      services: {
        codex: { log: [] },
        copilot: { log: [] },
        claude_code: { log: [] },
        cursor: { log: [] },
      },
    });
    expect(await pick(router)).toEqual({
      model: "gpt-5",
      service: "codex",
      tier: "subscription",
    });
  });

  it("falls through to the next model when no CLI for the top model is available", async () => {
    const { router } = setup({
      modelPriority: ["gpt-5", "claude-opus"],
      modelRoutes: {
        "gpt-5": { subscription: ["codex"] },
        "claude-opus": { subscription: ["claude_code"] },
      },
      services: {
        codex: { unavailable: true, log: [] },
        claude_code: { log: [] },
      },
    });
    expect(await pick(router)).toEqual({
      model: "claude-opus",
      service: "claude_code",
      tier: "subscription",
    });
  });

  it("returns null when every route in every tier of every model is unusable", async () => {
    const { router } = setup({
      modelPriority: ["gpt-5", "claude-opus"],
      modelRoutes: {
        "gpt-5": { subscription: ["codex"], metered: ["openai_api"] },
        "claude-opus": { subscription: ["claude_code"] },
      },
      services: {
        codex: { unavailable: true, log: [] },
        openai_api: { unavailable: true, log: [] },
        claude_code: { unavailable: true, log: [] },
      },
    });
    expect(await pick(router)).toBeNull();
  });

  it("breaks quota ties using declared order", async () => {
    // codex listed before copilot for gpt-5; equal quota → codex wins.
    const { router } = setup({
      modelPriority: ["gpt-5"],
      modelRoutes: { "gpt-5": { subscription: ["codex", "copilot"] } },
      quotas: { codex: 0.5, copilot: 0.5 },
      services: { codex: { log: [] }, copilot: { log: [] } },
    });
    const result = await pick(router);
    expect(result?.service).toBe("codex");
  });

  it("picks the highest-quota CLI when quotas differ", async () => {
    const { router } = setup({
      modelPriority: ["gpt-5"],
      modelRoutes: { "gpt-5": { subscription: ["codex", "copilot"] } },
      quotas: { codex: 0.1, copilot: 0.9 },
      services: { codex: { log: [] }, copilot: { log: [] } },
    });
    const result = await pick(router);
    expect(result?.service).toBe("copilot");
  });

  it("excludes services in opts.excludeServices", async () => {
    const { router } = setup({
      modelPriority: ["gpt-5"],
      modelRoutes: { "gpt-5": { subscription: ["codex", "copilot"] } },
      services: { codex: { log: [] }, copilot: { log: [] } },
    });
    const decision = await router.pickRoute({ excludeServices: new Set(["codex"]) });
    expect(decision?.service).toBe("copilot");
  });

  it("skips CLIs whose breaker is tripped", async () => {
    const { router, deps } = setup({
      modelPriority: ["gpt-5"],
      modelRoutes: { "gpt-5": { subscription: ["codex", "copilot"] } },
      services: { codex: { log: [] }, copilot: { log: [] } },
    });
    deps.breakers.codex!.trip();
    const result = await pick(router);
    expect(result?.service).toBe("copilot");
  });

  it("ignores unknown override and walks the normal priority list", async () => {
    const { router } = setup({
      modelPriority: ["gpt-5"],
      modelRoutes: { "gpt-5": { subscription: ["codex"] } },
      services: { codex: { log: [] } },
    });
    const decision = await router.pickRoute({ modelOverride: "fictional-model" });
    expect(decision?.model).toBe("gpt-5");
  });

  it("bumps the override model to the front of the priority list", async () => {
    const { router } = setup({
      modelPriority: ["gpt-5", "claude-opus"],
      modelRoutes: {
        "gpt-5": { subscription: ["codex"] },
        "claude-opus": { subscription: ["claude_code"] },
      },
      services: { codex: { log: [] }, claude_code: { log: [] } },
    });
    const decision = await router.pickRoute({ modelOverride: "claude-opus" });
    expect(decision?.model).toBe("claude-opus");
    expect(decision?.service).toBe("claude_code");
  });
});

// ---------------------------------------------------------------------------
// pickRoute — tier semantics (the cost-optimization story)
// ---------------------------------------------------------------------------

describe("RouterV2.pickRoute — tier walk", () => {
  it("picks subscription tier first when available", async () => {
    const { router } = setup({
      modelPriority: ["claude-opus"],
      modelRoutes: {
        "claude-opus": {
          subscription: ["claude_code"],
          metered: ["anthropic_api"],
        },
      },
      services: { claude_code: { log: [] }, anthropic_api: { log: [] } },
    });
    expect((await pick(router))?.tier).toBe("subscription");
  });

  it("falls to metered tier only after every subscription route is unusable", async () => {
    const { router } = setup({
      modelPriority: ["claude-opus"],
      modelRoutes: {
        "claude-opus": {
          subscription: ["claude_code", "cursor"],
          metered: ["anthropic_api"],
        },
      },
      services: {
        claude_code: { unavailable: true, log: [] },
        cursor: { unavailable: true, log: [] },
        anthropic_api: { log: [] },
      },
    });
    expect(await pick(router)).toEqual({
      model: "claude-opus",
      service: "anthropic_api",
      tier: "metered",
    });
  });

  it("prefers metered route on top model over subscription on next model (model-first)", async () => {
    // Behaviour matters for cost-vs-preference tradeoffs. The chosen default
    // is "model-first": exhaust all tiers of the top model before dropping
    // to the next model. That matches the user's stated mental model
    // ("Opus first, then Sonnet — I'll pay if I have to keep using Opus").
    const { router } = setup({
      modelPriority: ["claude-opus", "claude-sonnet"],
      modelRoutes: {
        "claude-opus": {
          subscription: ["claude_code"],
          metered: ["anthropic_api_opus"],
        },
        "claude-sonnet": {
          subscription: ["cursor"],
        },
      },
      services: {
        claude_code: { unavailable: true, log: [] },
        anthropic_api_opus: { log: [] },
        cursor: { log: [] },
      },
    });
    const result = await pick(router);
    expect(result?.model).toBe("claude-opus");
    expect(result?.tier).toBe("metered");
  });

  it("works with metered-only models (empty subscription tier)", async () => {
    const { router } = setup({
      modelPriority: ["gpt-5"],
      modelRoutes: {
        "gpt-5": {
          subscription: [], // no subscription option for this model
          metered: ["openai_api"],
        },
      },
      services: { openai_api: { log: [] } },
    });
    expect((await pick(router))?.tier).toBe("metered");
  });
});

// ---------------------------------------------------------------------------
// stream — fallback chain
// ---------------------------------------------------------------------------

describe("RouterV2.stream — fallback within a model", () => {
  it("succeeds on the first pick when the dispatcher succeeds", async () => {
    const { router, logs } = setup({
      modelPriority: ["gpt-5"],
      modelRoutes: { "gpt-5": { subscription: ["codex"] } },
      services: { codex: { succeed: true, log: [] } },
    });
    const { decisions } = await streamAll(router);
    expect(decisions).toEqual(["gpt-5:subscription→codex"]);
    expect(logs.codex).toHaveLength(1);
  });

  it("falls over to the next subscription CLI on rate-limit", async () => {
    const { router } = setup({
      modelPriority: ["gpt-5"],
      modelRoutes: { "gpt-5": { subscription: ["codex", "copilot"] } },
      services: {
        codex: { rateLimit: true, log: [] },
        copilot: { succeed: true, log: [] },
      },
    });
    const { decisions } = await streamAll(router);
    expect(decisions).toEqual([
      "gpt-5:subscription→codex",
      "gpt-5:subscription→copilot",
    ]);
  });

  it("trips the breaker on rate-limit", async () => {
    const { router, deps } = setup({
      modelPriority: ["gpt-5"],
      modelRoutes: { "gpt-5": { subscription: ["codex", "copilot"] } },
      services: {
        codex: { rateLimit: true, log: [] },
        copilot: { succeed: true, log: [] },
      },
    });
    await streamAll(router);
    expect(deps.breakers.codex!.isTripped).toBe(true);
    expect(deps.breakers.copilot!.isTripped).toBe(false);
  });
});

describe("RouterV2.stream — tier and model fallback", () => {
  it("walks subscription → metered → next-model on cascading rate-limits", async () => {
    const { router } = setup({
      modelPriority: ["claude-opus", "claude-sonnet"],
      modelRoutes: {
        "claude-opus": {
          subscription: ["claude_code"],
          metered: ["anthropic_api_opus"],
        },
        "claude-sonnet": {
          subscription: ["cursor"],
        },
      },
      services: {
        claude_code: { rateLimit: true, log: [] },
        anthropic_api_opus: { rateLimit: true, log: [] },
        cursor: { succeed: true, log: [] },
      },
    });
    const { decisions } = await streamAll(router);
    expect(decisions).toEqual([
      "claude-opus:subscription→claude_code",
      "claude-opus:metered→anthropic_api_opus",
      "claude-sonnet:subscription→cursor",
    ]);
  });

  it("yields an error event when every tier of every model is exhausted", async () => {
    const { router } = setup({
      modelPriority: ["gpt-5"],
      modelRoutes: {
        "gpt-5": { subscription: ["codex"], metered: ["openai_api"] },
      },
      services: {
        codex: { rateLimit: true, log: [] },
        openai_api: { rateLimit: true, log: [] },
      },
    });
    const { events } = await streamAll(router);
    const last = events[events.length - 1]!;
    expect(last.type).toBe("error");
    if (last.type === "error") {
      expect(last.error).toMatch(/exhausted/i);
    }
  });

  it("threads the picked model into the dispatcher as modelOverride", async () => {
    const { router, logs } = setup({
      modelPriority: ["gpt-5"],
      modelRoutes: { "gpt-5": { subscription: ["codex"] } },
      services: { codex: { succeed: true, log: [] } },
    });
    await streamAll(router);
    expect(logs.codex![0]!.modelOverride).toBe("gpt-5");
  });
});
