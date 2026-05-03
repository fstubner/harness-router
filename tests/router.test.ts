/**
 * Algorithm tests for the model-first router.
 *
 * Each test builds a small RouterConfig with hand-rolled fake dispatchers,
 * threads them through the real Router, and asserts the (model, service,
 * tier) the router picks (and, where relevant, the order it falls through).
 */

import { describe, expect, it } from "vitest";

import { Router } from "../src/router.js";
import { QuotaCache } from "../src/quota.js";
import type { Dispatcher } from "../src/dispatchers/base.js";
import type {
  DispatchResult,
  DispatcherEvent,
  QuotaInfo,
  RouterConfig,
  ServiceConfig,
} from "../src/types.js";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface FakeDispatcherOpts {
  succeed?: boolean;
  rateLimit?: boolean;
  unavailable?: boolean;
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
    throw new Error("Tests use stream() only");
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

interface ServiceSpec {
  /** Defaults to the service name. */
  harness?: string;
  /** Model this service serves (canonical name, used for routing). */
  model: string;
  /** Optional CLI-specific name for `--model`. Defaults to `model` when omitted. */
  cliModel?: string;
  tier?: "subscription" | "metered";
  /** Dispatcher behaviour. */
  fake?: Omit<FakeDispatcherOpts, "log">;
}

interface SetupInput {
  modelPriority: readonly string[];
  services: Readonly<Record<string, ServiceSpec>>;
  /** Per-service quota score 0..1 (default 1.0). */
  quotas?: Readonly<Record<string, number>>;
}

function setup(input: SetupInput): {
  router: Router;
  logs: Record<string, FakeDispatcherOpts["log"]>;
} {
  const dispatchers: Record<string, Dispatcher> = {};
  const services: Record<string, ServiceConfig> = {};
  const logs: Record<string, FakeDispatcherOpts["log"]> = {};

  for (const [name, spec] of Object.entries(input.services)) {
    const log: FakeDispatcherOpts["log"] = [];
    logs[name] = log;
    dispatchers[name] = new FakeDispatcher(name, { ...(spec.fake ?? {}), log });
    services[name] = {
      name,
      enabled: true,
      type: "cli",
      harness: spec.harness ?? name,
      command: name,
      model: spec.model,
      ...(spec.cliModel !== undefined ? { cliModel: spec.cliModel } : {}),
      tier: spec.tier ?? "subscription",
    };
  }

  const config: RouterConfig = { services, modelPriority: input.modelPriority };

  const quota = new QuotaCache(dispatchers);
  const quotas = input.quotas ?? {};
  quota.getQuotaScore = async (name: string): Promise<number> => quotas[name] ?? 1.0;

  return { router: new Router(config, quota, dispatchers), logs };
}

async function pick(
  router: Router,
  opts?: Parameters<Router["pickService"]>[0],
): Promise<{ model: string; service: string; tier: string } | null> {
  const decision = await router.pickService(opts);
  return decision
    ? { model: decision.model, service: decision.service, tier: decision.tier }
    : null;
}

async function streamAll(
  router: Router,
  opts?: Parameters<Router["stream"]>[3],
): Promise<{
  events: DispatcherEvent[];
  decisions: string[]; // serialised "model:tier→service"
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
// pickService — model priority walk
// ---------------------------------------------------------------------------

describe("Router.pickService — basics", () => {
  it("picks the first available subscription CLI for the highest-priority model", async () => {
    const { router } = setup({
      modelPriority: ["gpt-5", "claude-opus", "claude-sonnet"],
      services: {
        codex: { model: "gpt-5" },
        copilot: { model: "gpt-5" },
        claude_code: { model: "claude-opus" },
        cursor: { model: "claude-sonnet" },
      },
    });
    const result = await pick(router);
    expect(result?.model).toBe("gpt-5");
    expect(["codex", "copilot"]).toContain(result?.service);
    expect(result?.tier).toBe("subscription");
  });

  it("falls through to the next model when no CLI for the top model is available", async () => {
    const { router } = setup({
      modelPriority: ["gpt-5", "claude-opus"],
      services: {
        codex: { model: "gpt-5", fake: { unavailable: true } },
        claude_code: { model: "claude-opus" },
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
      services: {
        codex: { model: "gpt-5", fake: { unavailable: true } },
        openai_api: { model: "gpt-5", tier: "metered", fake: { unavailable: true } },
        claude_code: { model: "claude-opus", fake: { unavailable: true } },
      },
    });
    expect(await pick(router)).toBeNull();
  });

  it("picks the highest-quota CLI among same-model candidates", async () => {
    const { router } = setup({
      modelPriority: ["gpt-5"],
      services: {
        codex: { model: "gpt-5" },
        copilot: { model: "gpt-5" },
      },
      quotas: { codex: 0.1, copilot: 0.9 },
    });
    expect((await pick(router))?.service).toBe("copilot");
  });

  it("excludes services in opts.exclude", async () => {
    const { router } = setup({
      modelPriority: ["gpt-5"],
      services: { codex: { model: "gpt-5" }, copilot: { model: "gpt-5" } },
    });
    const decision = await router.pickService({ exclude: new Set(["codex"]) });
    expect(decision?.service).toBe("copilot");
  });

  it("skips CLIs whose breaker is tripped", async () => {
    const { router } = setup({
      modelPriority: ["gpt-5"],
      services: { codex: { model: "gpt-5" }, copilot: { model: "gpt-5" } },
    });
    router.getBreaker("codex")!.trip();
    expect((await pick(router))?.service).toBe("copilot");
  });
});

describe("Router.pickService — hints", () => {
  it("forces a specific service via hints.service", async () => {
    const { router } = setup({
      modelPriority: ["gpt-5"],
      services: { codex: { model: "gpt-5" }, copilot: { model: "gpt-5" } },
    });
    const decision = await router.pickService({ hints: { service: "copilot" } });
    expect(decision?.service).toBe("copilot");
    expect(decision?.reason).toBe("forced");
  });

  it("returns null when forced service is unavailable", async () => {
    const { router } = setup({
      modelPriority: ["gpt-5"],
      services: { codex: { model: "gpt-5", fake: { unavailable: true } } },
    });
    expect(await router.pickService({ hints: { service: "codex" } })).toBeNull();
  });

  it("bumps the model override to the front of the priority list", async () => {
    const { router } = setup({
      modelPriority: ["gpt-5", "claude-opus"],
      services: {
        codex: { model: "gpt-5" },
        claude_code: { model: "claude-opus" },
      },
    });
    const decision = await router.pickService({ hints: { model: "claude-opus" } });
    expect(decision?.model).toBe("claude-opus");
    expect(decision?.service).toBe("claude_code");
  });

  it("ignores unknown model override and walks the normal priority list", async () => {
    const { router } = setup({
      modelPriority: ["gpt-5"],
      services: { codex: { model: "gpt-5" } },
    });
    const decision = await router.pickService({ hints: { model: "fictional-model" } });
    expect(decision?.model).toBe("gpt-5");
  });
});

// ---------------------------------------------------------------------------
// pickService — tier semantics
// ---------------------------------------------------------------------------

describe("Router.pickService — tier walk", () => {
  it("picks subscription tier first when both tiers are available", async () => {
    const { router } = setup({
      modelPriority: ["claude-opus"],
      services: {
        claude_code: { model: "claude-opus", tier: "subscription" },
        anthropic_api: { model: "claude-opus", tier: "metered" },
      },
    });
    expect((await pick(router))?.tier).toBe("subscription");
  });

  it("falls to metered tier only after every subscription route is unusable", async () => {
    const { router } = setup({
      modelPriority: ["claude-opus"],
      services: {
        claude_code: { model: "claude-opus", tier: "subscription", fake: { unavailable: true } },
        cursor: { model: "claude-opus", tier: "subscription", fake: { unavailable: true } },
        anthropic_api: { model: "claude-opus", tier: "metered" },
      },
    });
    expect(await pick(router)).toEqual({
      model: "claude-opus",
      service: "anthropic_api",
      tier: "metered",
    });
  });

  it("prefers metered route on top model over subscription on next model (model-first)", async () => {
    const { router } = setup({
      modelPriority: ["claude-opus", "claude-sonnet"],
      services: {
        claude_code: { model: "claude-opus", tier: "subscription", fake: { unavailable: true } },
        anthropic_api_opus: { model: "claude-opus", tier: "metered" },
        cursor: { model: "claude-sonnet", tier: "subscription" },
      },
    });
    const result = await pick(router);
    expect(result?.model).toBe("claude-opus");
    expect(result?.tier).toBe("metered");
  });

  it("works with metered-only models (no subscription option)", async () => {
    const { router } = setup({
      modelPriority: ["gpt-5"],
      services: { openai_api: { model: "gpt-5", tier: "metered" } },
    });
    expect((await pick(router))?.tier).toBe("metered");
  });
});

// ---------------------------------------------------------------------------
// stream — fallback chain
// ---------------------------------------------------------------------------

describe("Router.stream — fallback within a model", () => {
  it("succeeds on the first pick when the dispatcher succeeds", async () => {
    const { router, logs } = setup({
      modelPriority: ["gpt-5"],
      services: { codex: { model: "gpt-5", fake: { succeed: true } } },
    });
    const { decisions } = await streamAll(router);
    expect(decisions).toEqual(["gpt-5:subscription→codex"]);
    expect(logs.codex).toHaveLength(1);
  });

  it("falls over to the next subscription CLI on rate-limit", async () => {
    const { router } = setup({
      modelPriority: ["gpt-5"],
      services: {
        codex: { model: "gpt-5", fake: { rateLimit: true } },
        copilot: { model: "gpt-5", fake: { succeed: true } },
      },
    });
    const { decisions } = await streamAll(router);
    expect(decisions).toEqual(["gpt-5:subscription→codex", "gpt-5:subscription→copilot"]);
  });

  it("trips the breaker on rate-limit", async () => {
    const { router } = setup({
      modelPriority: ["gpt-5"],
      services: {
        codex: { model: "gpt-5", fake: { rateLimit: true } },
        copilot: { model: "gpt-5", fake: { succeed: true } },
      },
    });
    await streamAll(router);
    expect(router.getBreaker("codex")!.isTripped).toBe(true);
    expect(router.getBreaker("copilot")!.isTripped).toBe(false);
  });
});

describe("Router.stream — tier and model fallback", () => {
  it("walks subscription → metered → next-model on cascading rate-limits", async () => {
    const { router } = setup({
      modelPriority: ["claude-opus", "claude-sonnet"],
      services: {
        claude_code: { model: "claude-opus", tier: "subscription", fake: { rateLimit: true } },
        anthropic_api_opus: { model: "claude-opus", tier: "metered", fake: { rateLimit: true } },
        cursor: { model: "claude-sonnet", tier: "subscription", fake: { succeed: true } },
      },
    });
    const { decisions } = await streamAll(router);
    expect(decisions).toEqual([
      "claude-opus:subscription→claude_code",
      "claude-opus:metered→anthropic_api_opus",
      "claude-sonnet:subscription→cursor",
    ]);
  });

  it("yields a completion with success=false when every tier of every model is exhausted", async () => {
    const { router } = setup({
      modelPriority: ["gpt-5"],
      services: {
        codex: { model: "gpt-5", tier: "subscription", fake: { rateLimit: true } },
        openai_api: { model: "gpt-5", tier: "metered", fake: { rateLimit: true } },
      },
    });
    const { events } = await streamAll(router);
    // The terminal completion has success=false. Because rate-limited
    // dispatches still emit completion events, the last event is a real
    // dispatcher completion, not a synthesised "no available routes" one.
    const terminal = [...events].reverse().find((e) => e.type === "completion");
    expect(terminal).toBeDefined();
    if (terminal && terminal.type === "completion") {
      expect(terminal.result.success).toBe(false);
    }
  });

  it("threads the picked model into the dispatcher as modelOverride", async () => {
    const { router, logs } = setup({
      modelPriority: ["gpt-5"],
      services: { codex: { model: "gpt-5", fake: { succeed: true } } },
    });
    await streamAll(router);
    expect(logs.codex![0]!.modelOverride).toBe("gpt-5");
  });

  it("uses cliModel when set, falling back to canonical model otherwise", async () => {
    // Two services serve the same canonical model "claude-opus" but each
    // CLI accepts a different --model name. The router should match on
    // canonical for routing and pass cli-specific for dispatch.
    const { router, logs } = setup({
      modelPriority: ["claude-opus"],
      services: {
        // claude_code rate-limits so we fall through to cursor.
        claude_code: {
          model: "claude-opus",
          cliModel: "opus",
          fake: { rateLimit: true },
        },
        cursor: {
          model: "claude-opus",
          cliModel: "claude-3-opus-thinking-max",
          fake: { succeed: true },
        },
      },
    });
    await streamAll(router);
    expect(logs.claude_code![0]!.modelOverride).toBe("opus");
    expect(logs.cursor![0]!.modelOverride).toBe("claude-3-opus-thinking-max");
  });
});
