/**
 * Model-first router (prototype, NOT wired into the MCP server yet).
 *
 * The shipping router (`src/router.ts`) treats every (model × harness) pair
 * as a service competing on a composite score. That made sense when the
 * harness mattered as much as the model. Most days it doesn't — the harness
 * is plumbing, the model is the product.
 *
 * This v2 inverts the algorithm:
 *
 *   1. The user declares a *model preference order* — e.g. ["gpt-5.5",
 *      "claude-opus-4.7", "claude-sonnet-4.6"].
 *   2. For each model, the user (or auto-detect) declares which CLI services
 *      can serve it — the *route map*.
 *   3. To dispatch, walk the priority list. For the highest-priority model
 *      that has at least one available CLI route, pick the route with the
 *      most quota left. Try it. On rate-limit, exclude it for this call and
 *      try the next route for the same model. When every route for a model
 *      is exhausted, drop to the next model.
 *
 * That's the whole algorithm. No quality_score, no cli_capability multiplier,
 * no capabilities[task_type]. Those numbers were vibes, not measurements.
 *
 * Status: prototype. Lives next to the existing router; wiring through the
 * MCP server happens in v0.2.0 once the algorithm shape is validated.
 */

import type { Dispatcher } from "./dispatchers/base.js";
import type { DispatcherEvent } from "./types.js";
import type { CircuitBreaker } from "./circuit-breaker.js";
import type { QuotaCache } from "./quota.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ModelFirstConfig {
  /** Ordered list of model IDs, highest priority first. */
  modelPriority: readonly string[];

  /**
   * Map: model_id -> ordered list of dispatcher service names that can
   * serve it. The order is a tiebreaker after quota — earlier entries win
   * when quota is equal.
   */
  cliRoutes: Readonly<Record<string, readonly string[]>>;
}

export interface RoutingDecisionV2 {
  model: string;
  service: string;
  /** 0..1 — higher means more headroom on this CLI. */
  quotaScore: number;
  /** Human-readable trace ("model=X svc=Y quota=0.83 / 3 candidates"). */
  reason: string;
}

export interface RouterV2Deps {
  config: ModelFirstConfig;
  /** Keyed by service name (matches `cli_routes` values). */
  dispatchers: Readonly<Record<string, Dispatcher>>;
  quota: QuotaCache;
  /** Keyed by service name. May omit entries; missing = treated as closed. */
  breakers: Readonly<Record<string, CircuitBreaker>>;
}

export interface PickRouteOpts {
  /** If set, walk this model's routes first; fall through to priority list. */
  modelOverride?: string;
  /** Skip these services (already failed earlier in the same dispatch). */
  excludeServices?: ReadonlySet<string>;
}

export interface DispatchOpts {
  modelOverride?: string;
}

// ---------------------------------------------------------------------------
// The router
// ---------------------------------------------------------------------------

export class RouterV2 {
  constructor(private readonly deps: RouterV2Deps) {}

  /**
   * Pure routing decision: walk the priority list, return the best
   * available (model, service) pair. No side effects on dispatchers.
   * Returns `null` when every model has zero usable routes.
   */
  async pickRoute(opts: PickRouteOpts = {}): Promise<RoutingDecisionV2 | null> {
    const exclude = opts.excludeServices ?? new Set<string>();
    const priority = this.priorityWithOverride(opts.modelOverride);

    for (const model of priority) {
      const candidates = (this.deps.config.cliRoutes[model] ?? []).filter((svc) =>
        this.isUsable(svc, exclude),
      );
      if (candidates.length === 0) continue;

      // Score: quota desc, then preserve cli_routes order as tiebreaker.
      const scored: Array<{ svc: string; quotaScore: number; rank: number }> = [];
      for (let i = 0; i < candidates.length; i++) {
        const svc = candidates[i]!;
        const quotaScore = await this.deps.quota.getQuotaScore(svc);
        scored.push({ svc, quotaScore, rank: i });
      }
      scored.sort((a, b) => b.quotaScore - a.quotaScore || a.rank - b.rank);

      const winner = scored[0]!;
      return {
        model,
        service: winner.svc,
        quotaScore: winner.quotaScore,
        reason: `model=${model} svc=${winner.svc} quota=${winner.quotaScore.toFixed(2)} (${candidates.length} candidate${candidates.length === 1 ? "" : "s"})`,
      };
    }
    return null;
  }

  /**
   * Stream a dispatch with model + route fallback. Yields every dispatcher
   * event plus the *current* routing decision so the caller can show which
   * service is producing each chunk. On rate-limit or hard failure of the
   * picked service, transparently retries against the next route, walking
   * down the model priority list until something succeeds or everything is
   * exhausted.
   */
  async *stream(
    prompt: string,
    files: string[],
    workingDir: string,
    opts: DispatchOpts = {},
  ): AsyncIterable<{ event: DispatcherEvent; decision: RoutingDecisionV2 | null }> {
    const exclude = new Set<string>();
    let lastDecision: RoutingDecisionV2 | null = null;

    while (true) {
      const pickOpts: PickRouteOpts = { excludeServices: exclude };
      if (opts.modelOverride !== undefined) pickOpts.modelOverride = opts.modelOverride;
      const decision = await this.pickRoute(pickOpts);
      if (!decision) {
        yield {
          event: { type: "error", error: "All model routes exhausted" },
          decision: lastDecision,
        };
        return;
      }
      lastDecision = decision;

      const dispatcher = this.deps.dispatchers[decision.service];
      if (!dispatcher) {
        // Config inconsistency — exclude and continue rather than crash.
        exclude.add(decision.service);
        continue;
      }

      let succeeded = false;
      let rateLimited = false;
      let sawCompletion = false;

      const streamOpts = { modelOverride: decision.model };
      for await (const event of dispatcher.stream(prompt, files, workingDir, streamOpts)) {
        yield { event, decision };
        if (event.type === "completion") {
          sawCompletion = true;
          succeeded = event.result.success;
          rateLimited = event.result.rateLimited === true;
        }
      }

      if (succeeded) return;
      // Failure of any kind — exclude this service and retry. Rate-limits
      // also mark the breaker so subsequent dispatches in this process
      // skip the service for the cooldown window.
      exclude.add(decision.service);
      if (rateLimited) {
        const br = this.deps.breakers[decision.service];
        if (br) br.trip();
      }
      if (!sawCompletion) {
        // Stream ended without completion — treat as transient, keep
        // looping but bail if we run out of routes (`pickRoute` returns null).
        continue;
      }
    }
  }

  // ------------------------------------------------------------------------
  // Internals
  // ------------------------------------------------------------------------

  private priorityWithOverride(override: string | undefined): readonly string[] {
    if (override === undefined) return this.deps.config.modelPriority;
    if (!this.deps.config.cliRoutes[override]) {
      // Unknown override — fall back to priority list rather than throw.
      return this.deps.config.modelPriority;
    }
    const tail = this.deps.config.modelPriority.filter((m) => m !== override);
    return [override, ...tail];
  }

  private isUsable(svc: string, exclude: ReadonlySet<string>): boolean {
    if (exclude.has(svc)) return false;
    const dispatcher = this.deps.dispatchers[svc];
    if (!dispatcher || !dispatcher.isAvailable()) return false;
    const breaker = this.deps.breakers[svc];
    if (breaker && breaker.isTripped) return false;
    return true;
  }
}
