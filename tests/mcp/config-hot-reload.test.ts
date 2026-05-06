/**
 * Hot-reload integration tests.
 *
 * Focus: circuit-breaker state preservation across rebuilds. The audit
 * found that `trip(remaining)` was the wrong API for this — it treats the
 * argument as the total cooldown, so passing the remaining seconds either
 * extended the cooldown or, when the remaining rounded to 0, re-tripped
 * the breaker for the full 300 s default. The fix is `restoreTripped`,
 * unit-tested separately. This file exercises the actual hot-reload path
 * end-to-end so we know the wiring works (not just the math).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";

import {
  bootstrapRuntime,
  ConfigHotReloader,
  RuntimeHolder,
} from "../../src/mcp/config-hot-reload.js";
import { CIRCUIT_BREAKER_DEFAULT_COOLDOWN_SEC } from "../../src/circuit-breaker.js";

// Redirect the SQLite quota state DB to a tmp path so this test never touches
// the host's real ~/.harness-router/state.db.
let stateDbDir: string;

beforeEach(async () => {
  stateDbDir = await fs.mkdtemp(path.join(os.tmpdir(), "harness-router-reload-state-"));
  process.env["HARNESS_ROUTER_STATE_DB"] = path.join(stateDbDir, "state.db");
});

afterEach(async () => {
  delete process.env["HARNESS_ROUTER_STATE_DB"];
  vi.restoreAllMocks();
  try {
    await fs.rm(stateDbDir, { recursive: true, force: true });
  } catch {
    // Best-effort.
  }
});

async function writeConfig(dir: string, body: string): Promise<string> {
  const p = path.join(dir, "config.yaml");
  await fs.writeFile(p, body, "utf8");
  return p;
}

function minimalConfig(): string {
  // v0.3 shape — one model with a subscription route. The synthetic service
  // id used by the router/breaker is `alpha__subscription` (model + tier).
  return [
    "priority: [alpha]",
    "models:",
    "  alpha:",
    "    subscription:",
    "      harness: claude_code",
    "      command: claude",
  ].join("\n");
}

/** Synthetic service id matching what v3ToRouterConfig produces. */
const ALPHA_SVC = "alpha__subscription";
const BETA_SVC = "beta__subscription";

async function bumpMtime(file: string, body: string): Promise<void> {
  // Wait long enough for mtime to actually advance on coarse-grained
  // filesystems. The hot-reload check uses `<=` so a same-mtime write
  // would be a no-op.
  await new Promise((r) => setTimeout(r, 50));
  await fs.writeFile(file, body + "\n# bumped\n", "utf8");
}

describe("ConfigHotReloader — circuit-breaker preservation", () => {
  it("preserves a tripped breaker's remaining cooldown across reload", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "harness-router-reload-"));
    const configPath = await writeConfig(dir, minimalConfig());

    const state = await bootstrapRuntime({ configPath });
    const holder = new RuntimeHolder(state);
    const reloader = new ConfigHotReloader(holder, configPath);

    // Trip the breaker with a known cooldown (60 s).
    const breaker = holder.state.router.getBreaker(ALPHA_SVC)!;
    breaker.trip(60);
    const oldRemaining = breaker.cooldownRemaining();
    expect(breaker.isTripped).toBe(true);
    expect(oldRemaining).toBeGreaterThan(58); // accounting for monotonic-clock drift
    expect(oldRemaining).toBeLessThanOrEqual(60);

    // Edit the file so mtime moves, then reload.
    await bumpMtime(configPath, minimalConfig());
    const reloaded = await reloader.maybeReload();
    expect(reloaded).toBe(true);

    // The new router's breaker for alpha should still be tripped with
    // approximately the original remaining time. We allow a small drift
    // window for the work the reload itself does (parse + dispatcher
    // construction); on this machine that's well under a second.
    const newBreaker = holder.state.router.getBreaker(ALPHA_SVC)!;
    expect(newBreaker.isTripped).toBe(true);
    const newRemaining = newBreaker.cooldownRemaining();
    expect(newRemaining).toBeGreaterThan(oldRemaining - 5);
    expect(newRemaining).toBeLessThanOrEqual(oldRemaining);
    // Critically: NOT the default 300 s. That was the regression `restoreTripped`
    // fixed — `trip(rounded-to-zero)` used to fall through to the default.
    expect(newRemaining).toBeLessThan(CIRCUIT_BREAKER_DEFAULT_COOLDOWN_SEC - 100);
  });

  it("does NOT preserve breaker state for services removed from the new config", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "harness-router-reload-"));
    const configPath = await writeConfig(dir, minimalConfig());

    const state = await bootstrapRuntime({ configPath });
    const holder = new RuntimeHolder(state);
    const reloader = new ConfigHotReloader(holder, configPath);

    holder.state.router.getBreaker(ALPHA_SVC)!.trip(60);

    // Replace the file with a config that omits alpha.
    await bumpMtime(
      configPath,
      [
        "priority: [beta]",
        "models:",
        "  beta:",
        "    subscription:",
        "      harness: codex",
        "      command: codex",
      ].join("\n"),
    );
    const reloaded = await reloader.maybeReload();
    expect(reloaded).toBe(true);

    // alpha is gone — no breaker for it.
    expect(holder.state.router.getBreaker(ALPHA_SVC)).toBeUndefined();
    // beta is fresh — should be untripped.
    const beta = holder.state.router.getBreaker(BETA_SVC)!;
    expect(beta.isTripped).toBe(false);
  });

  it("returns false (no reload) when mtime hasn't advanced", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "harness-router-reload-"));
    const configPath = await writeConfig(dir, minimalConfig());

    const state = await bootstrapRuntime({ configPath });
    const holder = new RuntimeHolder(state);
    const reloader = new ConfigHotReloader(holder, configPath);

    expect(await reloader.maybeReload()).toBe(false);
    // Same router instance — nothing changed.
    expect(holder.state.router).toBe(state.router);
  });

  it("stop() makes subsequent maybeReload() short-circuit (audit A: BUG-A3)", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "harness-router-reload-"));
    const configPath = await writeConfig(dir, minimalConfig());

    const state = await bootstrapRuntime({ configPath });
    const holder = new RuntimeHolder(state);
    const reloader = new ConfigHotReloader(holder, configPath);

    await reloader.stop();
    // Bump the mtime; without stop() this would trigger a reload.
    await bumpMtime(configPath, minimalConfig());
    const reloaded = await reloader.maybeReload();
    expect(reloaded).toBe(false);
    // Holder still points at the original router.
    expect(holder.state.router).toBe(state.router);
  });
});
