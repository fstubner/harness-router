/**
 * Algorithm tests for the model-first router prototype (`RouterV2`).
 *
 * These cover the routing semantics, not the dispatcher mechanics. Each test
 * builds a hand-rolled fake dispatcher with deterministic behaviour, threads
 * it through the router, and asserts the model + service pair the router
 * picks (and, where relevant, the order it falls through them).
 */

import { describe, expect, it } from "vitest";

import { RouterV2, type ModelFirstConfig, type RouterV2Deps } from "../src/router-v2.js";
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

function setup(input: {
  modelPriority: readonly string[];
  cliRoutes: Readonly<Record<string, readonly string[]>>;
  /** Per-service quota score 0..1 (default 1.0). */
  quotas?: Readonly<Record<string, number>>;
  /** Per-service dispatcher behaviour. */
  services: Readonly<Record<string, FakeDispatcherOpts>>;
}): { router: RouterV2; deps: RouterV2Deps; logs: Record<string, FakeDispatcherOpts["log"]> } {
  const dispatchers: Record<string, Dispatcher> = {};
  const breakers: Record<string, CircuitBreaker> = {};
  const logs: Record<string, FakeDispatcherOpts["log"]> = {};

  for (const [name, opts] of Object.entries(input.services)) {
    const log: FakeDispatcherOpts["log"] = [];
    logs[name] = log;
    dispatchers[name] = new FakeDispatcher(name, { ...opts, log });
    breakers[name] = new CircuitBreaker();
  }

  // Build a real QuotaCache, override getQuotaScore to a deterministic stub.
  const quota = new QuotaCache(dispatchers);
  const quotas = input.quotas ?? {};
  quota.getQuotaScore = async (name: string): Promise<number> => {
    return quotas[name] ?? 1.0;
  };

  const config: ModelFirstConfig = {
    modelPriority: input.modelPriority,
    cliRoutes: input.cliRoutes,
  };
  const deps: RouterV2Deps = { config, dispatchers, quota, breakers };
  return { router: new RouterV2(deps), deps, logs };
}

async function pick(
  router: RouterV2,
  opts?: Parameters<RouterV2["pickRoute"]>[0],
): Promise<{ model: string; service: string } | null> {
  const decision = await router.pickRoute(opts);
  return decision ? { model: decision.model, service: decision.service } : null;
}

async function streamAll(
  router: RouterV2,
  opts?: Parameters<RouterV2["stream"]>[3],
): Promise<{
  events: DispatcherEvent[];
  decisions: Array<string>; // serialised "model→service"
}> {
  const events: DispatcherEvent[] = [];
  const decisions: string[] = [];
  for await (const { event, decision } of router.stream("test prompt", [], "/cwd", opts)) {
    events.push(event);
    if (decision) {
      const tag = `${decision.model}→${decision.service}`;
      if (decisions[decisions.length - 1] !== tag) decisions.push(tag);
    }
  }
  return { events, decisions };
}

// ---------------------------------------------------------------------------
// pickRoute — the algorithm proper
// ---------------------------------------------------------------------------

describe("RouterV2.pickRoute — model priority walk", () => {
  it("picks the first available CLI for the highest-priority model", async () => {
    const { router } = setup({
      modelPriority: ["gpt-5", "claude-opus", "claude-sonnet"],
      cliRoutes: {
        "gpt-5": ["codex", "copilot"],
        "claude-opus": ["claude_code"],
        "claude-sonnet": ["claude_code", "cursor"],
      },
      services: {
        codex: {} as FakeDispatcherOpts,
        copilot: {} as FakeDispatcherOpts,
        claude_code: {} as FakeDispatcherOpts,
        cursor: {} as FakeDispatcherOpts,
      },
    });
    expect(await pick(router)).toEqual({ model: "gpt-5", service: "codex" });
  });

  it("falls through to the next model when no CLI for the top model is available", async () => {
    const { router } = setup({
      modelPriority: ["gpt-5", "claude-opus"],
      cliRoutes: {
        "gpt-5": ["codex"],
        "claude-opus": ["claude_code"],
      },
      services: {
        codex: { unavailable: true } as FakeDispatcherOpts,
        claude_code: {} as FakeDispatcherOpts,
      },
    });
    expect(await pick(router)).toEqual({ model: "claude-opus", service: "claude_code" });
  });

  it("returns null when every model has zero usable routes", async () => {
    const { router } = setup({
      modelPriority: ["gpt-5", "claude-opus"],
      cliRoutes: {
        "gpt-5": ["codex"],
        "claude-opus": ["claude_code"],
      },
      services: {
        codex: { unavailable: true } as FakeDispatcherOpts,
        claude_code: { unavailable: true } as FakeDispatcherOpts,
      },
    });
    expect(await pick(router)).toBeNull();
  });

  it("breaks quota ties using cli_routes order", async () => {
    // codex listed before copilot for gpt-5; equal quota → codex wins.
    const { router } = setup({
      modelPriority: ["gpt-5"],
      cliRoutes: { "gpt-5": ["codex", "copilot"] },
      quotas: { codex: 0.5, copilot: 0.5 },
      services: {
        codex: {} as FakeDispatcherOpts,
        copilot: {} as FakeDispatcherOpts,
      },
    });
    expect(await pick(router)).toEqual({ model: "gpt-5", service: "codex" });
  });

  it("picks the highest-quota CLI when quotas differ", async () => {
    // codex listed first but has less quota — copilot wins.
    const { router } = setup({
      modelPriority: ["gpt-5"],
      cliRoutes: { "gpt-5": ["codex", "copilot"] },
      quotas: { codex: 0.1, copilot: 0.9 },
      services: {
        codex: {} as FakeDispatcherOpts,
        copilot: {} as FakeDispatcherOpts,
      },
    });
    expect(await pick(router)).toEqual({ model: "gpt-5", service: "copilot" });
  });

  it("excludes services in opts.excludeServices", async () => {
    const { router } = setup({
      modelPriority: ["gpt-5"],
      cliRoutes: { "gpt-5": ["codex", "copilot"] },
      services: {
        codex: {} as FakeDispatcherOpts,
        copilot: {} as FakeDispatcherOpts,
      },
    });
    const decision = await router.pickRoute({ excludeServices: new Set(["codex"]) });
    expect(decision?.service).toBe("copilot");
  });

  it("skips CLIs whose breaker is tripped", async () => {
    const { router, deps } = setup({
      modelPriority: ["gpt-5"],
      cliRoutes: { "gpt-5": ["codex", "copilot"] },
      services: {
        codex: {} as FakeDispatcherOpts,
        copilot: {} as FakeDispatcherOpts,
      },
    });
    deps.breakers.codex!.trip();
    expect(await pick(router)).toEqual({ model: "gpt-5", service: "copilot" });
  });
});

