/**
 * Config hot-reload for the MCP server.
 *
 * Ported from Python `server.py:_maybe_reload_config`. Rather than file-system
 * watchers (which are flaky on Windows + WSL mounts), we poll the config
 * file's mtime between tool calls. A reload rebuilds the dispatcher map,
 * quota cache, and router — while preserving circuit-breaker state for any
 * service that still exists in the new config.
 *
 * Concurrency: the reload is guarded by a mutex so that simultaneous
 * tool-calls can't race on global state replacement. Only the first caller
 * performs the reload; the rest wait behind the mutex and pick up the
 * already-refreshed state.
 */

import { promises as fs } from "node:fs";

import { loadConfig } from "../config.js";
import { LeaderboardCache } from "../leaderboard.js";
import { QuotaCache } from "../quota.js";
import { Router } from "../router.js";
import type { RouterConfig } from "../types.js";
import { buildDispatchers, type DispatcherMap } from "./dispatcher-factory.js";

export interface RuntimeState {
  config: RouterConfig;
  dispatchers: DispatcherMap;
  quota: QuotaCache;
  router: Router;
  leaderboard: LeaderboardCache;
  mtimeMs: number;
}

/** A mutable holder you pass to tool handlers so hot-reloads are picked up. */
export class RuntimeHolder {
  state: RuntimeState;
  constructor(state: RuntimeState) {
    this.state = state;
  }
  replace(next: RuntimeState): void {
    this.state = next;
  }
}

async function statMtime(path: string | undefined): Promise<number> {
  if (!path) return 0;
  try {
    const stat = await fs.stat(path);
    return stat.mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Bootstrap the full runtime from a config path. Used on server start and
 * again (internally) when a reload is triggered.
 */
export async function bootstrapRuntime(opts: {
  configPath?: string;
  leaderboard?: LeaderboardCache;
}): Promise<RuntimeState> {
  const config = await loadConfig(opts.configPath);
  const dispatchers = await buildDispatchers(config);
  const quota = new QuotaCache(dispatchers);
  const leaderboard = opts.leaderboard ?? new LeaderboardCache();
  const router = new Router(config, quota, dispatchers, leaderboard);
  const mtimeMs = await statMtime(opts.configPath);
  return { config, dispatchers, quota, router, leaderboard, mtimeMs };
}

/** Gate that serialises concurrent reload attempts. */
class Mutex {
  private tail: Promise<void> = Promise.resolve();
  async run<T>(task: () => Promise<T>): Promise<T> {
    const prev = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((r) => (release = r));
    try {
      await prev;
      return await task();
    } finally {
      release();
    }
  }
}

/**
 * Reload helper — pairs with a RuntimeHolder for in-place swap.
 *
 * If the config file's mtime has not moved since we last reloaded, the call
 * is a cheap no-op. Circuit-breaker state from the previous router is
 * preserved for every service that still exists in the new config.
 */
export class ConfigHotReloader {
  private readonly mutex = new Mutex();
  private stopped = false;

  constructor(
    private readonly holder: RuntimeHolder,
    private readonly configPath?: string,
  ) {}

  /**
   * Cause subsequent `maybeReload()` calls to short-circuit. Used by the
   * MCP server's shutdown path to prevent a concurrent reload from racing
   * with `close()` — without this, a tool call that fires just as the
   * server is shutting down can build a fresh runtime state via
   * `holder.replace(next)` and the new state's dispatchers + QuotaCache
   * are never signalled to stop. After `stop()` returns, no new reload
   * will start; an in-flight reload is already inside the mutex and
   * completes naturally.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    // Drain the mutex — wait for any in-flight reload to finish so callers
    // can rely on "after stop() returns, holder.state is stable."
    await this.mutex.run(async () => {});
  }

  /** Returns true iff a reload actually happened. Swallows all errors. */
  async maybeReload(): Promise<boolean> {
    if (this.stopped) return false;
    if (!this.configPath) return false;
    const mtimeMs = await statMtime(this.configPath);
    if (mtimeMs === 0) return false;
    if (mtimeMs <= this.holder.state.mtimeMs) return false;

    return this.mutex.run(async () => {
      // Re-check after acquiring the lock — another caller may have already
      // reloaded, in which case we bail without redoing the work.
      const current = this.holder.state.mtimeMs;
      if (mtimeMs <= current) return false;

      // Flush the OLD QuotaCache's pending writes BEFORE bootstrapping a new
      // one. Otherwise both caches write to ~/.harness-router/quota_state.json
      // concurrently and the rename-from-tmp last-write-wins drops counts.
      try {
        await this.holder.state.quota.flush();
      } catch {
        // Best-effort — proceed with reload regardless.
      }

      let next: RuntimeState;
      try {
        const bootOpts: { configPath?: string; leaderboard?: LeaderboardCache } = {
          leaderboard: this.holder.state.leaderboard,
        };
        if (this.configPath !== undefined) bootOpts.configPath = this.configPath;
        next = await bootstrapRuntime(bootOpts);
      } catch {
        // Malformed edits shouldn't crash the server — keep the old state.
        return false;
      }

      // Preserve circuit-breaker state for services that still exist.
      // Note: `cooldownRemainingSec` is the REMAINING duration at snapshot
      // time, not the total cooldown. Use `restoreTripped` (not `trip`) —
      // `trip(N)` would treat N as the total cooldown starting now, which
      // would slightly extend already-running cooldowns and, worse,
      // re-trip near-expired breakers for the full 300 s default when the
      // remaining duration rounded to 0.
      const oldRouter = this.holder.state.router;
      const oldBreakerStatus = oldRouter.circuitBreakerStatus();
      for (const [name, status] of Object.entries(oldBreakerStatus)) {
        if (!(name in next.config.services)) continue;
        const nb = next.router.getBreaker(name);
        if (!nb) continue;
        if (status.tripped && status.cooldownRemainingSec !== undefined) {
          nb.restoreTripped(status.cooldownRemainingSec);
        }
      }

      this.holder.replace(next);
      return true;
    });
  }
}
