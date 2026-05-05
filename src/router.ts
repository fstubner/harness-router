/**
 * Model-first router.
 *
 * The user declares a *model preference order* and which CLI services can
 * serve each model in two cost tiers (subscription vs metered). To dispatch:
 *
 *   1. Walk the model priority list.
 *   2. For the highest-priority model: try every subscription route
 *      (highest quota first). Only when every subscription route is
 *      exhausted, fall through to the metered routes for the same model.
 *   3. When both tiers of the current model are exhausted, drop to the
 *      next model in priority order.
 *
 * That's the whole algorithm. No quality scoring, no harness multipliers,
 * no per-task-type capability matrix — those numbers were vibes. The
 * algorithm needs only what's measurable: "CLI installed", "breaker closed",
 * "quota score".
 *
 * Walking subscription→metered per-model (rather than all-subscriptions
 * globally then all-metered globally) preserves "model preference primary,
 * cost secondary": when the user wants Opus, they'll pay metered for Opus
 * before silently dropping to Sonnet.
 *
 * Wraps the streaming generator in a router span so OTel observers see
 * `harness-router-mcp.router.{stream,route}` spans the same way as before.
 */

import { context, SpanStatusCode, trace } from "@opentelemetry/api";

import type {
  DispatchResult,
  DispatcherEvent,
  RouterConfig,
  RoutingDecision,
  RouteHints,
} from "./types.js";
import { CircuitBreaker } from "./circuit-breaker.js";
import type { QuotaCache } from "./quota.js";
import type { Dispatcher } from "./dispatchers/base.js";

import { withDispatcherSpan, withRouterSpan } from "./observability/spans.js";
import type { RouterSpanAttrs } from "./observability/spans.js";
import { VERSION } from "./version.js";

// ---------------------------------------------------------------------------
// Streaming event shape (unchanged from v1 surface)
// ---------------------------------------------------------------------------

/**
 * Router streaming events wrap a dispatcher event with the active routing
 * decision. The decision is emitted on the first event of each dispatch
 * attempt so consumers can show "routing to claude_code" before the first
 * token arrives, and is also attached to every subsequent event in case the
 * consumer missed the first.
 */
export interface RouterStreamEvent {
  event: DispatcherEvent;
  decision: RoutingDecision | null;
}

// ---------------------------------------------------------------------------
// Internal: derived route table
// ---------------------------------------------------------------------------

interface ModelRoute {
  /** Subscription-backed services. Try first, in declared order. */
  subscription: string[];
  /** Metered services. Try only after subscription tier exhausted. */
  metered: string[];
}

/**
 * Auto-derive `{model -> tiered routes}` from the flat services map plus
 * the user's model_priority. A service contributes to `subscription` /
 * `metered` based on its `tier` field; it appears under every model it can
 * serve (`model` field, treated as the canonical ID).
 *
 * Services without a `model` field are skipped — there's no model to attach
 * them to.
 */
function deriveModelRoutes(
  config: RouterConfig,
  dispatchers: Record<string, Dispatcher>,
): Record<string, ModelRoute> {
  const routes: Record<string, ModelRoute> = {};
  const ensure = (model: string): ModelRoute => {
    let entry = routes[model];
    if (!entry) {
      entry = { subscription: [], metered: [] };
      routes[model] = entry;
    }
    return entry;
  };

  for (const [name, svc] of Object.entries(config.services)) {
    if (!svc.enabled) continue;
    if (!(name in dispatchers)) continue;
    if (!svc.model) continue;
    const route = ensure(svc.model);
    if (svc.tier === "metered") route.metered.push(name);
    else route.subscription.push(name);
  }
  return routes;
}

// ---------------------------------------------------------------------------
// Span helper for streaming
// ---------------------------------------------------------------------------

