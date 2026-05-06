/**
 * Quota management for harness-router.
 *
 * Two-layer approach:
 *   1. Reactive — quota state is updated from every dispatch response
 *      (rate-limit headers on 429s, or usage headers on success).
 *   2. Proactive — each dispatcher can optionally implement `checkQuota()`
 *      for a live snapshot. Results are cached with a TTL to avoid
 *      hammering provider APIs.
 *
 * Persistence is delegated to a {@link QuotaStore} (SQLite WAL). Multiple
 * processes opening the same DB see each other's call counts in real time
 * via the store's additive UPSERT — no per-PID delta files, no daemon, no
 * IPC. The cache layer below holds an in-memory mirror for the current
 * process; cross-process totals are read from the store on `fullStatus()`.
 */

import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { DispatchResult, QuotaInfo } from "./types.js";
import type { Dispatcher } from "./dispatchers/base.js";
import { parseLimit, parseRemaining } from "./dispatchers/shared/rate-limit-headers.js";
import { QuotaStore, defaultStateDbPath } from "./state/quota-store.js";

export const DEFAULT_QUOTA_TTL_MS = 300_000; // 5 minutes
export const PROACTIVE_CHECK_TIMEOUT_MS = 15_000;

function monotonicSec(): number {
  return performance.now() / 1000;
}

export interface QuotaStateJSON {
  used: number | null;
  limit: number | null;
  remaining: number | null;
  resetAt: string | null;
  score: number;
  source: string;
  updatedAgeSec: number;
  /** Total dispatch attempts seen across all processes sharing the DB. */
  localCallCount: number;
  /** Subset of localCallCount that succeeded. */
  localSuccessCount: number;
  /** Subset of localCallCount that failed (success=false at dispatch). */
  localFailureCount: number;
}

/** Mutable quota snapshot for one service, updated reactively. */
export class QuotaState {
  service: string;
  remaining: number | null = null;
  limit: number | null = null;
  used: number | null = null;
  resetAt: string | null = null;
  source: string = "unknown";
  updatedAtSec = 0; // performance.now() seconds

  constructor(service: string) {
    this.service = service;
  }

  get score(): number {
    if (this.remaining !== null && this.limit && this.limit > 0) {
      return Math.max(0, Math.min(1, this.remaining / this.limit));
    }
    if (this.used !== null && this.limit && this.limit > 0) {
      return Math.max(0, Math.min(1, (this.limit - this.used) / this.limit));
    }
    return 1.0;
  }

  updateFromQuotaInfo(info: QuotaInfo): void {
    this.remaining = info.remaining ?? null;
    this.limit = info.limit ?? null;
    this.used = info.used ?? null;
    this.resetAt = info.resetAt ?? null;
    this.source = info.source;
    this.updatedAtSec = monotonicSec();
  }

  toJSON(): Omit<QuotaStateJSON, "localCallCount" | "localSuccessCount" | "localFailureCount"> {
    return {
      used: this.used,
      limit: this.limit,
      remaining: this.remaining,
      resetAt: this.resetAt,
      score: this.score,
      source: this.source,
      updatedAgeSec: this.updatedAtSec === 0 ? 0 : monotonicSec() - this.updatedAtSec,
    };
  }
}

export interface QuotaCacheOptions {
  ttlMs?: number;
  /**
   * Override the persistence layer. Tests typically pass a `QuotaStore`
   * backed by `:memory:`. Production omits this and gets the default DB
   * at `~/.harness-router/state.db`.
   */
  store?: QuotaStore;
}

/**
 * Manages quota state for all dispatchers.
 *
 * Holds a process-local in-memory snapshot for fast scoring; persists call
 * counts to the shared SQLite store on every `recordResult`. The store's
 * additive UPSERT means concurrent processes accumulate cleanly — no
 * read-modify-write race.
 */
export class QuotaCache {
  private readonly dispatchers: Record<string, Dispatcher>;
  private readonly ttlMs: number;
  private readonly store: QuotaStore;
  /** True when this cache opened its own store and owns the lifecycle. */
  private readonly ownsStore: boolean;
  private states: Record<string, QuotaState> = {};
  /** performance.now() seconds of last proactive check per service. */
  private lastChecked: Record<string, number> = {};

  constructor(dispatchers: Record<string, Dispatcher>, opts: QuotaCacheOptions = {}) {
    this.dispatchers = dispatchers;
    this.ttlMs = opts.ttlMs ?? DEFAULT_QUOTA_TTL_MS;

    if (opts.store) {
      this.store = opts.store;
      this.ownsStore = false;
    } else {
      this.store = new QuotaStore({ path: defaultStateDbPath() });
      this.ownsStore = true;
      // One-shot legacy import: fold any v0.2 quota_state.json into the DB
      // and delete it. Idempotent because the legacy file is removed after
      // a successful import.
      this.importLegacyState();
    }

    for (const name of Object.keys(dispatchers)) {
      this.states[name] = new QuotaState(name);
    }
  }

  /** Wait for any pending writes. SQLite writes are synchronous; this is now a no-op. */
  async flush(): Promise<void> {
    // Retained as an `async` no-op so callers (hot-reload) keep their
    // `await flush()` shape during the v0.2 → v0.3 cutover.
    return;
  }

  /** Close the store if this cache owns it. Safe to call multiple times. */
  close(): void {
    if (this.ownsStore) this.store.close();
  }

