/**
 * Router unit tests.
 *
 * Mocks the CircuitBreaker, QuotaCache, LeaderboardCache, and Dispatcher
 * modules — this test suite focuses on router scoring + dispatch logic,
 * not on those dependencies.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// ---- Mock dependency modules with minimal stand-ins ----------------------

vi.mock("../src/circuit-breaker.js", () => {
  class CircuitBreaker {
    failures = 0;
    private _tripped = false;
    private _cooldown = 300;
    get isTripped(): boolean {
      return this._tripped;
    }
    recordFailure(): void {
      this.failures += 1;
    }
    recordSuccess(): void {
      this.failures = 0;
      this._tripped = false;
    }
    trip(retryAfter?: number): void {
      this._tripped = true;
      if (retryAfter !== undefined && retryAfter > 0) this._cooldown = retryAfter;
    }
    forceTrip(): void {
      // Test helper — bypass the threshold
      this._tripped = true;
    }
    cooldownRemaining(): number {
      return this._tripped ? this._cooldown : 0;
    }
    status(): { tripped: boolean; failures: number; cooldownRemainingSec?: number } {
      if (this._tripped) {
        return { tripped: true, failures: this.failures, cooldownRemainingSec: this._cooldown };
      }
      return { tripped: false, failures: this.failures };
    }
  }
  return { CircuitBreaker };
});

vi.mock("../src/quota.js", () => {
  class QuotaCache {
    private scores = new Map<string, number>();
    setScore(service: string, score: number): void {
      this.scores.set(service, score);
    }
    async getQuotaScore(service: string): Promise<number> {
      return this.scores.get(service) ?? 1.0;
    }
    recordResult(): void {
      /* no-op for tests */
    }
  }
  return { QuotaCache };
});

vi.mock("../src/leaderboard.js", () => {
  class LeaderboardCache {
    private models = new Map<string, { qualityScore: number; elo: number | null }>();
    private tierOverrides = new Map<string, number>();
    setModel(model: string, qualityScore: number, elo: number | null = null): void {
      this.models.set(model, { qualityScore, elo });
    }
    setTier(model: string, tier: number): void {
      this.tierOverrides.set(model, tier);
    }
    async getQualityScore(
      model: string | undefined,
    ): Promise<{ qualityScore: number; elo: number | null }> {
      if (!model) return { qualityScore: 1.0, elo: null };
      return this.models.get(model) ?? { qualityScore: 1.0, elo: null };
    }
    async autoTier(
      model: string | undefined,
      _thinking: unknown,
      fallbackTier: number,
    ): Promise<number> {
      if (!model) return fallbackTier;
      return this.tierOverrides.get(model) ?? fallbackTier;
    }
  }
  return { LeaderboardCache };
});

// ---- Imports come AFTER vi.mock calls ------------------------------------

import { Router } from "../src/router.js";
import { QuotaCache } from "../src/quota.js";
import { LeaderboardCache } from "../src/leaderboard.js";
import { CircuitBreaker } from "../src/circuit-breaker.js";
import type { DispatchResult, RouterConfig, ServiceConfig, TaskType } from "../src/types.js";
import type { Dispatcher } from "../src/dispatchers/base.js";

// ---- Test helpers --------------------------------------------------------

function makeService(overrides: Partial<ServiceConfig> & { name: string }): ServiceConfig {
  return {
    enabled: true,
    type: "cli",
    command: overrides.name,
    tier: 1,
    weight: 1.0,
    cliCapability: 1.0,
    capabilities: { execute: 1.0, plan: 1.0, review: 1.0 },
    escalateOn: ["plan", "review"],
    ...overrides,
  } as ServiceConfig;
}

function makeConfig(services: ServiceConfig[]): RouterConfig {
  const map: Record<string, ServiceConfig> = {};
  for (const svc of services) map[svc.name] = svc;
  return { services: map };
}

