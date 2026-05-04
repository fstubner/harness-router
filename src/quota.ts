/**
 * Quota management for harness-router-mcp.
 *
 * Ported from `coding_agent.quota`. Two-layer approach:
 *   1. Reactive — quota state is updated from every dispatch response
 *      (rate-limit headers on 429s, or usage headers on success).
 *   2. Proactive — each dispatcher can optionally implement `checkQuota()`
 *      for a live snapshot. Results are cached with a TTL to avoid
 *      hammering provider APIs.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { DispatchResult, QuotaInfo } from "./types.js";
import type { Dispatcher } from "./dispatchers/base.js";
import { parseLimit, parseRemaining } from "./dispatchers/shared/rate-limit-headers.js";

export const DEFAULT_QUOTA_TTL_MS = 300_000; // 5 minutes
export const PROACTIVE_CHECK_TIMEOUT_MS = 15_000;

/**
 * Default location for the persisted quota-state file.
 *
 * Lives under `~/.harness-router/` so multiple invocations from different
 * working directories share state — and we don't pollute whatever cwd the
 * user happens to launch us from. Override via `QuotaCacheOptions.stateFile`.
 */
function defaultStateFile(): string {
  return join(homedir(), ".harness-router", "quota_state.json");
}

/** Create the parent directory of a state file path if it doesn't exist. */
function ensureStateDir(filePath: string): void {
  try {
    mkdirSync(dirname(filePath), { recursive: true });
  } catch {
    // Best-effort — if we can't create the dir, the subsequent write will
    // surface the real error.
  }
}

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
  /** Total dispatch attempts this session (success + failure). */
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
      updatedAgeSec: Math.round((monotonicSec() - this.updatedAtSec) * 10) / 10,
    };
  }
}

export interface QuotaCacheOptions {
  ttlMs?: number;
  stateFile?: string;
}

/** Per-service local-call breakdown. Successes and failures tracked separately. */
export interface LocalCounts {
  total: number;
  success: number;
  failure: number;
}

/**
 * Manages quota state for all dispatchers.
 */
export class QuotaCache {
  private readonly dispatchers: Record<string, Dispatcher>;
  private readonly ttlMs: number;
  private readonly stateFile: string;
  private states: Record<string, QuotaState> = {};
  /** performance.now() seconds of last proactive check per service. */
  private lastChecked: Record<string, number> = {};
  private localCounts: Record<string, LocalCounts>;
  /** Tail of in-flight async writes — `await` to flush before reload/shutdown. */
  private writeChain: Promise<void> = Promise.resolve();

  constructor(dispatchers: Record<string, Dispatcher>, opts: QuotaCacheOptions = {}) {
    this.dispatchers = dispatchers;
    this.ttlMs = opts.ttlMs ?? DEFAULT_QUOTA_TTL_MS;
    this.stateFile = opts.stateFile ?? defaultStateFile();

    for (const name of Object.keys(dispatchers)) {
      this.states[name] = new QuotaState(name);
    }
    this.localCounts = this.loadLocalCounts();
  }

