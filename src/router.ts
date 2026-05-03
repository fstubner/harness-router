/**
 * Load-balancing router for harness-router-mcp.
 *
 * Routing strategy
 * ----------------
 * Services are grouped by tier (lower number = higher quality). The router
 * always exhausts the current tier before falling to the next:
 *
 *   Tier 1 (frontier)  ->  Tier 2 (strong)  ->  Tier 3 (fast/local)
 *
 * A tier is considered exhausted when every service in it is circuit-broken
 * (rate-limited or repeatedly failing).
 *
 * Quality scoring
 * ---------------
 * Within a tier, services are ranked by a composite score:
 *
 *   final_score = quality_score * cli_capability * capability[task_type]
 *                 * quota_score * weight
 *
 * Infrastructure adjustments:
 *  - +0.3 when prefer_large_context is set and the service's harness is gemini
 *    or gemini_cli.
 *  - +0.3 when task_type="local" and the service is an openai_compatible
 *    endpoint on localhost / 127.0.0.1.
 *
 * Tier auto-derivation
 * --------------------
 * If a service has `leaderboardModel` set in config, its tier is
 * auto-derived from the Arena ELO score via LeaderboardCache.autoTier().
 * Explicit `tier` in config is the fallback when ELO is unavailable.
 *
 * R3: adds `stream()` / `streamTo()` that emit `DispatcherEvent`s with an
 * attached `RoutingDecision`. The buffered `route` / `routeTo` methods are
 * reimplemented on top of the streaming primitives.
 */

import type {
  DispatchResult,
  DispatcherEvent,
  RouterConfig,
  RoutingDecision,
  RouteHints,
  ServiceConfig,
  TaskType,
} from "./types.js";
import { CircuitBreaker } from "./circuit-breaker.js";
import type { QuotaCache } from "./quota.js";
import type { LeaderboardCache } from "./leaderboard.js";
import type { Dispatcher } from "./dispatchers/base.js";
import { context, SpanStatusCode, trace } from "@opentelemetry/api";

import { withDispatcherSpan, withRouterSpan } from "./observability/spans.js";
import type { RouterSpanAttrs } from "./observability/spans.js";
import { VERSION } from "./version.js";