async function* withRouterStreamSpan<T>(
  attrs: RouterSpanAttrs,
  produce: () => AsyncIterable<T>,
): AsyncGenerator<T> {
  const tracer = trace.getTracer("harness-router-mcp", VERSION);
  const { "router.op": op, ...rest } = attrs;
  const span = tracer.startSpan(`harness-router-mcp.router.${op}`, {
    attributes: { ...rest, "router.op": op },
  });
  const t0 = Date.now();
  const ctx = trace.setSpan(context.active(), span);
  const iter = context.with(ctx, () => produce()[Symbol.asyncIterator]());
  let innerDone = false;
  try {
    while (true) {
      const r = await context.with(ctx, () => iter.next());
      if (r.done) {
        innerDone = true;
        break;
      }
      yield r.value;
    }
    span.setStatus({ code: SpanStatusCode.OK });
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err));
    span.recordException(e);
    span.setStatus({ code: SpanStatusCode.ERROR, message: e.message });
    throw err;
  } finally {
    if (!innerDone && iter.return) {
      try {
        await context.with(ctx, () => iter.return!());
      } catch {
        // best-effort
      }
    }
    span.setAttribute("duration_ms", Date.now() - t0);
    span.end();
  }
}

// Walked in this order within each model. Subscription first.
const TIER_ORDER: ReadonlyArray<"subscription" | "metered"> = ["subscription", "metered"];

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

/**
 * Service router: model-first, with subscription/metered tier fallback.
 *
 * One `Router` instance owns its own circuit breakers (one per service),
 * shares the supplied {@link QuotaCache}, and reads the auto-derived route
 * map from `config.services` + `config.modelPriority`. Hot config reload
 * via `ConfigHotReloader` constructs a fresh `Router` and preserves
 * tripped breakers via `restoreTripped()`.
 */
export class Router {
  private readonly breakers: Map<string, CircuitBreaker> = new Map();
  private readonly modelRoutes: Record<string, ModelRoute>;

  constructor(
    private readonly config: RouterConfig,
    private readonly quota: QuotaCache,
    private readonly dispatchers: Record<string, Dispatcher>,
  ) {
    for (const name of Object.keys(config.services)) {
      this.breakers.set(name, new CircuitBreaker());
    }
    this.modelRoutes = deriveModelRoutes(config, dispatchers);
  }

  getBreaker(service: string): CircuitBreaker | undefined {
    return this.breakers.get(service);
  }

  /**
   * Lookup the registered routes for a canonical model. Returns subscription
   * and metered service lists (declared order). Empty lists for unknown
   * models. Used by `code_mixture` to resolve the `models` axis to one
   * service per model — the caller picks the first usable entry (subscription
   * tier preferred).
   */
  servicesForModel(model: string): {
    subscription: readonly string[];
    metered: readonly string[];
  } {
    const route = this.modelRoutes[model];
    if (!route) return { subscription: [], metered: [] };
    return { subscription: route.subscription, metered: route.metered };
  }

  circuitBreakerStatus(): Record<string, ReturnType<CircuitBreaker["status"]>> {
    const out: Record<string, ReturnType<CircuitBreaker["status"]>> = {};
    for (const [name, b] of this.breakers) out[name] = b.status();
    return out;
  }

  /**
   * Pure routing decision. Walks the model priority list, returns the best
   * available (model, service, tier) triple. Returns `null` when every
   * model has zero usable routes across all tiers.
   *
   * `hints.service` (force a specific service) bypasses the priority walk
   * and returns that service if usable. `hints.model` bumps a specific
   * model to the front of the priority list.
   */
  async pickService(
    opts: {
      hints?: RouteHints;
      exclude?: Set<string>;
    } = {},
  ): Promise<RoutingDecision | null> {
    const exclude = opts.exclude ?? new Set<string>();
    const hints = opts.hints ?? {};

    // Forced service: bypass priority walk.
    if (hints.service) {
      const svc = hints.service;
      if (!this.isUsable(svc, exclude)) return null;
      const cfg = this.config.services[svc];
      if (!cfg) return null;
      const quotaScore = await this.quota.getQuotaScore(svc);
      return {
        model: cfg.model ?? "",
        service: svc,
        tier: cfg.tier ?? "subscription",
        quotaScore,
        reason: "forced",
      };
    }

    const priority = this.priorityWithOverride(hints.model);

    for (const model of priority) {
      const routes = this.modelRoutes[model];
      if (!routes) continue;

      for (const tier of TIER_ORDER) {
        const tierServices = tier === "subscription" ? routes.subscription : routes.metered;
        const candidates = tierServices.filter((svc) => this.isUsable(svc, exclude));
        if (candidates.length === 0) continue;

        // Score: quota desc, declared order tiebreaker.
        const scored: Array<{ svc: string; quotaScore: number; rank: number }> = [];
        for (let i = 0; i < candidates.length; i++) {
          const svc = candidates[i]!;
          const quotaScore = await this.quota.getQuotaScore(svc);
          scored.push({ svc, quotaScore, rank: i });
        }
        scored.sort((a, b) => b.quotaScore - a.quotaScore || a.rank - b.rank);

        const winner = scored[0]!;
        return {
          model,
          service: winner.svc,
          tier,
          quotaScore: winner.quotaScore,
          reason:
            `model=${model} tier=${tier} svc=${winner.svc} ` +
            `quota=${winner.quotaScore.toFixed(2)} (${candidates.length} ` +
            `candidate${candidates.length === 1 ? "" : "s"})`,
        };
      }
    }
    return null;
  }