class StubDispatcher implements Dispatcher {
  readonly id: string;
  calls: Array<{ prompt: string; model?: string }> = [];
  private nextResult: DispatchResult;
  private available = true;

  constructor(id: string, result?: Partial<DispatchResult>) {
    this.id = id;
    this.nextResult = {
      output: `ok from ${id}`,
      service: id,
      success: true,
      ...(result ?? {}),
    } as DispatchResult;
  }

  setResult(result: Partial<DispatchResult>): void {
    this.nextResult = { ...this.nextResult, ...result } as DispatchResult;
  }

  setAvailable(v: boolean): void {
    this.available = v;
  }

  async dispatch(
    prompt: string,
    _files: string[],
    _workingDir: string,
    opts?: { modelOverride?: string },
  ): Promise<DispatchResult> {
    const call: { prompt: string; model?: string } = { prompt };
    if (opts?.modelOverride !== undefined) call.model = opts.modelOverride;
    this.calls.push(call);
    return this.nextResult;
  }

  async checkQuota(): Promise<never> {
    throw new Error("not implemented for tests");
  }

  isAvailable(): boolean {
    return this.available;
  }
}

// ---- Tests ---------------------------------------------------------------

describe("Router.pickService", () => {
  let quota: QuotaCache;
  let leaderboard: LeaderboardCache;

  beforeEach(() => {
    quota = new QuotaCache();
    leaderboard = new LeaderboardCache();
  });

  it("prefers the service with higher ELO within the same tier", async () => {
    const a = makeService({
      name: "alpha",
      leaderboardModel: "model-a",
      tier: 1,
    });
    const b = makeService({
      name: "beta",
      leaderboardModel: "model-b",
      tier: 1,
    });
    (leaderboard as unknown as { setModel: (m: string, q: number, e: number) => void }).setModel(
      "model-a",
      0.9,
      1400,
    );
    (leaderboard as unknown as { setModel: (m: string, q: number, e: number) => void }).setModel(
      "model-b",
      0.8,
      1300,
    );
    const dispatchers: Record<string, Dispatcher> = {
      alpha: new StubDispatcher("alpha"),
      beta: new StubDispatcher("beta"),
    };
    const router = new Router(makeConfig([a, b]), quota, dispatchers, leaderboard);
    const decision = await router.pickService({ hints: { taskType: "execute" } });
    expect(decision).not.toBeNull();
    expect(decision!.service).toBe("alpha");
    expect(decision!.tier).toBe(1);
  });

  it("honors a forced service via hints.service", async () => {
    const a = makeService({ name: "alpha", tier: 1 });
    const b = makeService({ name: "beta", tier: 2 });
    const dispatchers: Record<string, Dispatcher> = {
      alpha: new StubDispatcher("alpha"),
      beta: new StubDispatcher("beta"),
    };
    const router = new Router(makeConfig([a, b]), quota, dispatchers, leaderboard);
    const decision = await router.pickService({ hints: { service: "beta" } });
    expect(decision?.service).toBe("beta");
    expect(decision?.reason).toBe("forced");
  });

  it("skips services whose circuit breaker is tripped", async () => {
    const a = makeService({ name: "alpha", tier: 1 });
    const b = makeService({ name: "beta", tier: 1 });
    const dispatchers: Record<string, Dispatcher> = {
      alpha: new StubDispatcher("alpha"),
      beta: new StubDispatcher("beta"),
    };
    const router = new Router(makeConfig([a, b]), quota, dispatchers, leaderboard);
    const alphaBreaker = router.getBreaker("alpha");
    (alphaBreaker as unknown as { forceTrip(): void }).forceTrip();
    const decision = await router.pickService();
    expect(decision?.service).toBe("beta");
  });

  it("filters candidates by harness hint", async () => {
    const a = makeService({
      name: "alpha",
      harness: "claude_code",
      tier: 1,
    });
    const b = makeService({
      name: "beta",
      harness: "cursor",
      tier: 1,
    });
    const dispatchers: Record<string, Dispatcher> = {
      alpha: new StubDispatcher("alpha"),
      beta: new StubDispatcher("beta"),
    };
    const router = new Router(makeConfig([a, b]), quota, dispatchers, leaderboard);
    const decision = await router.pickService({ hints: { harness: "cursor" } });
    expect(decision?.service).toBe("beta");
  });

  it("falls through to tier-2 when all tier-1 services are broken", async () => {
    const a = makeService({ name: "alpha", tier: 1 });
    const b = makeService({ name: "beta", tier: 2 });
    const dispatchers: Record<string, Dispatcher> = {
      alpha: new StubDispatcher("alpha"),
      beta: new StubDispatcher("beta"),
    };
    const router = new Router(makeConfig([a, b]), quota, dispatchers, leaderboard);
    (router.getBreaker("alpha") as unknown as { forceTrip(): void }).forceTrip();
    const decision = await router.pickService();
    expect(decision?.service).toBe("beta");
    expect(decision?.reason).toMatch(/fallback/);
    expect(decision?.tier).toBe(2);
  });

  it("applies +0.3 prefer_large_context boost to gemini harnesses", async () => {
    const nongemini = makeService({
      name: "alpha",
      harness: "claude_code",
      tier: 2, // force into tier 2 so comparison is apples-to-apples
    });
    const gemini = makeService({
      name: "gemini_cli",
      harness: "gemini_cli",
      tier: 2,
    });
    const dispatchers: Record<string, Dispatcher> = {
      alpha: new StubDispatcher("alpha"),
      gemini_cli: new StubDispatcher("gemini_cli"),
    };
    const router = new Router(
      makeConfig([nongemini, gemini]),
      quota,
      dispatchers,
      leaderboard,
    );
    const withoutBoost = await router.pickService({ hints: { preferLargeContext: false } });
    const withBoost = await router.pickService({ hints: { preferLargeContext: true } });
    // Without the boost they tie and alpha wins (iteration order). With the boost gemini wins.
    expect(withoutBoost?.service).toBe("alpha");
    expect(withBoost?.service).toBe("gemini_cli");
    // And the score delta equals 0.3 exactly for the gemini service.
    expect(withBoost!.finalScore - withoutBoost!.finalScore).toBeCloseTo(0.3, 10);
  });

  it("applies +0.3 taskType=local boost to localhost openai_compatible services", async () => {
    const cloud = makeService({
      name: "cloud",
      tier: 3,
      type: "openai_compatible",
      baseUrl: "https://api.example.com/v1",
    });
    const local = makeService({
      name: "ollama",
      tier: 3,
      type: "openai_compatible",
      baseUrl: "http://localhost:11434/v1",
    });
    const dispatchers: Record<string, Dispatcher> = {
      cloud: new StubDispatcher("cloud"),
      ollama: new StubDispatcher("ollama"),
    };
    const router = new Router(makeConfig([cloud, local]), quota, dispatchers, leaderboard);
    const decision = await router.pickService({ hints: { taskType: "local" } });
    expect(decision?.service).toBe("ollama");
  });

  it("resolves the escalation model when task_type is in escalateOn", async () => {
    const a = makeService({
      name: "alpha",
      model: "default-model",
      escalateModel: "big-model",
      escalateOn: ["plan", "review"],
    });
    const dispatchers: Record<string, Dispatcher> = { alpha: new StubDispatcher("alpha") };
    const router = new Router(makeConfig([a]), quota, dispatchers, leaderboard);
    const executeDec = await router.pickService({ hints: { taskType: "execute" } });
    const planDec = await router.pickService({ hints: { taskType: "plan" } });
    expect(executeDec?.model).toBe("default-model");
    expect(planDec?.model).toBe("big-model");
  });
});

