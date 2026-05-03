/**
 * Per-service circuit breaker with dynamic cooldown from provider responses.
 *
 * Ported from the Python `coding_agent.router.CircuitBreaker` class.
 * Uses `performance.now()` for monotonic seconds (equivalent to Python's
 * `time.monotonic()`), independent of wall-clock adjustments.
 *
 * Threshold: trips after CIRCUIT_BREAKER_THRESHOLD consecutive failures.
 * Cooldown: defaults to CIRCUIT_BREAKER_DEFAULT_COOLDOWN_SEC; overridden by
 * the provider's Retry-After header (parsed via parseRetryAfter).
 *
 * Behaviour notes:
 *  - `isTripped` has a side effect: it auto-resets the breaker once the
 *    cooldown elapses. Two reads in the same tick are stable, but reads
 *    spanning the cooldown boundary will flip false→true exactly once.
 *  - After tripping, `recordFailure()` continues to increment failures and
 *    re-stamp `trippedAt` — a runaway service stays open until either
 *    `recordSuccess()` is called or no failures occur for a full cooldown
 *    window. This is intentional: it prevents a flapping service from
 *    serving traffic in tiny success windows between repeated failures.
 */

export const CIRCUIT_BREAKER_THRESHOLD = 5;
export const CIRCUIT_BREAKER_DEFAULT_COOLDOWN_SEC = 300;

function monotonicSec(): number {
  return performance.now() / 1000;
}

export interface CircuitBreakerStatus {
  tripped: boolean;
  failures: number;
  cooldownRemainingSec?: number;
}

/**
 * Per-service failure tracker that "trips" (refuses traffic) after
 * {@link CIRCUIT_BREAKER_THRESHOLD} consecutive failures and "auto-resets"
 * once {@link CIRCUIT_BREAKER_DEFAULT_COOLDOWN_SEC} elapses (or the
 * provider-supplied retry-after, when available).
 *
 * Single-instance per service — owned by {@link Router}. Time-source is
 * `performance.now()` (monotonic), unaffected by wall-clock adjustments.
 *
 * @see Router for how breakers gate service selection.
 */
export class CircuitBreaker {
  private failures = 0;
  private trippedAt: number | null = null;
  private cooldown: number = CIRCUIT_BREAKER_DEFAULT_COOLDOWN_SEC;

  get isTripped(): boolean {
    if (this.trippedAt === null) {
      return false;
    }
    if (monotonicSec() - this.trippedAt >= this.cooldown) {
      this.reset();
      return false;
    }
    return true;
  }

  recordFailure(retryAfterSec?: number): void {
    this.failures += 1;
    if (this.failures >= CIRCUIT_BREAKER_THRESHOLD) {
      this.trippedAt = monotonicSec();
      this.cooldown =
        retryAfterSec && retryAfterSec > 0 ? retryAfterSec : CIRCUIT_BREAKER_DEFAULT_COOLDOWN_SEC;
    }
  }

  recordSuccess(): void {
    this.reset();
  }

  /** Immediately trip — use on 429 or explicit rate-limit response. */
  trip(retryAfterSec?: number): void {
    this.trippedAt = monotonicSec();
    this.cooldown =
      retryAfterSec && retryAfterSec > 0 ? retryAfterSec : CIRCUIT_BREAKER_DEFAULT_COOLDOWN_SEC;
  }

  /**
   * Restore a tripped state with a target *remaining* cooldown (not total).
   * Used by config hot-reload to preserve in-flight cooldowns across rebuilds
   * without resetting the clock.
   *
   * Intentionally distinct from `trip()`: `trip(retryAfterSec)` treats the
   * argument as the *total* cooldown duration starting now, which is the
   * right semantic for a fresh 429 response. For state restoration we want
   * "auto-reset in N seconds from now," which is what this method does.
   *
   * Edge cases:
   *  - `remainingSec <= 0`: the previous breaker would have already
   *    auto-reset, so we leave this breaker untripped instead of falling
   *    through to the default 300s cooldown (which would re-trip it for the
   *    full default — the bug this method was extracted to fix).
   *  - `failures` is set to the threshold so subsequent successful calls can
   *    be counted by `recordSuccess()` resetting the failure count cleanly.
   */
  restoreTripped(remainingSec: number): void {
    if (remainingSec <= 0) {
      this.reset();
      return;
    }
    this.trippedAt = monotonicSec();
    this.cooldown = remainingSec;
    this.failures = CIRCUIT_BREAKER_THRESHOLD;
  }

  cooldownRemaining(): number {
    if (!this.isTripped || this.trippedAt === null) {
      return 0;
    }
    return Math.max(0, this.cooldown - (monotonicSec() - this.trippedAt));
  }

  status(): CircuitBreakerStatus {
    if (!this.isTripped) {
      return { tripped: false, failures: this.failures };
    }
    return {
      tripped: true,
      failures: this.failures,
      cooldownRemainingSec: Math.round(this.cooldownRemaining() * 10) / 10,
    };
  }

  private reset(): void {
    this.failures = 0;
    this.trippedAt = null;
    this.cooldown = CIRCUIT_BREAKER_DEFAULT_COOLDOWN_SEC;
  }
}