  /**
   * Stream events from the chosen dispatcher with full route fallback.
   * On rate-limit or hard failure, transparently retries the next route
   * in the same tier, then the next tier of the same model, then the
   * next model in priority order.
   */
  stream(
    prompt: string,
    files: string[],
    workingDir: string,
    opts: { hints?: RouteHints } = {},
  ): AsyncIterable<RouterStreamEvent> {
    return this.streamWithSpan(prompt, files, workingDir, opts);
  }

  private async *streamWithSpan(
    prompt: string,
    files: string[],
    workingDir: string,
    opts: { hints?: RouteHints },
  ): AsyncGenerator<RouterStreamEvent> {
    const attrs: RouterSpanAttrs = { "router.op": "stream" };
    yield* withRouterStreamSpan(attrs, () => this.runStream(prompt, files, workingDir, opts));
  }

  private async *runStream(
    prompt: string,
    files: string[],
    workingDir: string,
    opts: { hints?: RouteHints },
  ): AsyncGenerator<RouterStreamEvent> {
    const hints = opts.hints ?? {};
    const exclude = new Set<string>();
    let lastDecision: RoutingDecision | null = null;

    // No artificial attempt cap — pickService returns null when no routes
    // remain (combination of `exclude` set, tripped breakers, unavailable
    // dispatchers). Since `exclude` only grows and breaker state only goes
    // tripped→tripped within a single dispatch (auto-resets need real time
    // to elapse), this loop terminates after at most O(services) iterations.
    while (true) {
      const decision = await this.pickService({ hints, exclude });
      if (!decision) {
        if (lastDecision === null) {
          const breakerInfo: Record<string, ReturnType<CircuitBreaker["status"]>> = {};
          for (const [name, b] of this.breakers) breakerInfo[name] = b.status();
          const services = Object.entries(this.config.services).filter(([, s]) => s.enabled);
          const reachable = services.filter(([n]) => this.dispatchers[n]?.isAvailable());
          // Only the *reachable* services' breakers matter for the "all tripped"
          // check. A non-reachable service whose breaker happens to be closed
          // shouldn't disqualify the rate-limit branch, and conversely a
          // reachable service with a closed breaker means the cause isn't
          // rate-limiting (it's a model-priority mismatch).
          const reachableTripped = reachable.filter(([n]) => breakerInfo[n]?.tripped);
          const trippedSummary = reachableTripped
            .map(([n]) => `${n} (${Math.round(breakerInfo[n]?.cooldownRemainingSec ?? 0)}s)`)
            .join(", ");
          const reasonPart =
            services.length === 0
              ? "no services configured"
              : reachable.length === 0
                ? "no service is installed/reachable on this machine"
                : reachableTripped.length === reachable.length
                  ? `every reachable service is rate-limited: ${trippedSummary}`
                  : "no reachable service has a model matching the priority list";
          const result: DispatchResult = {
            output: "",
            service: "none",
            success: false,
            error:
              `No available routes — ${reasonPart}. ` +
              "Run `harness-router-mcp doctor` to see what's installed and what's missing.",
          };
          yield { event: { type: "completion", result }, decision: null };
        }
        return;
      }
      lastDecision = decision;

      const dispatcher = this.dispatchers[decision.service];
      if (!dispatcher) {
        exclude.add(decision.service);
        continue;
      }

      // Use the service's `cliModel` (the CLI-specific name) when set, so
      // canonical routing names in `modelPriority` can differ from what each
      // CLI actually accepts via `--model`. Falls back to the canonical name.
      const cfg = this.config.services[decision.service];
      const cliModel = cfg?.cliModel ?? decision.model;
      const dispatchOpts: { modelOverride?: string } = {};
      if (cliModel) dispatchOpts.modelOverride = cliModel;

      let finalResult: DispatchResult | null = null;
      for await (const event of dispatcher.stream(prompt, files, workingDir, dispatchOpts)) {
        yield { event, decision };
        if (event.type === "completion") finalResult = event.result;
      }
      if (finalResult === null) {
        finalResult = {
          output: "",
          service: decision.service,
          success: false,
          error: "Dispatcher stream ended without a completion event",
        };
      }
      this.handleResult(decision.service, finalResult);

      if (finalResult.success) return;
      exclude.add(decision.service);
      // Fall through to next route — pickService walks priority/tier chain.
    }
  }

