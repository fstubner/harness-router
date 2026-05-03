/**
 * Streaming-specific tests for the Router.
 *
 * Verifies the streaming surface — event flow, fallback semantics on
 * failures, breaker integration on `streamTo`, and parity between buffered
 * `route()` and streaming `stream()`. Algorithm coverage lives in
 * tests/router.test.ts; this file focuses on the per-event mechanics.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { Router } from "../../src/router.js";
import { QuotaCache } from "../../src/quota.js";
import type {
  DispatchResult,
  DispatcherEvent,
  RouterConfig,
  ServiceConfig,
} from "../../src/types.js";
import type { Dispatcher } from "../../src/dispatchers/base.js";

function svc(name: string, overrides: Partial<ServiceConfig> = {}): ServiceConfig {
  return {
    name,
    enabled: true,
    type: "cli",
    model: `${name}-model`,
    tier: "subscription",
    ...overrides,
  } as ServiceConfig;
}

function makeConfig(services: ServiceConfig[]): RouterConfig {
  const map: Record<string, ServiceConfig> = {};
  const priority: string[] = [];
  for (const s of services) {
    map[s.name] = s;
    if (s.model && !priority.includes(s.model)) priority.push(s.model);
  }
  return { services: map, modelPriority: priority };
}

class ScriptedDispatcher implements Dispatcher {
  readonly id: string;
  private readonly scripts: DispatcherEvent[][] = [];
  dispatchCalls = 0;
  streamCalls = 0;

  constructor(id: string) {
    this.id = id;
  }

  push(events: DispatcherEvent[]): void {
    this.scripts.push(events);
  }

  isAvailable(): boolean {
    return true;
  }

  async checkQuota() {
    return { service: this.id, source: "unknown" as const };
  }

  async dispatch(): Promise<DispatchResult> {
    this.dispatchCalls += 1;
    const script = this.scripts.shift() ?? [];
    const completion = script.find((e) => e.type === "completion");
    if (completion?.type === "completion") return completion.result;
    return { output: "", service: this.id, success: false, error: "no script" };
  }

  stream(): AsyncIterable<DispatcherEvent> {
    this.streamCalls += 1;
    const script = this.scripts.shift() ?? [];
    async function* gen() {
      for (const e of script) yield e;
    }
    return gen();
  }
}

describe("Router.stream — event flow", () => {
  let quota: QuotaCache;
  beforeEach(() => {
    quota = new QuotaCache({});
  });

  it("emits events from the picked dispatcher with the active decision", async () => {
    const alpha = new ScriptedDispatcher("alpha");
    alpha.push([
      { type: "stdout", chunk: "chunk-1" },
      { type: "stdout", chunk: "chunk-2" },
      {
        type: "completion",
        result: { output: "chunk-1chunk-2", service: "alpha", success: true },
      },
    ]);
    const router = new Router(makeConfig([svc("alpha")]), quota, { alpha });
    const events: DispatcherEvent[] = [];
    let decisionSeen = false;
    for await (const { event, decision } of router.stream("p", [], "/tmp")) {
      events.push(event);
      if (decision) decisionSeen = true;
    }
    expect(decisionSeen).toBe(true);
    expect(events.filter((e) => e.type === "stdout").length).toBe(2);
    expect(events[events.length - 1]?.type).toBe("completion");
  });

  it("falls through to the next route on transient (non-rate-limit) failure", async () => {
    const alpha = new ScriptedDispatcher("alpha");
    alpha.push([
      { type: "stderr", chunk: "transient error" },
      {
        type: "completion",
        result: { output: "", service: "alpha", success: false, error: "transient" },
      },
    ]);
    const beta = new ScriptedDispatcher("beta");
    beta.push([
      { type: "stdout", chunk: "beta-ok" },
      {
        type: "completion",
        result: { output: "beta-ok", service: "beta", success: true },
      },
    ]);
    // Same model so beta is in the same route list as a fallback after alpha.
    const router = new Router(
      makeConfig([svc("alpha", { model: "shared-model" }), svc("beta", { model: "shared-model" })]),
      quota,
      { alpha, beta },
    );

    const services: string[] = [];
    let finalSuccess = false;
    for await (const { event, decision } of router.stream("p", [], "/tmp")) {
      if (decision) services.push(decision.service);
      if (event.type === "completion") finalSuccess = event.result.success;
    }
    expect(alpha.streamCalls).toBe(1);
    expect(beta.streamCalls).toBe(1);
    expect(finalSuccess).toBe(true);
    expect(new Set(services)).toEqual(new Set(["alpha", "beta"]));
  });

  it("rate-limited routes still trip breaker and fall through to next route", async () => {
    // The new model-first router treats rate-limit as a per-route exclusion:
    // exclude alpha, trip breaker, try beta. (Previous router stopped on
    // rate-limit; new router keeps going so the user gets a response.)
    const alpha = new ScriptedDispatcher("alpha");
    alpha.push([
      {
        type: "completion",
        result: {
          output: "",
          service: "alpha",
          success: false,
          error: "rate limit",
          rateLimited: true,
          retryAfter: 30,
        },
      },
    ]);
    const beta = new ScriptedDispatcher("beta");
    beta.push([
      {
        type: "completion",
        result: { output: "beta", service: "beta", success: true },
      },
    ]);
    const router = new Router(
      makeConfig([svc("alpha", { model: "shared-model" }), svc("beta", { model: "shared-model" })]),
      quota,
      { alpha, beta },
    );
    let finalSuccess = false;
    for await (const { event } of router.stream("p", [], "/tmp")) {
      if (event.type === "completion") finalSuccess = event.result.success;
    }
    expect(alpha.streamCalls).toBe(1);
    expect(beta.streamCalls).toBe(1);
    expect(finalSuccess).toBe(true);
    expect(router.getBreaker("alpha")?.isTripped).toBe(true);
  });

  it("yields an error completion when no service is available", async () => {
    const router = new Router(makeConfig([svc("alpha", { enabled: false })]), quota, {});
    const events: DispatcherEvent[] = [];
    for await (const { event } of router.stream("p", [], "/tmp")) events.push(event);
    expect(events.length).toBe(1);
    expect(events[0]?.type).toBe("completion");
    if (events[0]?.type === "completion") {
      expect(events[0].result.success).toBe(false);
      expect(events[0].result.error).toMatch(/no available routes/i);
    }
  });
});

describe("Router.streamTo — direct dispatch", () => {
  let quota: QuotaCache;
  beforeEach(() => {
    quota = new QuotaCache({});
  });

  it("streamTo bypasses priority walk and attaches an explicit decision", async () => {
    const alpha = new ScriptedDispatcher("alpha");
    alpha.push([
      {
        type: "completion",
        result: { output: "direct", service: "alpha", success: true },
      },
    ]);
    const router = new Router(makeConfig([svc("alpha"), svc("beta")]), quota, { alpha });
    const services: string[] = [];
    for await (const { decision } of router.streamTo("alpha", "p", [], "/tmp")) {
      if (decision) services.push(decision.service);
    }
    expect(alpha.streamCalls).toBe(1);
    expect(services[0]).toBe("alpha");
  });

  it("streamTo emits an error completion for an unknown service", async () => {
    const router = new Router(makeConfig([svc("alpha")]), quota, {});
    const events: Array<{ type: string; result?: { success: boolean; error?: string } }> = [];
    for await (const { event } of router.streamTo("nonexistent", "p", [], "/tmp")) {
      events.push(event as { type: string; result?: { success: boolean; error?: string } });
    }
    const completion = events.find((e) => e.type === "completion");
    expect(completion).toBeDefined();
    expect(completion?.result?.success).toBe(false);
    expect(completion?.result?.error).toMatch(/nonexistent/i);
  });

  it("streamTo emits an error completion when the service's circuit breaker is tripped", async () => {
    const alpha = new ScriptedDispatcher("alpha");
    const router = new Router(makeConfig([svc("alpha")]), quota, { alpha });
    router.getBreaker("alpha")!.trip();

    const events: Array<{ type: string; result?: { success: boolean; error?: string } }> = [];
    for await (const { event } of router.streamTo("alpha", "p", [], "/tmp")) {
      events.push(event as { type: string; result?: { success: boolean; error?: string } });
    }
    const completion = events.find((e) => e.type === "completion");
    expect(completion).toBeDefined();
    expect(completion?.result?.success).toBe(false);
    expect(alpha.streamCalls).toBe(0);
  });
});

describe("Router.route — buffered surface", () => {
  let quota: QuotaCache;
  beforeEach(() => {
    quota = new QuotaCache({});
  });

  it("buffered route() drains the streaming generator and returns the final result", async () => {
    const alpha = new ScriptedDispatcher("alpha");
    alpha.push([
      {
        type: "completion",
        result: { output: "buffered", service: "alpha", success: true },
      },
    ]);
    const router = new Router(makeConfig([svc("alpha")]), quota, { alpha });
    const { result } = await router.route("p", [], "/tmp");
    expect(result.success).toBe(true);
    expect(result.output).toBe("buffered");
  });
});
