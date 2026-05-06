/**
 * Top-level config loader tests.
 *
 * Most schema-validation coverage lives in tests/v3/loader.test.ts; this
 * file focuses on what's specific to `loadConfig`'s wrapper behaviour:
 *   - YAML on disk → V3 parse → adapter → RouterConfig
 *   - Legacy v0.2 YAML triggers LegacyConfigError with a migration hint
 *   - Empty/missing config falls through to auto-detect
 *   - watchConfig polls mtime and fires onChange
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { LegacyConfigError, loadConfig, watchConfig, type WhichFn } from "../src/config.js";

async function writeTmpYaml(name: string, text: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `harness-router-cfg-test-`));
  const p = path.join(dir, name);
  await fs.writeFile(p, text, "utf-8");
  return p;
}

const noCliFound: WhichFn = async () => null;
const allCliFound: WhichFn = async (cmd) => `/usr/bin/${cmd}`;

describe("loadConfig — v0.3 entry path", () => {
  it("loads a minimal v0.3 config and exposes services via the adapter", async () => {
    const yamlText = `
priority: [opus]
models:
  opus:
    subscription:
      harness: claude_code
      command: claude
`;
    const p = await writeTmpYaml("v3.yaml", yamlText);
    const cfg = await loadConfig(p, { whichFn: noCliFound });
    // Service id is synthetic: \`opus__subscription\`. The router
    // consumes this through the adapter; users never see it.
    expect(Object.keys(cfg.services)).toContain("opus__subscription");
    expect(cfg.services["opus__subscription"]?.harness).toBe("claude_code");
    expect(cfg.services["opus__subscription"]?.tier).toBe("subscription");
    expect(cfg.modelPriority).toEqual(["opus"]);
  });

  it("emits both subscription and metered services when an entry has both", async () => {
    const yamlText = `
priority: [opus]
models:
  opus:
    subscription:
      harness: claude_code
      command: claude
    metered:
      base_url: https://api.anthropic.com/v1
      api_key: \${ANTHROPIC_API_KEY}
`;
    process.env.ANTHROPIC_API_KEY = "sk-test";
    try {
      const p = await writeTmpYaml("both.yaml", yamlText);
      const cfg = await loadConfig(p, { whichFn: noCliFound });
      expect(cfg.services["opus__subscription"]).toBeDefined();
      expect(cfg.services["opus__metered"]).toBeDefined();
      expect(cfg.services["opus__metered"]?.apiKey).toBe("sk-test");
      expect(cfg.services["opus__metered"]?.baseUrl).toBe("https://api.anthropic.com/v1");
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  it("expands mixture_default model keys to per-tier service ids", async () => {
    const yamlText = `
priority: [opus]
mixture_default: [opus]
models:
  opus:
    subscription:
      harness: claude_code
    metered:
      base_url: https://api.anthropic.com/v1
`;
    const p = await writeTmpYaml("mix.yaml", yamlText);
    const cfg = await loadConfig(p, { whichFn: noCliFound });
    expect(cfg.mixtureDefault).toEqual(["opus__subscription", "opus__metered"]);
  });
});

describe("loadConfig — legacy detection", () => {
  it("throws LegacyConfigError when YAML has a top-level `services:` (v0.2 shape)", async () => {
    const yamlText = `
services:
  alpha:
    enabled: true
    type: cli
    command: alpha-bin
    model: opus
    tier: subscription
`;
    const p = await writeTmpYaml("legacy.yaml", yamlText);
    await expect(loadConfig(p, { whichFn: noCliFound })).rejects.toThrow(LegacyConfigError);
    await expect(loadConfig(p, { whichFn: noCliFound })).rejects.toThrow(/migrate/i);
  });

  it("throws LegacyConfigError on `overrides:` (v0.2 auto-detect overrides)", async () => {
    const p = await writeTmpYaml("ov.yaml", "overrides: {}\n");
    await expect(loadConfig(p, { whichFn: allCliFound })).rejects.toThrow(LegacyConfigError);
  });

  it("throws LegacyConfigError on `endpoints:` (v0.2 endpoints list)", async () => {
    const p = await writeTmpYaml("ep.yaml", "endpoints: []\n");
    await expect(loadConfig(p, { whichFn: noCliFound })).rejects.toThrow(LegacyConfigError);
  });
});

describe("loadConfig — empty / missing config", () => {
  it("returns auto-detected services when the resolved file doesn't exist", async () => {
    const cfg = await loadConfig(undefined, { whichFn: allCliFound });
    // Auto-detect populated something — at minimum, the synthetic services
    // are derived from CLI_DEFAULTS for every CLI on PATH.
    expect(Object.keys(cfg.services).length).toBeGreaterThan(0);
  });

  it("returns auto-detected services when the file is empty", async () => {
    const p = await writeTmpYaml("empty.yaml", "");
    const cfg = await loadConfig(p, { whichFn: allCliFound });
    expect(Object.keys(cfg.services).length).toBeGreaterThan(0);
  });
});

describe("loadConfig — ${ENV_VAR} interpolation through V3 path", () => {
  const origEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...origEnv };
  });

  it("replaces ${VAR} placeholders in metered route api_key", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key-xyz";
    const yamlText = `
priority: [opus]
models:
  opus:
    metered:
      base_url: https://api.anthropic.com/v1
      api_key: \${ANTHROPIC_API_KEY}
`;
    const p = await writeTmpYaml("env.yaml", yamlText);
    const cfg = await loadConfig(p, { whichFn: noCliFound });
    expect(cfg.services["opus__metered"]?.apiKey).toBe("test-key-xyz");
  });
});

describe("watchConfig", () => {
  let watchers: Array<{ stop(): void }> = [];

  beforeEach(() => {
    watchers = [];
    vi.useRealTimers();
  });

  afterEach(() => {
    for (const w of watchers) w.stop();
  });

  it("calls onChange when the file's mtime changes (v0.3 YAML)", async () => {
    const p = await writeTmpYaml(
      "watch.yaml",
      "priority: []\nmodels: {}\n",
    );
    const events: Array<{ time: number }> = [];
    const w = watchConfig(
      p,
      () => {
        events.push({ time: Date.now() });
      },
      { intervalMs: 50, whichFn: noCliFound },
    );
    watchers.push(w);

    await new Promise((r) => setTimeout(r, 120));

    const newMtime = new Date(Date.now() + 2000);
    await fs.writeFile(
      p,
      "priority: [opus]\nmodels:\n  opus:\n    subscription:\n      harness: claude_code\n",
      "utf-8",
    );
    await fs.utimes(p, newMtime, newMtime);

    await new Promise((r) => setTimeout(r, 250));
    expect(events.length).toBeGreaterThanOrEqual(1);
  });

  it("stops polling after stop() is called", async () => {
    const p = await writeTmpYaml("stop.yaml", "priority: []\nmodels: {}\n");
    let calls = 0;
    const w = watchConfig(
      p,
      () => {
        calls += 1;
      },
      { intervalMs: 30, whichFn: noCliFound },
    );
    await new Promise((r) => setTimeout(r, 80));
    w.stop();
    const callsAfterStop = calls;
    await new Promise((r) => setTimeout(r, 30));
    const newMtime = new Date(Date.now() + 2000);
    await fs.writeFile(
      p,
      "priority: [opus]\nmodels:\n  opus:\n    subscription:\n      harness: claude_code\n",
      "utf-8",
    );
    await fs.utimes(p, newMtime, newMtime);
    await new Promise((r) => setTimeout(r, 120));
    expect(calls).toBe(callsAfterStop);
  });
});