/**
 * Wrap an async iterable in a router span. The span lasts for the entire
 * iteration; success is recorded if iteration completes without throwing.
 *
 * Unlike `withRouterSpan` (which wraps a single `Promise<T>` and would
 * have to buffer streamed values), this preserves backpressure: each
 * yielded value passes through without buffering. The span is ended
 * exactly once when the generator finishes or throws.
 *
 * Establishes the span as the active context across the iteration so child
 * spans (dispatcher span, etc.) created during dispatch are parented to it.
 * Without `context.with(...)` the children would appear as orphans in OTel.
 */
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
  // Pre-construct the iterator inside the active context so any spans the
  // producer opens during construction (rare) are parented correctly.
  const iter = context.with(ctx, () => produce()[Symbol.asyncIterator]());
  // Track whether the inner iterator has already finished naturally — when
  // the consumer breaks out of the outer `for await`, V8 fires our generator's
  // `finally` block and we need to propagate `.return()` ONLY if the inner
  // iterator hasn't already drained.
  let innerDone = false;
  try {
    while (true) {
      // Each `next()` call runs inside the span's context, so spans created
      // by the dispatcher (or anything downstream) inherit it as parent.
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
    // Propagate cancellation to the inner iterator on EVERY exit path that
    // didn't see `r.done === true`. Audit pass A flagged the case where a
    // consumer breaks out of `for await (const x of router.stream(...))`:
    // V8 sends `.return()` to this generator, the `finally` runs, the span
    // ends — but without the explicit `iter.return()` below, the inner
    // `#runStream` generator (and through it, `streamSubprocess`) is left
    // dangling. The child process keeps running until GC eventually fires
    // its finally block. This block ensures deterministic cleanup.
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TASK_TYPES_WITH_CAPABILITY: ReadonlySet<TaskType> = new Set(["execute", "plan", "review"]);

function resolveModel(svc: ServiceConfig, taskType: TaskType): string | undefined {
  if (svc.escalateModel && svc.escalateOn.includes(taskType)) {
    return svc.escalateModel;
  }
  return svc.model;
}

function capabilityScore(svc: ServiceConfig, taskType: TaskType): number {
  if (!TASK_TYPES_WITH_CAPABILITY.has(taskType)) return 1.0;
  const key = taskType as "execute" | "plan" | "review";
  return svc.capabilities[key] ?? 1.0;
}

/**
 * Strict localhost check. Parses the base URL and matches the hostname
 * exactly — `https://localhost-clone.example.com` does NOT count as local.
 */
function isLocalhostUrl(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false;
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Internal candidate tuple
// ---------------------------------------------------------------------------

interface Candidate {
  score: number;
  name: string;
  quotaScore: number;
  qualityScore: number;
  elo: number | null;
  cliCapability: number;
  capScore: number;
}

// ---------------------------------------------------------------------------
// Streaming event shape
// ---------------------------------------------------------------------------

/**
 * Router streaming events wrap the dispatcher event with the active routing
 * decision. The decision is emitted on the first event of each dispatch
 * attempt (so consumers can show "routing to claude_code" before the first
 * token arrives) and is also attached to every subsequent event in case the
 * consumer missed the first.
 */
export interface RouterStreamEvent {
  event: DispatcherEvent;
  decision: RoutingDecision | null;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

/**
 * Service router with quota-aware load balancing and circuit breaking.
 *
 * Pick a service via `pickService()` (returns a {@link RoutingDecision} without
 * dispatching), or run an end-to-end dispatch with `route()` (buffered) or
 * `stream()` (streaming events). Streaming is the canonical primitive — the
 * buffered methods drain a stream and return the final result.
 *
 * One `Router` instance owns its own circuit breakers (one per service) and
 * shares the supplied {@link QuotaCache} and {@link LeaderboardCache}. Hot
 * config reload via `ConfigHotReloader` constructs a fresh `Router` and
 * preserves tripped breakers via `restoreTripped()`.
 *
 * @see RoutingDecision for the scoring output shape.
 * @see RouteHints for the input axes that influence selection.
 */
export class Router {
  private readonly breakers: Map<string, CircuitBreaker> = new Map();

  constructor(
    private readonly config: RouterConfig,
    private readonly quota: QuotaCache,
    private readonly dispatchers: Record<string, Dispatcher>,
    private readonly leaderboard: LeaderboardCache,
  ) {
    for (const name of Object.keys(config.services)) {
      this.breakers.set(name, new CircuitBreaker());
    }
  }

  getBreaker(service: string): CircuitBreaker | undefined {
    return this.breakers.get(service);
  }

  async pickService(
    opts: {
      hints?: RouteHints;
      prompt?: string;
      files?: string[];
      exclude?: Set<string>;
    } = {},
  ): Promise<RoutingDecision | null> {
    const hints = opts.hints ?? {};
    const exclude = opts.exclude ?? new Set<string>();

    const forceService = hints.service;
    const preferLargeContext = hints.preferLargeContext ?? false;
    const taskType: TaskType = hints.taskType ?? "";
    const filterHarness = hints.harness;

    if (forceService) {
      if (!(forceService in this.dispatchers) || exclude.has(forceService)) return null;
      const breaker = this.breakers.get(forceService);
      if (breaker && breaker.isTripped) return null;
      const dispatcher = this.dispatchers[forceService]!;
      if (!dispatcher.isAvailable()) return null;
      const svc = this.config.services[forceService];
      if (!svc) return null;

      const quotaScore = await this.quota.getQuotaScore(forceService);
      const { qualityScore, elo } = await this.leaderboard.getQualityScore(
        svc.leaderboardModel,
        svc.thinkingLevel,
      );
      const capScore = capabilityScore(svc, taskType);
      const finalScore = qualityScore * svc.cliCapability * capScore * quotaScore * svc.weight;

      return {
        service: forceService,
        tier: svc.tier,
        quotaScore,
        qualityScore,
        cliCapability: svc.cliCapability,
        capabilityScore: capScore,
        taskType,
        model: resolveModel(svc, taskType),
        elo: elo ?? undefined,
        finalScore,
        reason: "forced",
      };
    }

    const tierCandidates = new Map<number, Candidate[]>();

    for (const [name, svc] of Object.entries(this.config.services)) {
      if (!svc.enabled) continue;
      if (!(name in this.dispatchers)) continue;
      if (exclude.has(name)) continue;
      const breaker = this.breakers.get(name);
      if (breaker && breaker.isTripped) continue;
      const dispatcher = this.dispatchers[name]!;
      if (!dispatcher.isAvailable()) continue;

      const harnessKey = svc.harness ?? name;
      if (filterHarness && harnessKey !== filterHarness) continue;

      const tier = svc.leaderboardModel
        ? await this.leaderboard.autoTier(svc.leaderboardModel, svc.thinkingLevel, svc.tier)
        : svc.tier;

      const quotaScore = await this.quota.getQuotaScore(name);
      const { qualityScore, elo } = await this.leaderboard.getQualityScore(
        svc.leaderboardModel,
        svc.thinkingLevel,
      );
      const capScore = capabilityScore(svc, taskType);

      const effectiveQuality = qualityScore * svc.cliCapability * capScore;
      let score = effectiveQuality * quotaScore * svc.weight;

      if (preferLargeContext && (harnessKey === "gemini" || harnessKey === "gemini_cli")) {
        score += 0.3;
      }
      if (taskType === "local" && svc.type === "openai_compatible" && isLocalhostUrl(svc.baseUrl)) {
        score += 0.3;
      }

      const bucket = tierCandidates.get(tier);
      const candidate: Candidate = {
        score,
        name,
        quotaScore,
        qualityScore,
        elo,
        cliCapability: svc.cliCapability,
        capScore,
      };
      if (bucket) bucket.push(candidate);
      else tierCandidates.set(tier, [candidate]);
    }

    if (tierCandidates.size === 0) return null;

    // The "tier N fallback" reason should reference the lowest tier we
    // actually *would have considered* — i.e. respecting the same harness
    // filter that was applied above. Without this, asking the router for
    // claude_code services produces a misleading "tier 2 fallback (all
    // tier 1 services exhausted)" when no tier-1 claude_code service ever
    // existed in the first place; the tier-1 service belonged to a
    // different harness that the filter excluded.
    let minConfiguredTier = Infinity;
    for (const [name, svc] of Object.entries(this.config.services)) {
      if (!svc.enabled) continue;
      if (filterHarness !== undefined && (svc.harness ?? name) !== filterHarness) continue;
      if (svc.tier < minConfiguredTier) minConfiguredTier = svc.tier;
    }

    const sortedTiers = [...tierCandidates.keys()].sort((a, b) => a - b);
    for (const tier of sortedTiers) {
      const candidates = tierCandidates.get(tier);
      if (!candidates || candidates.length === 0) continue;

      candidates.sort((a, b) => b.score - a.score);
      const best = candidates[0]!;
      const svc = this.config.services[best.name]!;

      const reason =
        tier > minConfiguredTier
          ? `tier ${tier} fallback (all tier ${minConfiguredTier} services exhausted)`
          : `tier ${tier} best (${candidates.length} available)`;

      return {
        service: best.name,
        tier,
        quotaScore: best.quotaScore,
        qualityScore: best.qualityScore,
        cliCapability: best.cliCapability,
        capabilityScore: best.capScore,
        taskType,
        model: resolveModel(svc, taskType),
        elo: best.elo ?? undefined,
        finalScore: best.score,
        reason,
      };
    }

    return null;
  }

  /**
   * Stream events from the chosen dispatcher, with the same fallback logic
   * as `route()`. When a dispatch fails (non-rate-limit), the router picks
   * another service and yields that service's events — so the caller sees
   * events from potentially multiple services during fallback.
   *
   * The last `completion` or `error` event always reflects the final
   * outcome (success-with-fallback or all-attempts-failed).
   */
  stream(
    prompt: string,
    files: string[],
    workingDir: string,
    opts: { hints?: RouteHints; maxFallbacks?: number } = {},
  ): AsyncIterable<RouterStreamEvent> {
    return this.#streamWithSpan(prompt, files, workingDir, opts);
  }

  async *#streamWithSpan(
    prompt: string,
    files: string[],
    workingDir: string,
    opts: { hints?: RouteHints; maxFallbacks?: number },
  ): AsyncGenerator<RouterStreamEvent> {
    // Wrap the streaming generator in a router span so OTel observers see
    // the same `harness-router-mcp.router.stream` span that buffered
    // `route()` calls already produce. The span lifetime spans the entire
    // iteration — including fallback attempts.
    const attrs = {
      "router.op": "stream" as const,
      ...(opts.hints?.taskType ? { task_type: opts.hints.taskType } : {}),
    };
    yield* withRouterStreamSpan(attrs, () => this.#runStream(prompt, files, workingDir, opts));
  }

  async *#runStream(
    prompt: string,
    files: string[],
    workingDir: string,
    opts: { hints?: RouteHints; maxFallbacks?: number },
  ): AsyncGenerator<RouterStreamEvent> {
    const hints = opts.hints ?? {};
    const maxFallbacks = opts.maxFallbacks ?? 2;
    const tried = new Set<string>();
    let lastDecision: RoutingDecision | null = null;

    for (let attempt = 0; attempt <= maxFallbacks; attempt++) {
      const decision = await this.pickService({
        hints,
        prompt,
        files,
        exclude: tried,
      });

      if (decision === null) {
        if (lastDecision === null) {
          const breakerInfo: Record<string, ReturnType<CircuitBreaker["status"]>> = {};
          for (const [name, b] of this.breakers) breakerInfo[name] = b.status();
          const result: DispatchResult = {
            output: "",
            service: "none",
            success: false,
            error:
              "No available services — all are disabled, exhausted, or circuit-broken. " +
              `Breaker state: ${JSON.stringify(breakerInfo)}`,
          };
          yield { event: { type: "completion", result }, decision: null };
        }
        return;
      }

      // Construct a per-attempt decision so fallback annotation doesn't
      // mutate the object the consumer captured on the first event.
      const attemptDecision: RoutingDecision =
        attempt > 0
          ? { ...decision, reason: `${decision.reason} (fallback #${attempt} — prev failed)` }
          : decision;
      lastDecision = attemptDecision;

      const dispatcher = this.dispatchers[attemptDecision.service]!;
      const dispatchOpts: { modelOverride?: string } = {};
      if (attemptDecision.model !== undefined) dispatchOpts.modelOverride = attemptDecision.model;

      let finalResult: DispatchResult | null = null;
      for await (const event of dispatcher.stream(prompt, files, workingDir, dispatchOpts)) {
        yield { event, decision: attemptDecision };
        if (event.type === "completion") {
          finalResult = event.result;
        }
      }
      if (finalResult === null) {
        // Dispatcher misbehaved — synthesize a failure so handleResult + the
        // caller both see the attempt.
        finalResult = {
          output: "",
          service: attemptDecision.service,
          success: false,
          error: "Dispatcher stream ended without a completion event",
        };
      }
      this.handleResult(attemptDecision.service, finalResult);

      if (finalResult.success) return;
      if (finalResult.rateLimited) return;
      // Transient failure → exclude and try next.
      tried.add(attemptDecision.service);
    }
  }

  /**
   * Stream from a specific service, bypassing tier selection. Same semantics
   * as `routeTo()` but yields events in real time.
   */
  streamTo(
    service: string,
    prompt: string,
    files: string[],
    workingDir: string,
  ): AsyncIterable<RouterStreamEvent> {
    return withRouterStreamSpan({ "router.op": "stream" }, () =>
      this.#runStreamTo(service, prompt, files, workingDir),
    );
  }

  async *#runStreamTo(
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

    const svc = this.config.services[service]!;
    const quotaScore = await this.quota.getQuotaScore(service);
    const { qualityScore, elo } = await this.leaderboard.getQualityScore(
      svc.leaderboardModel,
      svc.thinkingLevel,
    );
    const decision: RoutingDecision = {
      service,
      tier: svc.tier,
      quotaScore,
      qualityScore,
      cliCapability: svc.cliCapability,
      capabilityScore: 1.0,
      taskType: "",
      model: svc.model,
      elo: elo ?? undefined,
      finalScore: qualityScore * svc.cliCapability * quotaScore * svc.weight,
      reason: "explicit",
    };

    const dispatcher = this.dispatchers[service]!;
    const dispatchOpts: { modelOverride?: string } = {};
    if (decision.model !== undefined) dispatchOpts.modelOverride = decision.model;

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
   * Route a task, with automatic fallback on transient failures.
   *
   * Path divergence note: `route()` calls `dispatcher.dispatch()` directly,
   * while `stream()` calls `dispatcher.stream()`. For dispatchers extending
   * `BaseDispatcher`, `dispatch()` is implemented as
   * `drainDispatcherStream(stream())` so the paths converge. For dispatchers
   * that override `dispatch()` (currently only `OpenAICompatibleDispatcher`,
   * to preserve a buffered fast-path), behaviour can differ between the two.
   * If you need single-source-of-truth dispatch behaviour, use `stream()`.
   *
   * The MCP layer picks between buffered `route()` (no progressToken) and
   * streaming `stream()` (progressToken set) at the tool-handler level.
   */
  async route(
    prompt: string,
    files: string[],
    workingDir: string,
    opts: { hints?: RouteHints; maxFallbacks?: number } = {},
  ): Promise<{ result: DispatchResult; decision: RoutingDecision | null }> {
    return withRouterSpan(
      {
        "router.op": "route",
        ...(opts.hints?.taskType ? { task_type: opts.hints.taskType } : {}),
      },
      async (span) => {
        const out = await this.#routeImpl(prompt, files, workingDir, opts);
        if (out.decision) {
          span.setAttribute("service", out.decision.service);
          span.setAttribute("tier", out.decision.tier);
        }
        span.setAttribute("success", out.result.success);
        return out;
      },
    );
  }

  async #routeImpl(
    prompt: string,
    files: string[],
    workingDir: string,
    opts: { hints?: RouteHints; maxFallbacks?: number } = {},
  ): Promise<{ result: DispatchResult; decision: RoutingDecision | null }> {
    const hints = opts.hints ?? {};
    const maxFallbacks = opts.maxFallbacks ?? 2;
    const tried = new Set<string>();
    let lastResult: DispatchResult | null = null;
    let lastDecision: RoutingDecision | null = null;

    for (let attempt = 0; attempt <= maxFallbacks; attempt++) {
      const decision = await this.pickService({
        hints,
        prompt,
        files,
        exclude: tried,
      });

      if (decision === null) {
        if (lastResult !== null) {
          return { result: lastResult, decision: lastDecision };
        }
        const breakerInfo: Record<string, ReturnType<CircuitBreaker["status"]>> = {};
        for (const [name, b] of this.breakers) breakerInfo[name] = b.status();
        return {
          result: {
            output: "",
            service: "none",
            success: false,
            error:
              "No available services — all are disabled, exhausted, or circuit-broken. " +
              `Breaker state: ${JSON.stringify(breakerInfo)}`,
          },
          decision: null,
        };
      }

      const dispatcher = this.dispatchers[decision.service]!;
      const dispatchOpts: { modelOverride?: string } = {};
      if (decision.model !== undefined) dispatchOpts.modelOverride = decision.model;
      // Prefer the buffered dispatch path when it's available — many R1/R2
      // tests assert on dispatcher.dispatch being called once; if we always
      // went through stream() those assertions would break. Dispatchers that
      // extend BaseDispatcher still ultimately funnel through stream(), but
      // dispatchers (like OpenAICompatibleDispatcher) that override dispatch
      // keep their fast-path.
      const spanAttrs: import("./observability/spans.js").DispatcherSpanAttrs = {
        "dispatcher.id": decision.service,
      };
      if (decision.model !== undefined) spanAttrs.model = decision.model;
      if (decision.taskType) spanAttrs["task_type"] = decision.taskType;
      const result = await withDispatcherSpan("dispatch", spanAttrs, async (span) => {
        const r = await dispatcher.dispatch(prompt, files, workingDir, dispatchOpts);
        span.setAttribute("success", r.success);
        if (r.rateLimited) span.setAttribute("rate_limited", true);
        if (r.tokensUsed) {
          span.setAttribute("tokens.input", r.tokensUsed.input);
          span.setAttribute("tokens.output", r.tokensUsed.output);
        }
        return r;
      });
      this.handleResult(decision.service, result);
      lastResult = result;
      // Construct a per-attempt decision so consumers that captured an earlier
      // decision don't see its `reason` mutated. (Same pattern as the streaming
      // path's `attemptDecision`.)
      const annotated: RoutingDecision =
        attempt > 0
          ? { ...decision, reason: `${decision.reason} (fallback #${attempt} — prev failed)` }
          : decision;
      lastDecision = annotated;

      if (result.success) return { result, decision: annotated };
      if (result.rateLimited) return { result, decision: annotated };
      tried.add(decision.service);
    }

    return {
      result: lastResult ?? {
        output: "",
        service: "none",
        success: false,
        error: "Router exhausted all fallback attempts.",
      },
      decision: lastDecision,
    };
  }

  /**
   * Dispatch to a specific service, bypassing tier selection.
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

    const svc = this.config.services[service]!;
    const quotaScore = await this.quota.getQuotaScore(service);
    const { qualityScore, elo } = await this.leaderboard.getQualityScore(
      svc.leaderboardModel,
      svc.thinkingLevel,
    );
    const decision: RoutingDecision = {
      service,
      tier: svc.tier,
      quotaScore,
      qualityScore,
      cliCapability: svc.cliCapability,
      capabilityScore: 1.0,
      taskType: "",
      model: svc.model,
      elo: elo ?? undefined,
      finalScore: qualityScore * svc.cliCapability * quotaScore * svc.weight,
      reason: "explicit",
    };
    const dispatchOpts: { modelOverride?: string } = {};
    if (decision.model !== undefined) dispatchOpts.modelOverride = decision.model;
    const result = await this.dispatchers[service]!.dispatch(
      prompt,
      files,
      workingDir,
      dispatchOpts,
    );
    this.handleResult(service, result);
    return { result, decision };
  }

  /**
   * Record the outcome of a dispatch: forward to the quota cache (which
   * updates rate-limit headers + local call counts) and update the
   * service's circuit breaker (success → reset; rate-limited → trip;
   * other failure → increment failure counter, trip at threshold).
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

  circuitBreakerStatus(): Record<string, ReturnType<CircuitBreaker["status"]>> {
    const out: Record<string, ReturnType<CircuitBreaker["status"]>> = {};
    for (const [name, b] of this.breakers) out[name] = b.status();
    return out;
  }
}