  // ------------------------------------------------------------------
  // Public API — called by Router
  // ------------------------------------------------------------------

  async getQuotaScore(service: string): Promise<number> {
    await this.maybeRefresh(service);
    const state = this.states[service];
    return state ? state.score : 1.0;
  }

  recordResult(service: string, result: DispatchResult): void {
    // Each dispatch is one delta-of-1 to the store. Concurrent processes
    // accumulate cleanly via SQLite's additive UPSERT (`local_calls = local_calls
    // + excluded.local_calls`). No read-modify-write race.
    this.store.applyCounterDelta({
      service,
      total: 1,
      success: result.success ? 1 : 0,
      failure: result.success ? 0 : 1,
    });

    if (!result.rateLimitHeaders && !result.rateLimited) {
      return;
    }

    let state = this.states[service];
    if (!state) {
      state = new QuotaState(service);
      this.states[service] = state;
    }

    if (result.rateLimitHeaders) {
      const remaining = parseRemaining(result.rateLimitHeaders);
      const limit = parseLimit(result.rateLimitHeaders);
      if (remaining !== null || limit !== null) {
        state.remaining = remaining;
        state.limit = limit;
        state.source = "headers";
        state.updatedAtSec = monotonicSec();
      }
    }
  }

  async getQuotaInfo(service: string): Promise<QuotaInfo | null> {
    await this.maybeRefresh(service);
    const state = this.states[service];
    if (!state) {
      return null;
    }
    const info: QuotaInfo = {
      service,
      source: state.source as QuotaInfo["source"],
    };
    if (state.used !== null) info.used = state.used;
    if (state.limit !== null) info.limit = state.limit;
    if (state.remaining !== null) info.remaining = state.remaining;
    if (state.resetAt !== null) info.resetAt = state.resetAt;
    return info;
  }

  async fullStatus(): Promise<Record<string, QuotaStateJSON>> {
    const out: Record<string, QuotaStateJSON> = {};
    // Single read of the store gives us cross-process totals for every
    // service in the DB, including any service this process hasn't itself
    // dispatched to yet.
    const counts = this.store.loadAllCounters();
    for (const service of Object.keys(this.dispatchers)) {
      await this.maybeRefresh(service);
      const state = this.states[service] ?? new QuotaState(service);
      const c = counts.get(service);
      out[service] = {
        ...state.toJSON(),
        localCallCount: c?.total ?? 0,
        localSuccessCount: c?.success ?? 0,
        localFailureCount: c?.failure ?? 0,
      };
    }
    return out;
  }

  // ------------------------------------------------------------------
  // Proactive refresh
  // ------------------------------------------------------------------

  private async maybeRefresh(service: string): Promise<void> {
    const last = this.lastChecked[service];
    // Node's performance.now() starts near 0 at process start, unlike Python's
    // time.monotonic() (which references OS boot). Treat "never checked" as a
    // force-refresh rather than comparing against 0 — otherwise the first call
    // in a freshly-started process may short-circuit before TTL elapses.
    if (last !== undefined && monotonicSec() - last < this.ttlMs / 1000) {
      return;
    }

    const dispatcher = this.dispatchers[service];
    if (!dispatcher) {
      return;
    }

    this.lastChecked[service] = monotonicSec();
    try {
      const info = await withTimeout(dispatcher.checkQuota(), PROACTIVE_CHECK_TIMEOUT_MS);
      if (info.source !== "unknown") {
        let state = this.states[service];
        if (!state) {
          state = new QuotaState(service);
          this.states[service] = state;
        }
        state.updateFromQuotaInfo(info);
      }
    } catch (err) {
      // Proactive check failed — fall back to reactive state. Surface a
      // diagnostic to stderr (gated by HARNESS_ROUTER_QUOTA_DEBUG) so the
      // "why is the quota score stuck at 1.0?" question is answerable
      // without code-instrumenting.
      if (process.env.HARNESS_ROUTER_QUOTA_DEBUG === "1") {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[quota] proactive checkQuota(${service}) failed: ${msg}\n`);
      }
    }
  }

  // ------------------------------------------------------------------
  // Local counts: cross-process reads, per-call delta writes
  // ------------------------------------------------------------------

  /**
   * Cross-process total counts for one service. Reads from the store every
   * call so concurrent processes' counts are visible immediately.
   */
  getCounts(service: string): { total: number; success: number; failure: number } {
    const c = this.store.loadAllCounters().get(service);
    return c ? { ...c } : { total: 0, success: 0, failure: 0 };
  }

  // ------------------------------------------------------------------
  // Legacy v0.2 quota_state.json import (one-shot at first boot)
  // ------------------------------------------------------------------

  private importLegacyState(): void {
    const legacyPath = join(homedir(), ".harness-router", "quota_state.json");
    if (!existsSync(legacyPath)) return;
    try {
      const text = readFileSync(legacyPath, "utf-8");
      const n = this.store.importLegacyJson(text);
      if (n > 0 && process.env.HARNESS_ROUTER_QUOTA_DEBUG === "1") {
        process.stderr.write(`[quota] migrated ${n} services from legacy quota_state.json\n`);
      }
      // Delete after successful import. Keeps the import idempotent across
      // restarts (no double-counting on the next boot).
      unlinkSync(legacyPath);
    } catch {
      // Best-effort. If the legacy file is unreadable or the import errors,
      // we leave it on disk; the user can clean it up manually.
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}
