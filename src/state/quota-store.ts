/**
 * SQLite-backed shared quota store.
 *
 * Replaces the v0.2 per-PID delta-file scheme with a single database file
 * at `~/.harness-router/state.db`. Multiple stdio MCP servers (Claude
 * Desktop + Cursor + Codex running concurrently against the same machine)
 * open the same DB and see each other's quota counts in real time, so a
 * shared rate limit on Claude Pro can't be blown by one agent's blind
 * spot.
 *
 * SQLite WAL mode handles concurrent reads/writes natively. No daemon,
 * no IPC, no lifecycle management — every process opens the file, does
 * its thing, and closes it.
 *
 * Surface mirrors what the v0.2 in-memory cache (`QuotaCache`) needs from
 * persistence: load all counts, merge a delta, persist. The cache layer
 * stays unchanged; only this module differs.
 *
 * Schema (created on first open):
 *
 *   counters(service TEXT PRIMARY KEY,
 *            local_calls INTEGER NOT NULL DEFAULT 0,
 *            local_success INTEGER NOT NULL DEFAULT 0,
 *            local_failure INTEGER NOT NULL DEFAULT 0)
 *
 *   breakers(service TEXT PRIMARY KEY,
 *            tripped_until_ms INTEGER NOT NULL,
 *            failure_count INTEGER NOT NULL,
 *            updated_at_ms INTEGER NOT NULL)
 *
 *   meta(key TEXT PRIMARY KEY, value TEXT)
 *
 * Counters use UPSERT with arithmetic merging (`local_calls = local_calls
 * + excluded.local_calls`) so concurrent writers cleanly accumulate. The
 * cache layer feeds *deltas* to {@link QuotaStore.applyCounterDelta} and
 * reads totals via {@link QuotaStore.loadAllCounters}.
 */

import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import Database from "better-sqlite3";
import type { Database as DB, Statement } from "better-sqlite3";

export interface QuotaCounters {
  /** Total dispatches attempted this DB's lifetime, summed across processes. */
  total: number;
  /** Subset that completed successfully. */
  success: number;
  /** Subset that completed with success=false. */
  failure: number;
}

export interface QuotaCounterDelta {
  service: string;
  total: number;
  success: number;
  failure: number;
}

/**
 * Default DB location. Lives next to the user's config so they're easy to
 * spot/back up/move together.
 */
export function defaultStateDbPath(): string {
  return join(homedir(), ".harness-router", "state.db");
}

export interface QuotaStoreOptions {
  /** Path to the SQLite file. Defaults to {@link defaultStateDbPath}. */
  path?: string;
  /** Skip directory creation. Tests that pass `:memory:` use this. */
  skipMkdir?: boolean;
}

