/**
 * Model-first router (prototype, NOT wired into the MCP server yet).
 *
 * The shipping router (`src/router.ts`) treats every (model × harness) pair
 * as a service competing on a composite score. That made sense when the
 * harness mattered as much as the model. Most days it doesn't — the harness
 * is plumbing, the model is the product.
 *
 * This v2 inverts the algorithm and introduces a cost tier:
 *
 *   1. The user declares a *model preference order* — e.g. ["gpt-5.5",
 *      "claude-opus-4.7", "claude-sonnet-4.6"].
 *   2. For each model, the user declares which *subscription* services and
 *      which *metered* services can serve it.
 *   3. To dispatch, walk the priority list. For the highest-priority model:
 *      first try every subscription route (highest quota first). Only after
 *      every subscription route for that model is exhausted, fall through to
 *      its metered routes. Once both tiers are exhausted, drop to the next
 *      model.
 *
 * This is the "use my paid subscriptions first, fall back to metered API
 * only when needed" loop in code form. Subscription routes have zero marginal
 * cost; metered routes don't. Walking subscription-then-metered per model
 * (rather than all-subscriptions-then-all-metered globally) preserves "model
 * preference is primary, cost is secondary" — matching the user's stated
 * intent ("Opus first, then Sonnet, then …").
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

/** Ordered routes that can serve a given model, split by cost tier. */
export interface ModelRoute {
  /** Subscription-backed services (zero marginal cost). Tried first, in order. */
  subscription: readonly string[];
  /** Metered services (per-token cost). Tried only after subscription exhausted. */
  metered?: readonly string[];
}

export type RouteTier = "subscription" | "metered";

export interface ModelFirstConfig {
  /** Ordered list of model IDs, highest priority first. */
  modelPriority: readonly string[];

  /**
   * Map: model_id -> tiered routes that can serve it. Subscription tier is
   * required (use an empty array for "no subscription option, metered only").
   * Order within each tier is the tiebreaker after quota — earlier entries
   * win when quota is equal.
   */
  modelRoutes: Readonly<Record<string, ModelRoute>>;
}

export interface RoutingDecisionV2 {
  model: string;
  service: string;
  tier: RouteTier;
  /** 0..1 — higher means more headroom on this CLI. */
  quotaScore: number;
  /** Human-readable trace. */
  reason: string;
}

export interface RouterV2Deps {
  config: ModelFirstConfig;
  /** Keyed by service name (matches `modelRoutes` values). */
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

// Walked in this order within each model. Tier 0 (subscription) is preferred.
const TIER_ORDER: readonly RouteTier[] = ["subscription", "metered"];

// ---------------------------------------------------------------------------
// The router
// ---------------------------------------------------------------------------

export class RouterV2 {
  constructor(private readonly deps: RouterV2Deps) {}

  /**
   * Pure routing decision: walk the priority list, return the best
   * available (model, service, tier) triple. No side effects on dispatchers.
   * Returns `null` when every model has zero usable routes across all tiers.
   */
  async pickRoute(opts: PickRouteOpts = {}): Promise<RoutingDecisionV2 | null> {
    const exclude = opts.excludeServices ?? new Set<string>();
    const priority = this.priorityWithOverride(opts.modelOverride);

    for (const model of priority) {
      const routes = this.deps.config.modelRoutes[model];
      if (!routes) continue;

      for (const tier of TIER_ORDER) {
        const tierServices = tier === "subscription" ? routes.subscription : (routes.metered ?? []);
        const candidates = tierServices.filter((svc) => this.isUsable(svc, exclude));
        if (candidates.length === 0) continue;

        // Score: quota desc, then preserve declared order as tiebreaker.
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
   * Stream a dispatch with model + route fallback. Yields every dispatcher
   * event plus the *current* routing decision so the caller can show which
   * service is producing each chunk. On rate-limit or hard failure of the
   * picked service, transparently retries against the next route — the next
   * service in the same tier, then the next tier of the same model, then
   * the next model in priority order.
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
      // also trip the breaker so subsequent dispatches in this process skip
      // the service for the cooldown window.
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
    if (!this.deps.config.modelRoutes[override]) {
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
