/**
 * QuotaCache tests, post v0.3 SQLite cutover.
 *
 * v0.2 persisted local counts to a JSON file at `~/.harness-router/quota_state.json`
 * with documented cross-process unsafety. v0.3 persists via {@link QuotaStore}
 * (SQLite WAL); these tests construct caches with `:memory:` stores so they
 * never touch the host's real state DB.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Stub the rate-limit-header parsers — same seam the v0.2 tests used. Their
// real implementations have a dedicated test file; here we just verify
// that QuotaCache.recordResult wires their outputs into QuotaState.
vi.mock("../src/dispatchers/shared/rate-limit-headers.js", () => ({
  parseRemaining: (h: Record<string, string>) => {
    const v = h["x-ratelimit-remaining"];
    return v !== undefined ? Number(v) : null;
  },
  parseLimit: (h: Record<string, string>) => {
    const v = h["x-ratelimit-limit"];
    return v !== undefined ? Number(v) : null;
  },
}));

import { QuotaCache, QuotaState } from "../src/quota.js";
import { QuotaStore } from "../src/state/quota-store.js";
import type { Dispatcher } from "../src/dispatchers/base.js";
import type { QuotaInfo } from "../src/types.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "quota-test-"));
});

afterEach(() => {
  vi.restoreAllMocks();
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // Best-effort.
  }
});

function memStore(): QuotaStore {
  return new QuotaStore({ path: ":memory:", skipMkdir: true });
}

function makeDispatcher(
  id: string,
  checkQuota: () => Promise<QuotaInfo> = async () => ({
    service: id,
    source: "unknown",
  }),
): Dispatcher {
  return { id, checkQuota } as unknown as Dispatcher;
}

// ---------------------------------------------------------------------------
// QuotaState.score
// ---------------------------------------------------------------------------

describe("QuotaState.score", () => {
  it("uses remaining / limit branch when both > 0", () => {
    const s = new QuotaState("svc");
    s.remaining = 30;
    s.limit = 100;
    expect(s.score).toBeCloseTo(0.3, 8);
  });

  it("uses (limit - used) / limit branch when remaining is null", () => {
    const s = new QuotaState("svc");
    s.used = 75;
    s.limit = 100;
    expect(s.score).toBeCloseTo(0.25, 8);
  });

  it("defaults to 1.0 when nothing is known", () => {
    const s = new QuotaState("svc");
    expect(s.score).toBe(1.0);
  });

  it("defaults to 1.0 when limit is zero", () => {
    const s = new QuotaState("svc");
    s.remaining = 5;
    s.limit = 0;
    expect(s.score).toBe(1.0);
  });

  it("clamps score to [0, 1]", () => {
    const s = new QuotaState("svc");
    s.remaining = 1000;
    s.limit = 100;
    expect(s.score).toBe(1.0);

    s.remaining = -50;
    s.limit = 100;
    expect(s.score).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// QuotaCache.recordResult — updates state from rate-limit headers
// ---------------------------------------------------------------------------

describe("QuotaCache.recordResult", () => {
  it("updates state from rateLimitHeaders via parseRemaining / parseLimit", async () => {
    const cache = new QuotaCache({ svc: makeDispatcher("svc") }, { store: memStore() });

    cache.recordResult("svc", {
      output: "",
      service: "svc",
      success: true,
      rateLimitHeaders: {
        "x-ratelimit-remaining": "42",
        "x-ratelimit-limit": "100",
      },
    });

    const status = await cache.fullStatus();
    expect(status["svc"]).toBeDefined();
    expect(status["svc"]!.remaining).toBe(42);
    expect(status["svc"]!.limit).toBe(100);
    expect(status["svc"]!.source).toBe("headers");
    expect(status["svc"]!.score).toBeCloseTo(0.42, 8);
  });

  it("does nothing to QuotaState when there are no headers and not rate-limited", async () => {
    const cache = new QuotaCache({ svc: makeDispatcher("svc") }, { store: memStore() });
    cache.recordResult("svc", { output: "", service: "svc", success: true });

    const status = await cache.fullStatus();
    expect(status["svc"]!.remaining).toBeNull();
    expect(status["svc"]!.limit).toBeNull();
    expect(status["svc"]!.source).toBe("unknown");
    // But the call still gets counted in the store.
    expect(status["svc"]!.localCallCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// QuotaCache._maybeRefresh — TTL is respected
// ---------------------------------------------------------------------------

describe("QuotaCache TTL-based refresh", () => {
  it("does not invoke checkQuota a second time within the TTL window", async () => {
    const checkQuota = vi.fn(
      async (): Promise<QuotaInfo> => ({
        service: "svc",
        remaining: 10,
        limit: 20,
        source: "api",
      }),
    );
    const cache = new QuotaCache(
      { svc: makeDispatcher("svc", checkQuota) },
      { store: memStore(), ttlMs: 10_000 },
    );

    const first = await cache.getQuotaScore("svc");
    const second = await cache.getQuotaScore("svc");

    expect(checkQuota).toHaveBeenCalledTimes(1);
    expect(first).toBeCloseTo(0.5, 8);
    expect(second).toBeCloseTo(0.5, 8);
  });

  it("returns score 1.0 when dispatcher is unknown", async () => {
    const cache = new QuotaCache({ svc: makeDispatcher("svc") }, { store: memStore() });
    const score = await cache.getQuotaScore("nonexistent");
    expect(score).toBe(1.0);
  });
});

// ---------------------------------------------------------------------------
// Local-counts persistence — now via SQLite, cross-process safe
// ---------------------------------------------------------------------------

describe("QuotaCache local call counts (SQLite-backed)", () => {
  it("counts every recordResult, success and failure split", async () => {
    const cache = new QuotaCache({ svc: makeDispatcher("svc") }, { store: memStore() });
    cache.recordResult("svc", { output: "", service: "svc", success: true });
    cache.recordResult("svc", { output: "", service: "svc", success: true });
    cache.recordResult("svc", { output: "", service: "svc", success: false });

    const status = await cache.fullStatus();
    expect(status["svc"]!.localCallCount).toBe(3);
    expect(status["svc"]!.localSuccessCount).toBe(2);
    expect(status["svc"]!.localFailureCount).toBe(1);
  });

  it("two caches sharing one store accumulate cross-process counts", async () => {
    // Same store instance used by both caches simulates two processes
    // opening the same DB file. The store's additive UPSERT means counts
    // accumulate without races.
    const store = memStore();
    const a = new QuotaCache({ svc: makeDispatcher("svc") }, { store });
    const b = new QuotaCache({ svc: makeDispatcher("svc") }, { store });

    a.recordResult("svc", { output: "", service: "svc", success: true });
    a.recordResult("svc", { output: "", service: "svc", success: true });
    b.recordResult("svc", { output: "", service: "svc", success: true });

    // Either cache sees 3 total via fullStatus.
    expect((await a.fullStatus())["svc"]!.localCallCount).toBe(3);
    expect((await b.fullStatus())["svc"]!.localCallCount).toBe(3);
  });

  it("getCounts returns cross-process totals on demand", () => {
    const store = memStore();
    const cache = new QuotaCache({ svc: makeDispatcher("svc") }, { store });
    cache.recordResult("svc", { output: "", service: "svc", success: true });
    cache.recordResult("svc", { output: "", service: "svc", success: false });
    expect(cache.getCounts("svc")).toEqual({ total: 2, success: 1, failure: 1 });
    expect(cache.getCounts("unknown")).toEqual({ total: 0, success: 0, failure: 0 });
  });

  it("imports a legacy v0.2 quota_state.json on first construction (default store)", async () => {
    const file = path.join(tmpDir, "quota_state.json");
    writeFileSync(
      file,
      JSON.stringify({
        svc: { local_calls: 5, local_success: 4, local_failure: 1 },
      }),
      "utf-8",
    );
    // Point the legacy importer at our tmp dir by overriding HOME.
    const realHome = process.env.HOME;
    const realUserProfile = process.env.USERPROFILE;
    process.env.HOME = tmpDir.replace(/\.harness-router.*$/, "");
    process.env.USERPROFILE = process.env.HOME;
    // Place the legacy file where importLegacyState() looks for it.
    const legacyDir = path.join(process.env.HOME, ".harness-router");
    mkdirSync(legacyDir, { recursive: true });
    const legacyPath = path.join(legacyDir, "quota_state.json");
    writeFileSync(
      legacyPath,
      JSON.stringify({
        svc: { local_calls: 5, local_success: 4, local_failure: 1 },
      }),
      "utf-8",
    );

    // Use a custom store so the import flows in but the DB itself is
    // ephemeral. Note: the legacy import path only runs when the cache
    // OPENS its own store (no `store:` opt). So this test exercises the
    // default-store branch by setting HARNESS_ROUTER_STATE_DB.
    process.env.HARNESS_ROUTER_STATE_DB = path.join(tmpDir, "state.db");
    try {
      const cache = new QuotaCache({ svc: makeDispatcher("svc") });
      const status = await cache.fullStatus();
      expect(status["svc"]!.localCallCount).toBe(5);
      expect(status["svc"]!.localSuccessCount).toBe(4);
      expect(status["svc"]!.localFailureCount).toBe(1);
      cache.close();
    } finally {
      delete process.env.HARNESS_ROUTER_STATE_DB;
      if (realHome !== undefined) process.env.HOME = realHome;
      else delete process.env.HOME;
      if (realUserProfile !== undefined) process.env.USERPROFILE = realUserProfile;
      else delete process.env.USERPROFILE;
    }
  });
});

// ---------------------------------------------------------------------------
// getQuotaInfo
// ---------------------------------------------------------------------------

describe("QuotaCache.getQuotaInfo", () => {
  it("returns a QuotaInfo snapshot with current state", async () => {
    const cache = new QuotaCache(
      {
        svc: makeDispatcher("svc", async () => ({
          service: "svc",
          remaining: 80,
          limit: 100,
          source: "api",
        })),
      },
      { store: memStore() },
    );
    const info = await cache.getQuotaInfo("svc");
    expect(info).not.toBeNull();
    expect(info?.remaining).toBe(80);
    expect(info?.limit).toBe(100);
    expect(info?.source).toBe("api");
  });
});
