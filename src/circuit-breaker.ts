/**
 * STUB — owned by Agent 2. Replaced at merge. Minimal implementation here
 * so Agent 4's router tests can run in isolation.
 */

const THRESHOLD = 5;
const DEFAULT_COOLDOWN = 300;

export class CircuitBreaker {
  private _failures = 0;
  private trippedAt: number | null = null;
  private cooldown = DEFAULT_COOLDOWN;

  get isTripped(): boolean {
    if (this.trippedAt === null) return false;
    if ((Date.now() - this.trippedAt) / 1000 >= this.cooldown) {
      this._reset();
      return false;
    }
    return true;
  }

  get failures(): number {
    return this._failures;
  }

  recordFailure(retryAfterSec?: number): void {
    this._failures += 1;
    if (this._failures >= THRESHOLD) {
      this.trippedAt = Date.now();
      this.cooldown = retryAfterSec && retryAfterSec > 0 ? retryAfterSec : DEFAULT_COOLDOWN;
    }
  }

  recordSuccess(): void {
    this._reset();
  }

  trip(retryAfterSec?: number): void {
    this.trippedAt = Date.now();
    this.cooldown = retryAfterSec && retryAfterSec > 0 ? retryAfterSec : DEFAULT_COOLDOWN;
  }

  cooldownRemaining(): number {
    if (!this.isTripped || this.trippedAt === null) return 0;
    return Math.max(0, this.cooldown - (Date.now() - this.trippedAt) / 1000);
  }

  status(): { tripped: boolean; failures: number; cooldownRemainingSec?: number } {
    if (!this.isTripped) return { tripped: false, failures: this._failures };
    return {
      tripped: true,
      failures: this._failures,
      cooldownRemainingSec: Math.round(this.cooldownRemaining() * 10) / 10,
    };
  }

  private _reset(): void {
    this._failures = 0;
    this.trippedAt = null;
    this.cooldown = DEFAULT_COOLDOWN;
  }
}
