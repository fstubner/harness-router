/**
 * Load-balancing router for coding-agent-mcp.
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
 */

import type {
  DispatchResult,
  RouterConfig,
  RoutingDecision,
  RouteHints,
  ServiceConfig,
  TaskType,
} from "./types.js";
import { CircuitBreaker } from "./circuit-breaker.js";
import { QuotaCache } from "./quota.js";
import { LeaderboardCache } from "./leaderboard.js";
import type { Dispatcher } from "./dispatchers/base.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TASK_TYPES_WITH_CAPABILITY: ReadonlySet<TaskType> = new Set([
  "execute",
  "plan",
  "review",
]);

/**
 * Return the model to dispatch with for this service+task_type combination.
 *
 * If the service has escalateModel set and the task_type is in escalateOn,
 * returns escalateModel. Otherwise returns the default svc.model (possibly
 * undefined, which lets the dispatcher use its own default).
 */
function resolveModel(svc: ServiceConfig, taskType: TaskType): string | undefined {
  if (svc.escalateModel && svc.escalateOn.includes(taskType)) {
    return svc.escalateModel;
  }
  return svc.model;
}

/**
 * Compute the per-task-type capability multiplier.
 *
 * Only applies when task_type is one of the three "real" kinds (execute, plan,
 * review). "local" and "" fall through to 1.0 — they don't participate in the
 * capability matrix.
 */
function capabilityScore(svc: ServiceConfig, taskType: TaskType): number {
  if (!TASK_TYPES_WITH_CAPABILITY.has(taskType)) return 1.0;
  const key = taskType as "execute" | "plan" | "review";
  return svc.capabilities[key] ?? 1.0;
}

/**
 * Call dispatcher.dispatch(), passing modelOverride if specified.
 *
 * Mirrors the Python TypeError fallback — dispatchers that don't care about
 * model overrides simply ignore the opts arg.
 */