describe("Router.route", () => {
  let quota: QuotaCache;
  let leaderboard: LeaderboardCache;

  beforeEach(() => {
    quota = new QuotaCache();
    leaderboard = new LeaderboardCache();
  });

  it("returns the successful result on first attempt", async () => {
    const a = makeService({ name: "alpha", tier: 1 });
    const dispatcher = new StubDispatcher("alpha");
    const router = new Router(
      makeConfig([a]),
      quota,
      { alpha: dispatcher },
      leaderboard,
    );
    const { result, decision } = await router.route("hi", [], "/tmp");
    expect(result.success).toBe(true);
    expect(result.output).toBe("ok from alpha");
    expect(decision?.service).toBe("alpha");
    expect(decision?.reason).not.toMatch(/fallback/);
  });

  it("falls back on transient error (non-rate-limited)", async () => {
    const a = makeService({ name: "alpha", tier: 1, leaderboardModel: "model-a" });
    const b = makeService({ name: "beta", tier: 1, leaderboardModel: "model-b" });
    (leaderboard as unknown as { setModel: (m: string, q: number, e: number) => void }).setModel(
      "model-a",
      0.9,
      1400,
    );
    (leaderboard as unknown as { setModel: (m: string, q: number, e: number) => void }).setModel(
      "model-b",
      0.85,
      1350,
    );
    const alphaD = new StubDispatcher("alpha");
    alphaD.setResult({ success: false, error: "boom" });
    const betaD = new StubDispatcher("beta");
    const router = new Router(
      makeConfig([a, b]),
      quota,
      { alpha: alphaD, beta: betaD },
      leaderboard,
    );
    const { result, decision } = await router.route("hi", [], "/tmp", {
      hints: { taskType: "execute" },
    });
    expect(result.success).toBe(true);
    expect(decision?.service).toBe("beta");
    expect(decision?.reason).toMatch(/fallback #1/);
  });

  it("does not retry on rate-limited result", async () => {
    const a = makeService({ name: "alpha", tier: 1 });
    const b = makeService({ name: "beta", tier: 1 });
    const alphaD = new StubDispatcher("alpha");
    alphaD.setResult({
      success: false,
      rateLimited: true,
      error: "429",
    } as Partial<DispatchResult>);
    const betaD = new StubDispatcher("beta");
    const router = new Router(
      makeConfig([a, b]),
      quota,
      { alpha: alphaD, beta: betaD },
      leaderboard,
    );
    const { result } = await router.route("hi", [], "/tmp");
    expect(result.success).toBe(false);
    // Beta should never have been called
    expect(betaD.calls.length).toBe(0);
  });

  it("returns a synthesized failure when no services are available", async () => {
    const router = new Router(makeConfig([]), quota, {}, leaderboard);
    const { result, decision } = await router.route("hi", [], "/tmp");
    expect(result.success).toBe(false);
    expect(result.service).toBe("none");
    expect(decision).toBeNull();
  });
});

describe("Router.routeTo", () => {
  let quota: QuotaCache;
  let leaderboard: LeaderboardCache;

  beforeEach(() => {
    quota = new QuotaCache();
    leaderboard = new LeaderboardCache();
  });

  it("returns an error for unknown service", async () => {
    const router = new Router(makeConfig([]), quota, {}, leaderboard);
    const { result, decision } = await router.routeTo("nope", "hi", [], "/tmp");
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Unknown service/);
    expect(decision).toBeNull();
  });

  it("dispatches directly to the requested service with reason 'explicit'", async () => {
    const a = makeService({ name: "alpha", tier: 1 });
    const router = new Router(
      makeConfig([a]),
      quota,
      { alpha: new StubDispatcher("alpha") },
      leaderboard,
    );
    const { decision } = await router.routeTo("alpha", "hi", [], "/tmp");
    expect(decision?.reason).toBe("explicit");
    expect(decision?.service).toBe("alpha");
  });
});