const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS counters (
  service TEXT PRIMARY KEY,
  local_calls INTEGER NOT NULL DEFAULT 0,
  local_success INTEGER NOT NULL DEFAULT 0,
  local_failure INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS breakers (
  service TEXT PRIMARY KEY,
  tripped_until_ms INTEGER NOT NULL,
  failure_count INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);
`;

interface CounterRow {
  service: string;
  local_calls: number;
  local_success: number;
  local_failure: number;
}

interface BreakerRow {
  service: string;
  tripped_until_ms: number;
  failure_count: number;
  updated_at_ms: number;
}

export interface BreakerSnapshot {
  service: string;
  trippedUntilMs: number;
  failureCount: number;
  updatedAtMs: number;
}

/**
 * SQLite-backed quota store. Construct once per process and reuse — opening
 * the DB is the heaviest operation; reads/writes are cheap.
 */
export class QuotaStore {
  private readonly db: DB;
  private readonly path: string;
  private readonly upsertCounter: Statement<[string, number, number, number]>;
  private readonly readAllCounters: Statement<[]>;
  private readonly upsertBreaker: Statement<[string, number, number, number]>;
  private readonly readAllBreakers: Statement<[]>;
  private readonly clearBreaker: Statement<[string]>;
  private closed = false;

  constructor(opts: QuotaStoreOptions = {}) {
    this.path = opts.path ?? defaultStateDbPath();

    if (!opts.skipMkdir && this.path !== ":memory:") {
      try {
        mkdirSync(dirname(this.path), { recursive: true });
      } catch {
        // mkdirp errors surface on the open call below; nothing to do here.
      }
    }

    this.db = new Database(this.path);
    // WAL mode is the whole reason we picked SQLite — concurrent readers
    // never block writers, writers serialize cleanly. NORMAL synchronous is
    // safe with WAL and dramatically faster than FULL.
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("foreign_keys = ON");

    this.db.exec(SCHEMA);
    this.ensureSchemaVersion();

    // Prepare every statement once. Per better-sqlite3 docs: prepared
    // statements are 5-10× faster than ad-hoc strings in tight loops.
    this.upsertCounter = this.db.prepare(
      `INSERT INTO counters(service, local_calls, local_success, local_failure)
       VALUES(?, ?, ?, ?)
       ON CONFLICT(service) DO UPDATE SET
         local_calls = local_calls + excluded.local_calls,
         local_success = local_success + excluded.local_success,
         local_failure = local_failure + excluded.local_failure`,
    );
    this.readAllCounters = this.db.prepare(`SELECT * FROM counters`);
    this.upsertBreaker = this.db.prepare(
      `INSERT INTO breakers(service, tripped_until_ms, failure_count, updated_at_ms)
       VALUES(?, ?, ?, ?)
       ON CONFLICT(service) DO UPDATE SET
         tripped_until_ms = excluded.tripped_until_ms,
         failure_count = excluded.failure_count,
         updated_at_ms = excluded.updated_at_ms`,
    );
    this.readAllBreakers = this.db.prepare(`SELECT * FROM breakers`);
    this.clearBreaker = this.db.prepare(`DELETE FROM breakers WHERE service = ?`);
  }

  /** Apply an additive delta for one service. Idempotent within a single call. */
  applyCounterDelta(delta: QuotaCounterDelta): void {
    if (this.closed) return;
    if (delta.total === 0 && delta.success === 0 && delta.failure === 0) return;
    this.upsertCounter.run(delta.service, delta.total, delta.success, delta.failure);
  }

  /** Apply many deltas atomically. Useful at process-exit flush time. */
  applyCounterDeltas(deltas: readonly QuotaCounterDelta[]): void {
    if (this.closed || deltas.length === 0) return;
    const tx = this.db.transaction((items: readonly QuotaCounterDelta[]) => {
      for (const d of items) {
        if (d.total === 0 && d.success === 0 && d.failure === 0) continue;
        this.upsertCounter.run(d.service, d.total, d.success, d.failure);
      }
    });
    tx(deltas);
  }

  /** Snapshot every service's counters. Returns a fresh map each call. */
  loadAllCounters(): Map<string, QuotaCounters> {
    const out = new Map<string, QuotaCounters>();
    if (this.closed) return out;
    const rows = this.readAllCounters.all() as CounterRow[];
    for (const row of rows) {
      out.set(row.service, {
        total: row.local_calls,
        success: row.local_success,
        failure: row.local_failure,
      });
    }
    return out;
  }

  /** Persist a circuit-breaker snapshot. Pass trippedUntilMs=0 to clear. */
  saveBreaker(snap: BreakerSnapshot): void {
    if (this.closed) return;
    if (snap.trippedUntilMs <= 0 && snap.failureCount === 0) {
      this.clearBreaker.run(snap.service);
      return;
    }
    this.upsertBreaker.run(snap.service, snap.trippedUntilMs, snap.failureCount, snap.updatedAtMs);
  }

  /** Snapshot every breaker still considered tripped per its own clock. */
  loadAllBreakers(): Map<string, BreakerSnapshot> {
    const out = new Map<string, BreakerSnapshot>();
    if (this.closed) return out;
    const rows = this.readAllBreakers.all() as BreakerRow[];
    for (const row of rows) {
      out.set(row.service, {
        service: row.service,
        trippedUntilMs: row.tripped_until_ms,
        failureCount: row.failure_count,
        updatedAtMs: row.updated_at_ms,
      });
    }
    return out;
  }

  /** Drop every counter row. Test-only — not exposed via CLI. */
  resetAllCounters(): void {
    if (this.closed) return;
    this.db.exec(`DELETE FROM counters`);
  }

  /** Drop every breaker row. Test-only. */
  resetAllBreakers(): void {
    if (this.closed) return;
    this.db.exec(`DELETE FROM breakers`);
  }

  /**
   * Migrate legacy v0.2 quota state into this DB and delete the legacy
   * artefacts. Idempotent: safe to call on every server boot.
   *
   * Returns the count of services migrated. Zero means nothing was found
   * (clean install or already migrated).
   */
  importLegacyJson(payload: string): number {
    if (this.closed) return 0;
    let parsed: Record<string, Record<string, unknown>>;
    try {
      const obj = JSON.parse(payload) as unknown;
      if (!obj || typeof obj !== "object" || Array.isArray(obj)) return 0;
      parsed = obj as Record<string, Record<string, unknown>>;
    } catch {
      return 0;
    }
    const deltas: QuotaCounterDelta[] = [];
    for (const [service, bucket] of Object.entries(parsed)) {
      if (!bucket || typeof bucket !== "object") continue;
      const total = numField(bucket, "local_calls");
      const success = numField(bucket, "local_success");
      const failure = numField(bucket, "local_failure");
      if (total === 0 && success === 0 && failure === 0) continue;
      deltas.push({ service, total, success, failure });
    }
    this.applyCounterDeltas(deltas);
    return deltas.length;
  }

  /** Path of the underlying DB file (or `:memory:`). */
  get filePath(): string {
    return this.path;
  }

  /** Close the DB. Safe to call multiple times. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.db.close();
    } catch {
      // Best-effort; closing a corrupt handle on shutdown shouldn't crash.
    }
  }

  private ensureSchemaVersion(): void {
    const row = this.db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as
      | { value: string }
      | undefined;
    if (!row) {
      this.db
        .prepare(`INSERT INTO meta(key, value) VALUES('schema_version', ?)`)
        .run(String(SCHEMA_VERSION));
      return;
    }
    const stored = Number.parseInt(row.value, 10);
    if (Number.isNaN(stored) || stored > SCHEMA_VERSION) {
      throw new Error(
        `state.db schema version ${row.value} is newer than this build supports (${SCHEMA_VERSION}). ` +
          `Upgrade harness-router or remove the state file to start fresh.`,
      );
    }
    // Future migrations land here when SCHEMA_VERSION bumps.
  }
}

function numField(bucket: Record<string, unknown>, key: string): number {
  const v = bucket[key];
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}