  /**
   * Wait for any in-flight `saveLocalCounts` writes to complete. Used during
   * hot-reload so a fresh QuotaCache doesn't race the old one's last writes.
   */
  async flush(): Promise<void> {
    await this.writeChain;
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
    const counts = this.localCounts[service] ?? { total: 0, success: 0, failure: 0 };
    counts.total += 1;
    if (result.success) counts.success += 1;
    else counts.failure += 1;
    this.localCounts[service] = counts;

    // Chain the write onto writeChain so concurrent recordResult calls
    // serialise their disk I/O — eliminates the read-modify-write race that
    // produced flaky test failures and inter-process state-file corruption.
    this.writeChain = this.writeChain.then(() => this.saveLocalCounts()).catch(() => undefined);

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
    for (const service of Object.keys(this.dispatchers)) {
      await this.maybeRefresh(service);
      const state = this.states[service] ?? new QuotaState(service);
      const counts = this.localCounts[service];
      out[service] = {
        ...state.toJSON(),
        localCallCount: counts?.total ?? 0,
        localSuccessCount: counts?.success ?? 0,
        localFailureCount: counts?.failure ?? 0,
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
  // Local count persistence
  // ------------------------------------------------------------------

  private loadLocalCounts(): Record<string, LocalCounts> {
    if (!existsSync(this.stateFile)) {
      return {};
    }
    try {
      const raw = readFileSync(this.stateFile, "utf-8");
      const data = JSON.parse(raw) as Record<
        string,
        {
          local_calls?: number;
          local_success?: number;
          local_failure?: number;
        } | null
      >;
      const out: Record<string, LocalCounts> = {};
      for (const [k, v] of Object.entries(data)) {
        if (!v) continue;
        const total = typeof v.local_calls === "number" ? v.local_calls : 0;
        const success = typeof v.local_success === "number" ? v.local_success : 0;
        const failure = typeof v.local_failure === "number" ? v.local_failure : 0;
        if (total > 0 || success > 0 || failure > 0) {
          out[k] = { total, success, failure };
        }
      }
      return out;
    } catch {
      return {};
    }
  }

  /**
   * Build the on-disk payload, merging new counts over any existing state.
   *
   * Single-process safety: the surrounding `writeChain` serialises this
   * process's writes, so within one process the read-then-write is
   * sequentially consistent.
   *
   * Cross-process safety: NOT safe. If two processes (e.g. an MCP server
   * and a parallel `harness-router-mcp doctor` invocation) both write at the
   * same instant, the read-then-rename window allows the later writer to
   * overwrite the earlier writer's counts for any service it doesn't
   * itself touch. Audit pass A flagged this. The exposure is bounded —
   * we only lose `local_calls / local_success / local_failure` deltas in
   * the millisecond window between read and rename — and the realistic
   * topology is single-process MCP server. Documented here rather than
   * fixed because a proper fix (per-PID delta files merged at read time)
   * is a substantial refactor and the intermediate hack (file-locking)
   * doesn't compose well across Windows + POSIX.
   *
   * If you hit this in the wild — i.e. you're running multiple
   * `harness-router-mcp` processes against the same `state_file` — set
   * each process's `state_file` to a different path in config.yaml.
   */
  private buildStatePayload(): string {
    let existing: Record<string, Record<string, unknown>> = {};
    try {
      if (existsSync(this.stateFile)) {
        const raw = readFileSync(this.stateFile, "utf-8");
        const parsed = JSON.parse(raw) as Record<string, Record<string, unknown>> | null;
        if (parsed && typeof parsed === "object") {
          existing = parsed;
        }
      }
    } catch {
      existing = {};
    }
    for (const [service, counts] of Object.entries(this.localCounts)) {
      const bucket = existing[service] ?? {};
      bucket["local_calls"] = counts.total;
      bucket["local_success"] = counts.success;
      bucket["local_failure"] = counts.failure;
      existing[service] = bucket;
    }
    return JSON.stringify(existing, null, 2);
  }

  /** Build a unique tmp path. PID + timestamp + random suffix prevents
   *  collisions across processes and across millisecond-tick same-process writes. */
  private buildTmpPath(): string {
    const rand = Math.random().toString(36).slice(2, 8);
    return `${this.stateFile}.${process.pid}.${Date.now()}.${rand}.tmp`;
  }

  /** Atomic write: write payload to a tmp sibling, then rename over the target. */
  private async saveLocalCounts(): Promise<void> {
    try {
      ensureStateDir(this.stateFile);
      const tmp = this.buildTmpPath();
      const payload = this.buildStatePayload();
      await writeFile(tmp, payload);
      try {
        await rename(tmp, this.stateFile);
      } catch (err) {
        // Best-effort cleanup of the tmp file if the rename failed.
        try {
          await unlink(tmp);
        } catch {
          // ignore
        }
        throw err;
      }
    } catch {
      // Best-effort; the in-memory counts remain correct.
    }
  }

  /** Synchronous variant for tests where awaiting the async write is awkward. */
  saveLocalCountsSync(): void {
    try {
      ensureStateDir(this.stateFile);
      const tmp = this.buildTmpPath();
      writeFileSync(tmp, this.buildStatePayload());
      try {
        renameSync(tmp, this.stateFile);
      } catch {
        // Best-effort cleanup.
        try {
          unlinkSync(tmp);
        } catch {
          // ignore
        }
      }
    } catch {
      // Ignore.
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