describe("RouterV2.pickRoute — model override", () => {
  it("bumps the override model to the front of the priority list", async () => {
    const { router } = setup({
      modelPriority: ["gpt-5", "claude-opus", "claude-sonnet"],
      cliRoutes: {
        "gpt-5": ["codex"],
        "claude-opus": ["claude_code"],
        "claude-sonnet": ["claude_code"],
      },
      services: {
        codex: {} as FakeDispatcherOpts,
        claude_code: {} as FakeDispatcherOpts,
      },
    });
    const decision = await router.pickRoute({ modelOverride: "claude-opus" });
    expect(decision?.model).toBe("claude-opus");
    expect(decision?.service).toBe("claude_code");
  });

  it("ignores unknown override and walks the normal priority list", async () => {
    const { router } = setup({
      modelPriority: ["gpt-5"],
      cliRoutes: { "gpt-5": ["codex"] },
      services: { codex: {} as FakeDispatcherOpts },
    });
    const decision = await router.pickRoute({ modelOverride: "fictional-model" });
    expect(decision?.model).toBe("gpt-5");
  });
});

// ---------------------------------------------------------------------------
// stream — fallback semantics
// ---------------------------------------------------------------------------

describe("RouterV2.stream — fallback chain", () => {
  it("succeeds on the first pick when the dispatcher succeeds", async () => {
    const { router, logs } = setup({
      modelPriority: ["gpt-5"],
      cliRoutes: { "gpt-5": ["codex"] },
      services: { codex: { succeed: true } as FakeDispatcherOpts },
    });
    const { decisions } = await streamAll(router);
    expect(decisions).toEqual(["gpt-5→codex"]);
    expect(logs.codex).toHaveLength(1);
  });

  it("falls over to the next CLI for the same model on rate-limit", async () => {
    const { router, logs } = setup({
      modelPriority: ["gpt-5"],
      cliRoutes: { "gpt-5": ["codex", "copilot"] },
      services: {
        codex: { rateLimit: true } as FakeDispatcherOpts,
        copilot: { succeed: true } as FakeDispatcherOpts,
      },
    });
    const { decisions } = await streamAll(router);
    expect(decisions).toEqual(["gpt-5→codex", "gpt-5→copilot"]);
    expect(logs.codex).toHaveLength(1);
    expect(logs.copilot).toHaveLength(1);
  });

  it("trips the breaker on rate-limit so subsequent picks skip the service", async () => {
    const { router, deps } = setup({
      modelPriority: ["gpt-5"],
      cliRoutes: { "gpt-5": ["codex", "copilot"] },
      services: {
        codex: { rateLimit: true } as FakeDispatcherOpts,
        copilot: { succeed: true } as FakeDispatcherOpts,
      },
    });
    await streamAll(router);
    expect(deps.breakers.codex!.isTripped).toBe(true);
    expect(deps.breakers.copilot!.isTripped).toBe(false);
  });

  it("drops to the next model after every CLI for the top model fails", async () => {
    const { router } = setup({
      modelPriority: ["gpt-5", "claude-opus"],
      cliRoutes: {
        "gpt-5": ["codex", "copilot"],
        "claude-opus": ["claude_code"],
      },
      services: {
        codex: { rateLimit: true } as FakeDispatcherOpts,
        copilot: { rateLimit: true } as FakeDispatcherOpts,
        claude_code: { succeed: true } as FakeDispatcherOpts,
      },
    });
    const { decisions } = await streamAll(router);
    expect(decisions).toEqual([
      "gpt-5→codex",
      "gpt-5→copilot",
      "claude-opus→claude_code",
    ]);
  });

  it("yields an error event when every route is exhausted", async () => {
    const { router } = setup({
      modelPriority: ["gpt-5"],
      cliRoutes: { "gpt-5": ["codex"] },
      services: { codex: { rateLimit: true } as FakeDispatcherOpts },
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
      cliRoutes: { "gpt-5": ["codex"] },
      services: { codex: { succeed: true } as FakeDispatcherOpts },
    });
    await streamAll(router);
    expect(logs.codex![0]!.modelOverride).toBe("gpt-5");
  });
});
