/**
 * Tests for the SQLite-backed shared quota store.
 *
 * Use in-memory databases (`:memory:`) where possible to keep tests fast
 * and hermetic. The cross-process concurrency story is covered with a
 * temporary file-on-disk + two QuotaStore instances acting as separate
 * "processes."
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { QuotaStore } from "../../src/state/quota-store.js";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "harness-router-quota-store-"));
});

afterEach(() => {
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    // Best-effort.
  }
});

describe("QuotaStore — counter persistence", () => {
  it("returns an empty map when nothing has been written", () => {
    const store = new QuotaStore({ path: ":memory:", skipMkdir: true });
    expect(store.loadAllCounters().size).toBe(0);
    store.close();
  });

  it("persists a single delta and returns it via loadAllCounters", () => {
    const store = new QuotaStore({ path: ":memory:", skipMkdir: true });
    store.applyCounterDelta({ service: "claude_code", total: 3, success: 2, failure: 1 });
    const map = store.loadAllCounters();
    expect(map.get("claude_code")).toEqual({ total: 3, success: 2, failure: 1 });
    store.close();
  });

  it("accumulates additive deltas across multiple writes", () => {
    const store = new QuotaStore({ path: ":memory:", skipMkdir: true });
    store.applyCounterDelta({ service: "claude_code", total: 1, success: 1, failure: 0 });
    store.applyCounterDelta({ service: "claude_code", total: 2, success: 1, failure: 1 });
    expect(store.loadAllCounters().get("claude_code")).toEqual({
      total: 3,
      success: 2,
      failure: 1,
    });
    store.close();
  });

  it("ignores all-zero deltas (no-op writes)", () => {
    const store = new QuotaStore({ path: ":memory:", skipMkdir: true });
    store.applyCounterDelta({ service: "x", total: 0, success: 0, failure: 0 });
    expect(store.loadAllCounters().size).toBe(0);
    store.close();
  });

  it("applies a batch of deltas in one transaction", () => {
    const store = new QuotaStore({ path: ":memory:", skipMkdir: true });
    store.applyCounterDeltas([
      { service: "a", total: 1, success: 1, failure: 0 },
      { service: "b", total: 2, success: 0, failure: 2 },
      { service: "c", total: 0, success: 0, failure: 0 }, // skipped
    ]);
    const map = store.loadAllCounters();
    expect(map.size).toBe(2);
    expect(map.get("a")?.total).toBe(1);
    expect(map.get("b")?.failure).toBe(2);
    expect(map.has("c")).toBe(false);
    store.close();
  });

  it("resetAllCounters drops every row", () => {
    const store = new QuotaStore({ path: ":memory:", skipMkdir: true });
    store.applyCounterDelta({ service: "a", total: 5, success: 5, failure: 0 });
    store.resetAllCounters();
    expect(store.loadAllCounters().size).toBe(0);
    store.close();
  });
});

describe("QuotaStore — breaker persistence", () => {
  it("persists a tripped breaker and reads it back", () => {
    const store = new QuotaStore({ path: ":memory:", skipMkdir: true });
    const now = Date.now();
    store.saveBreaker({
      service: "claude_code",
      trippedUntilMs: now + 30_000,
      failureCount: 3,
      updatedAtMs: now,
    });
    const map = store.loadAllBreakers();
    expect(map.get("claude_code")?.failureCount).toBe(3);
    expect(map.get("claude_code")?.trippedUntilMs).toBe(now + 30_000);
    store.close();
  });

  it("clears the row when given a closed-breaker snapshot", () => {
    const store = new QuotaStore({ path: ":memory:", skipMkdir: true });
    const now = Date.now();
    store.saveBreaker({
      service: "claude_code",
      trippedUntilMs: now + 30_000,
      failureCount: 3,
      updatedAtMs: now,
    });
    store.saveBreaker({
      service: "claude_code",
      trippedUntilMs: 0,
      failureCount: 0,
      updatedAtMs: now,
    });
    expect(store.loadAllBreakers().size).toBe(0);
    store.close();
  });

  it("upserts on repeated saves for the same service", () => {
    const store = new QuotaStore({ path: ":memory:", skipMkdir: true });
    const now = Date.now();
    store.saveBreaker({
      service: "claude_code",
      trippedUntilMs: now + 5000,
      failureCount: 1,
      updatedAtMs: now,
    });
    store.saveBreaker({
      service: "claude_code",
      trippedUntilMs: now + 60_000,
      failureCount: 5,
      updatedAtMs: now + 100,
    });
    const map = store.loadAllBreakers();
    expect(map.size).toBe(1);
    expect(map.get("claude_code")?.failureCount).toBe(5);
    expect(map.get("claude_code")?.trippedUntilMs).toBe(now + 60_000);
    store.close();
  });
});

describe("QuotaStore — file-backed cross-process concurrency", () => {
  it("two QuotaStore instances on the same file see each other's writes", () => {
    const path = join(tmp, "state.db");
    const a = new QuotaStore({ path });
    const b = new QuotaStore({ path });

    a.applyCounterDelta({ service: "shared", total: 5, success: 3, failure: 2 });
    // b reads what a wrote
    expect(b.loadAllCounters().get("shared")).toEqual({ total: 5, success: 3, failure: 2 });

    b.applyCounterDelta({ service: "shared", total: 2, success: 2, failure: 0 });
    // a reads what b wrote
    expect(a.loadAllCounters().get("shared")).toEqual({ total: 7, success: 5, failure: 2 });

    a.close();
    b.close();
  });

  it("interleaved writes from two stores accumulate without loss", () => {
    const path = join(tmp, "state.db");
    const a = new QuotaStore({ path });
    const b = new QuotaStore({ path });

    for (let i = 0; i < 50; i++) {
      a.applyCounterDelta({ service: "svc", total: 1, success: 1, failure: 0 });
      b.applyCounterDelta({ service: "svc", total: 1, success: 0, failure: 1 });
    }

    // Either store sees the same final total: 100 calls (50+50), 50 success, 50 failure.
    const map = a.loadAllCounters();
    expect(map.get("svc")).toEqual({ total: 100, success: 50, failure: 50 });

    a.close();
    b.close();
  });
});

describe("QuotaStore — legacy v0.2 import", () => {
  it("imports a v0.2 quota_state.json payload", () => {
    const store = new QuotaStore({ path: ":memory:", skipMkdir: true });
    const legacy = JSON.stringify({
      claude_code: { local_calls: 10, local_success: 8, local_failure: 2 },
      cursor: { local_calls: 3, local_success: 3, local_failure: 0 },
    });
    const n = store.importLegacyJson(legacy);
    expect(n).toBe(2);
    const map = store.loadAllCounters();
    expect(map.get("claude_code")?.total).toBe(10);
    expect(map.get("cursor")?.success).toBe(3);
    store.close();
  });

  it("returns 0 and no-ops on malformed JSON", () => {
    const store = new QuotaStore({ path: ":memory:", skipMkdir: true });
    expect(store.importLegacyJson("not json")).toBe(0);
    expect(store.loadAllCounters().size).toBe(0);
    store.close();
  });

  it("skips entries with no nonzero counts", () => {
    const store = new QuotaStore({ path: ":memory:", skipMkdir: true });
    const legacy = JSON.stringify({
      empty: { local_calls: 0, local_success: 0, local_failure: 0 },
      real: { local_calls: 5, local_success: 5, local_failure: 0 },
    });
    expect(store.importLegacyJson(legacy)).toBe(1);
    expect(store.loadAllCounters().has("empty")).toBe(false);
    expect(store.loadAllCounters().has("real")).toBe(true);
    store.close();
  });

  it("is idempotent — re-importing the same payload doubles the counts (caller responsibility to delete legacy)", () => {
    // Documented contract: importLegacyJson is a delta apply, not a sync.
    // The caller deletes the legacy file after a successful import.
    const store = new QuotaStore({ path: ":memory:", skipMkdir: true });
    const legacy = JSON.stringify({ x: { local_calls: 1, local_success: 1, local_failure: 0 } });
    store.importLegacyJson(legacy);
    store.importLegacyJson(legacy);
    expect(store.loadAllCounters().get("x")?.total).toBe(2);
    store.close();
  });
});

describe("QuotaStore — schema version", () => {
  it("rejects opening a DB with a newer schema version", async () => {
    const path = join(tmp, "future.db");
    // Create a DB at our schema, then bump its version directly via the
    // raw better-sqlite3 driver to simulate "this file was written by a
    // newer harness-router build."
    const a = new QuotaStore({ path });
    a.close();
    const { default: Database } = await import("better-sqlite3");
    const db = new Database(path);
    db.prepare(`UPDATE meta SET value = '999' WHERE key = 'schema_version'`).run();
    db.close();
    expect(() => new QuotaStore({ path })).toThrow(/schema version/);
  });

  it("auto-creates schema_version meta on a fresh DB", () => {
    const path = join(tmp, "fresh.db");
    const store = new QuotaStore({ path });
    // Re-open in a second process — should not throw.
    const second = new QuotaStore({ path });
    expect(() => second.loadAllCounters()).not.toThrow();
    store.close();
    second.close();
  });
});

describe("QuotaStore — close semantics", () => {
  it("close() is idempotent", () => {
    const store = new QuotaStore({ path: ":memory:", skipMkdir: true });
    expect(() => {
      store.close();
      store.close();
    }).not.toThrow();
  });

  it("operations after close() are no-ops, not throws", () => {
    const store = new QuotaStore({ path: ":memory:", skipMkdir: true });
    store.close();
    expect(() =>
      store.applyCounterDelta({ service: "x", total: 1, success: 1, failure: 0 }),
    ).not.toThrow();
    expect(store.loadAllCounters().size).toBe(0);
  });
});

describe("QuotaStore — file path", () => {
  it("exposes the configured path via filePath", () => {
    const store = new QuotaStore({ path: ":memory:", skipMkdir: true });
    expect(store.filePath).toBe(":memory:");
    store.close();
  });

  it("creates the parent directory when needed", () => {
    const path = join(tmp, "nested", "deep", "state.db");
    const store = new QuotaStore({ path });
    store.applyCounterDelta({ service: "x", total: 1, success: 1, failure: 0 });
    expect(store.loadAllCounters().get("x")?.total).toBe(1);
    store.close();
    // Verify the file actually exists at the deep path — touch will throw
    // if the parent directory wasn't created.
    expect(() => writeFileSync(`${path}.touch`, "")).not.toThrow();
  });
});