  /**
   * Stream from a specific service, bypassing the priority walk. Same
   * signature as `stream()` but always uses the named service.
   */
  streamTo(
    service: string,
    prompt: string,
    files: string[],
    workingDir: string,
  ): AsyncIterable<RouterStreamEvent> {
    return withRouterStreamSpan({ "router.op": "stream" }, () =>
      this.runStreamTo(service, prompt, files, workingDir),
    );
  }

  private async *runStreamTo(
    service: string,
    prompt: string,
    files: string[],
    workingDir: string,
  ): AsyncGenerator<RouterStreamEvent> {
    if (!(service in this.dispatchers)) {
      yield {
        event: {
          type: "completion",
          result: {
            output: "",
            service,
            success: false,
            error: `Unknown service: ${service}`,
          },
        },
        decision: null,
      };
      return;
    }

    const breaker = this.breakers.get(service);
    if (breaker && breaker.isTripped) {
      const cd = Math.round(breaker.cooldownRemaining() * 10) / 10;
      yield {
        event: {
          type: "completion",
          result: {
            output: "",
            service,
            success: false,
            error: `'${service}' is circuit-broken — ${cd}s cooldown remaining`,
          },
        },
        decision: null,
      };
      return;
    }

    const cfg = this.config.services[service]!;
    const quotaScore = await this.quota.getQuotaScore(service);
    const decision: RoutingDecision = {
      model: cfg.model ?? "",
      service,
      tier: cfg.tier ?? "subscription",
      quotaScore,
      reason: "explicit",
    };

    // Same cli_model fallback as runStream — without this, services with a
    // distinct cli_model (e.g. canonical "claude-opus-4.7" → CLI alias "opus")
    // would get the canonical name passed to --model and the CLI would reject it.
    const cliModel = cfg.cliModel ?? cfg.model;
    const dispatcher = this.dispatchers[service]!;
    const dispatchOpts: { modelOverride?: string } = {};
    if (cliModel) dispatchOpts.modelOverride = cliModel;

    let finalResult: DispatchResult | null = null;
    for await (const event of dispatcher.stream(prompt, files, workingDir, dispatchOpts)) {
      yield { event, decision };
      if (event.type === "completion") finalResult = event.result;
    }
    if (finalResult === null) {
      finalResult = {
        output: "",
        service,
        success: false,
        error: "Dispatcher stream ended without a completion event",
      };
      yield { event: { type: "completion", result: finalResult }, decision };
    }
    this.handleResult(service, finalResult);
  }

