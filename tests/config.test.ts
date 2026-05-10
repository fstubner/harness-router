/**
 * Top-level config loader tests.
 *
 * Schema-validation coverage lives in tests/config/parser.test.ts; this
 * file focuses on what's specific to `loadConfig`'s wrapper behaviour:
 *   - YAML on disk → parse → adapter → RouterConfig
 *   - Missing config throws ConfigMissingError pointing at `onboard`
 *   - Invalid config bubbles up ConfigError
 *   - watchConfig polls mtime and fires onChange
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { ConfigError, ConfigMissingError, loadConfig, watchConfig } from "../src/config/index.js";

async function writeTmpYaml(name: string, text: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `harness-router-cfg-test-`));
  const p = path.join(dir, name);
  await fs.writeFile(p, text, "utf-8");
  return p;
}

describe("loadConfig — happy path", () => {
  it("loads a minimal config and exposes services via the adapter", async () => {
    const yamlText = `
priority: [opus]
models:
  opus:
    subscription:
      harness: claude_code
      command: claude
`;
    const p = await writeTmpYaml("v3.yaml", yamlText);
    const cfg = await loadConfig(p);
    // Synthetic service id is `${model}::${routeKey}` — internal handle,
    // never seen by users.
    expect(Object.keys(cfg.services)).toContain("opus::claude_code");
    expect(cfg.services["opus::claude_code"]?.harness).toBe("claude_code");
    expect(cfg.services["opus::claude_code"]?.tier).toBe("subscription");
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
      const cfg = await loadConfig(p);
      expect(cfg.services["opus::claude_code"]).toBeDefined();
      expect(cfg.services["opus::api.anthropic.com"]).toBeDefined();
      expect(cfg.services["opus::api.anthropic.com"]?.apiKey).toBe("sk-test");
      expect(cfg.services["opus::api.anthropic.com"]?.baseUrl).toBe("https://api.anthropic.com/v1");
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  it("multi-harness subscription emits one service per harness", async () => {
    const yamlText = `
priority: [opus]
models:
  opus:
    subscription:
      - harness: claude_code
        command: claude
      - harness: cursor
        command: agent
      - harness: opencode
        command: opencode
`;
    const p = await writeTmpYaml("multi.yaml", yamlText);
    const cfg = await loadConfig(p);
    expect(Object.keys(cfg.services).sort()).toEqual([
      "opus::claude_code",
      "opus::cursor",
      "opus::opencode",
    ]);
  });

  it("expands mixture_default model keys to all per-model service ids", async () => {
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
    const cfg = await loadConfig(p);
    expect([...(cfg.mixtureDefault ?? [])].sort()).toEqual([
      "opus::api.anthropic.com",
      "opus::claude_code",
    ]);
  });
});

describe("loadConfig — error paths", () => {
  it("throws ConfigMissingError when the file doesn't exist", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "harness-router-missing-"));
    const ghost = path.join(dir, "no-such-file.yaml");
    await expect(loadConfig(ghost)).rejects.toThrow(ConfigMissingError);
    await expect(loadConfig(ghost)).rejects.toThrow(/onboard/i);
  });

  it("throws ConfigError when YAML is missing the `models:` field", async () => {
    const yamlText = `
priority: []
`;
    const p = await writeTmpYaml("nomodel.yaml", yamlText);
    await expect(loadConfig(p)).rejects.toThrow(ConfigError);
    await expect(loadConfig(p)).rejects.toThrow(/models/i);
  });
});

describe("loadConfig — ${ENV_VAR} interpolation", () => {
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
    const cfg = await loadConfig(p);
    expect(cfg.services["opus::api.anthropic.com"]?.apiKey).toBe("test-key-xyz");
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

  // A minimal valid config for watchConfig — it only triggers reload on
  // mtime change, not on content semantics, so this just needs to parse.
  const okYaml = `priority: [opus]
models:
  opus:
    subscription:
      harness: claude_code
`;

  it("calls onChange when the file's mtime changes", async () => {
    const p = await writeTmpYaml("watch.yaml", okYaml);
    const events: Array<{ time: number }> = [];
    const w = watchConfig(
      p,
      () => {
        events.push({ time: Date.now() });
      },
      { intervalMs: 50 },
    );
    watchers.push(w);

    await new Promise((r) => setTimeout(r, 120));

    const newMtime = new Date(Date.now() + 2000);
    await fs.writeFile(p, okYaml + "\n# changed\n", "utf-8");
    await fs.utimes(p, newMtime, newMtime);

    await new Promise((r) => setTimeout(r, 250));
    expect(events.length).toBeGreaterThanOrEqual(1);
  });

  it("stops polling after stop() is called", async () => {
    const p = await writeTmpYaml("stop.yaml", okYaml);
    let calls = 0;
    const w = watchConfig(
      p,
      () => {
        calls += 1;
      },
      { intervalMs: 30 },
    );
    await new Promise((r) => setTimeout(r, 80));
    w.stop();
    const callsAfterStop = calls;
    await new Promise((r) => setTimeout(r, 30));
    const newMtime = new Date(Date.now() + 2000);
    await fs.writeFile(p, okYaml + "\n# changed\n", "utf-8");
    await fs.utimes(p, newMtime, newMtime);
    await new Promise((r) => setTimeout(r, 120));
    expect(calls).toBe(callsAfterStop);
  });
});