async function dispatchWithModel(
  dispatcher: Dispatcher,
  prompt: string,
  files: string[],
  workingDir: string,
  model: string | undefined,
): Promise<DispatchResult> {
  if (model !== undefined) {
    return dispatcher.dispatch(prompt, files, workingDir, { modelOverride: model });
  }
  return dispatcher.dispatch(prompt, files, workingDir);
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
// Router
// ---------------------------------------------------------------------------

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

  /** For tests and introspection. */
  getBreaker(service: string): CircuitBreaker | undefined {
    return this.breakers.get(service);
  }

  /**
   * Select the best available service using tiered routing.
   *
   * Returns null when no service is available (all disabled, excluded,
   * circuit-broken, or unavailable).
   */
  async pickService(opts: {
    hints?: RouteHints;
    prompt?: string;
    files?: string[];
    exclude?: Set<string>;
  } = {}): Promise<RoutingDecision | null> {
    const hints = opts.hints ?? {};
    const exclude = opts.exclude ?? new Set<string>();

    const forceService = hints.service;
    const preferLargeContext = hints.preferLargeContext ?? false;
    const taskType: TaskType = hints.taskType ?? "";
    const filterHarness = hints.harness;

    // --- Forced service ---
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
      const finalScore =
        qualityScore * svc.cliCapability * capScore * quotaScore * svc.weight;

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

    // --- Build per-tier candidate lists ---
    const tierCandidates = new Map<number, Candidate[]>();

    for (const [name, svc] of Object.entries(this.config.services)) {
      if (!svc.enabled) continue;
      if (!(name in this.dispatchers)) continue;
      if (exclude.has(name)) continue;
      const breaker = this.breakers.get(name);
      if (breaker && breaker.isTripped) continue;
      const dispatcher = this.dispatchers[name]!;
      if (!dispatcher.isAvailable()) continue;

      // Harness filter hint: restrict candidates to matching harness.
      const harnessKey = svc.harness ?? name;
      if (filterHarness && harnessKey !== filterHarness) continue;

      // Auto-derive tier from ELO if the service has a leaderboardModel.
      const tier = svc.leaderboardModel
        ? await this.leaderboard.autoTier(svc.leaderboardModel, svc.thinkingLevel, svc.tier)
        : svc.tier;

      const quotaScore = await this.quota.getQuotaScore(name);
      const { qualityScore, elo } = await this.leaderboard.getQualityScore(
        svc.leaderboardModel,
        svc.thinkingLevel,
      );
      const capScore = capabilityScore(svc, taskType);

      // cliCapability multiplies ELO quality — captures agent scaffolding
      // value that the leaderboard (raw API calls) doesn't measure.
      const effectiveQuality = qualityScore * svc.cliCapability * capScore;
      let score = effectiveQuality * quotaScore * svc.weight;

      // Infrastructure-level hint adjustments.
      if (preferLargeContext && (harnessKey === "gemini" || harnessKey === "gemini_cli")) {
        score += 0.3;
      }
      if (
        taskType === "local" &&
        svc.type === "openai_compatible" &&
        (svc.baseUrl?.includes("localhost") || svc.baseUrl?.includes("127.0.0.1"))
      ) {
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
      if (bucket) {
        bucket.push(candidate);
      } else {
        tierCandidates.set(tier, [candidate]);
      }
    }

    if (tierCandidates.size === 0) return null;

    // Minimum tier across all configured+enabled services — used to detect
    // when we've fallen back past the intended primary tier.
    let minConfiguredTier = Infinity;
    for (const svc of Object.values(this.config.services)) {
      if (svc.enabled && svc.tier < minConfiguredTier) minConfiguredTier = svc.tier;
    }

    // --- Select from the highest-quality available tier ---
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
   * Route a task, with automatic fallback on transient failures.
   *
   * If the picked service fails (non-rate-limit), the next-best service is
   * tried automatically, up to `maxFallbacks` additional attempts.
   * Returns (result, decision) for the attempt that succeeded — or the last
   * failure if all attempts fail.
   */
  async route(
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
          } as DispatchResult,
          decision: null,
        };
      }

      const dispatcher = this.dispatchers[decision.service]!;
      const result = await dispatchWithModel(
        dispatcher,
        prompt,
        files,
        workingDir,
        decision.model,
      );
      this.handleResult(decision.service, result);
      lastResult = result;
      lastDecision = decision;

      if (result.success) {
        if (attempt > 0) {
          decision.reason += ` (fallback #${attempt} — prev failed)`;
        }
        return { result, decision };
      }

      // Rate-limited: don't retry — the circuit breaker has already been tripped.
      if (result.rateLimited) {
        return { result, decision };
      }

      // Transient failure: exclude this service and try another.
      tried.add(decision.service);
    }

    // Loop exhausted (shouldn't happen — pickService returning null handles
    // that case above). Guarded for type-narrowing.
    return {
      result:
        lastResult ??
        ({
          output: "",
          service: "none",
          success: false,
          error: "Router exhausted all fallback attempts.",
        } as DispatchResult),
      decision: lastDecision,
    };
  }

  /**
   * Dispatch to a specific service, bypassing tier selection.
   *
   * Does NOT apply task-type capability scoring or model escalation — the
   * decision's final_score is `quality * cli_capability * quota * weight`
   * and the decision's model is the service's default.
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
        } as DispatchResult,
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
        } as DispatchResult,
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
      capabilityScore: 1.0, // no task-type context when called directly
      taskType: "",
      model: svc.model, // no task_type -> no escalation
      elo: elo ?? undefined,
      finalScore: qualityScore * svc.cliCapability * quotaScore * svc.weight,
      reason: "explicit",
    };
    const result = await dispatchWithModel(
      this.dispatchers[service]!,
      prompt,
      files,
      workingDir,
      decision.model,
    );
    this.handleResult(service, result);
    return { result, decision };
  }

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