  /**
   * Buffered dispatch: drains the streaming generator and returns the
   * final result + decision. Convenient for callers that don't need
   * progressive output.
   */
  async route(
    prompt: string,
    files: string[],
    workingDir: string,
    opts: { hints?: RouteHints } = {},
  ): Promise<{ result: DispatchResult; decision: RoutingDecision | null }> {
    return withRouterSpan({ "router.op": "route" }, async (span) => {
      let lastDecision: RoutingDecision | null = null;
      let lastResult: DispatchResult | null = null;
      for await (const ev of this.runStream(prompt, files, workingDir, opts)) {
        if (ev.decision) lastDecision = ev.decision;
        if (ev.event.type === "completion") lastResult = ev.event.result;
      }
      const result = lastResult ?? {
        output: "",
        service: "none",
        success: false,
        error: "Router exhausted all attempts.",
      };
      if (lastDecision) {
        span.setAttribute("service", lastDecision.service);
        if (lastDecision.model) span.setAttribute("model", lastDecision.model);
        span.setAttribute("tier", lastDecision.tier);
      }
      span.setAttribute("success", result.success);
      return { result, decision: lastDecision };
    });
  }

  /**
   * Buffered dispatch to a specific service. Bypasses priority walk.
   */
  async routeTo(
    service: string,
    prompt: string,
    files: string[],
    workingDir: string,
  ): Promise<{ result: DispatchResult; decision: RoutingDecision | null }> {
    if (!(service in this.dispatchers)) {
      return {
        result: {
          output: "",
          service,
          success: false,
          error: `Unknown service: ${service}`,
        },
        decision: null,
      };
    }
    const breaker = this.breakers.get(service);
    if (breaker && breaker.isTripped) {
      const cd = Math.round(breaker.cooldownRemaining() * 10) / 10;
      return {
        result: {
          output: "",
          service,
          success: false,
          error: `'${service}' is circuit-broken — ${cd}s cooldown remaining`,
        },
        decision: null,
      };
    }

    const cfg = this.config.services[service]!;
    const quotaScore = await this.quota.getQuotaScore(service);
    const decision: RoutingDecision = {
      model: cfg.model ?? "",
      service,
      tier: cfg.tier ?? "subscription",
      quotaScore,
      reason: "explicit",
    };
    // cli_model fallback — see runStreamTo / runStream for context.
    const cliModel = cfg.cliModel ?? cfg.model;
    const dispatchOpts: { modelOverride?: string } = {};
    if (cliModel) dispatchOpts.modelOverride = cliModel;
    const result = await withDispatcherSpan(
      "dispatch",
      { "dispatcher.id": service, ...(decision.model ? { model: decision.model } : {}) },
      async (span) => {
        const r = await this.dispatchers[service]!.dispatch(
          prompt,
          files,
          workingDir,
          dispatchOpts,
        );
        span.setAttribute("success", r.success);
        if (r.rateLimited) span.setAttribute("rate_limited", true);
        return r;
      },
    );
    this.handleResult(service, result);
    return { result, decision };
  }

  // ------------------------------------------------------------------------
  // Internals
  // ------------------------------------------------------------------------

  private priorityWithOverride(override: string | undefined): readonly string[] {
    const priority: readonly string[] = this.config.modelPriority ?? [];
    if (!override) return priority;
    if (!this.modelRoutes[override]) return priority;
    return [override, ...priority.filter((m) => m !== override)];
  }

  private isUsable(svc: string, exclude: Set<string>): boolean {
    if (exclude.has(svc)) return false;
    const dispatcher = this.dispatchers[svc];
    if (!dispatcher || !dispatcher.isAvailable()) return false;
    const breaker = this.breakers.get(svc);
    if (breaker && breaker.isTripped) return false;
    return true;
  }

  /**
   * Record the outcome of a dispatch: forward to the quota cache and
   * update the service's circuit breaker (success → reset; rate-limited →
   * trip; other failure → increment, trip at threshold).
   */
  private handleResult(service: string, result: DispatchResult): void {
    this.quota.recordResult(service, result);
    const breaker = this.breakers.get(service);
    if (!breaker) return;
    if (result.success) {
      breaker.recordSuccess();
    } else if (result.rateLimited) {
      breaker.trip(result.retryAfter);
    } else {
      breaker.recordFailure(result.retryAfter);
    }
  }
}
