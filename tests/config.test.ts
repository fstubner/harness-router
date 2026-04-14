/**
 * Config loader tests.
 *
 * Covers: legacy YAML format, auto-detect + overrides, ${ENV_VAR} interpolation,
 * and the mtime-based watchConfig poller.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadConfig, watchConfig, type WhichFn } from "../src/config.js";

// ---- fixture files -------------------------------------------------------

async function writeTmpYaml(name: string, text: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `coding-agent-mcp-test-`));
  const p = path.join(dir, name);
  await fs.writeFile(p, text, "utf-8");
  return p;
}

// Mock which-functions for deterministic auto-detect.
const noCliFound: WhichFn = async () => null;
const allCliFound: WhichFn = async (cmd) => `/usr/bin/${cmd}`;
const onlyClaudeFound: WhichFn = async (cmd) => (cmd === "claude" ? "/usr/bin/claude" : null);

describe("loadConfig — legacy full format", () => {
  it("passes a YAML with a top-level services: key through verbatim", async () => {
    const yamlText = `
services:
  alpha:
    enabled: true
    type: cli
    command: alpha-bin
    tier: 1
    weight: 1.5
    cli_capability: 1.10
    leaderboard_model: claude-opus-4-6
    capabilities:
      execute: 0.9
      plan: 1.0
      review: 0.95
  beta:
    enabled: false
    type: openai_compatible
    base_url: http://localhost:11434/v1
    model: llama3
    tier: 3
`;
    const p = await writeTmpYaml("config.yaml", yamlText);
    const cfg = await loadConfig(p, { whichFn: noCliFound });
    expect(Object.keys(cfg.services).sort()).toEqual(["alpha", "beta"]);
    expect(cfg.services.alpha!.tier).toBe(1);
    expect(cfg.services.alpha!.weight).toBeCloseTo(1.5, 10);
    expect(cfg.services.alpha!.cliCapability).toBeCloseTo(1.1, 10);
    expect(cfg.services.alpha!.leaderboardModel).toBe("claude-opus-4-6");
    expect(cfg.services.alpha!.capabilities.execute).toBeCloseTo(0.9, 10);
    expect(cfg.services.beta!.enabled).toBe(false);
    expect(cfg.services.beta!.type).toBe("openai_compatible");
    expect(cfg.services.beta!.baseUrl).toBe("http://localhost:11434/v1");
  });
});

describe("loadConfig — auto-detect + overrides", () => {
  const origEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...origEnv };
  });

  it("returns only services whose CLI is on PATH", async () => {
    const cfg = await loadConfig(undefined, { whichFn: onlyClaudeFound });
    expect(Object.keys(cfg.services)).toEqual(["claude_code"]);
    const svc = cfg.services.claude_code!;
    expect(svc.harness).toBe("claude_code");
    expect(svc.command).toBe("claude");
    expect(svc.cliCapability).toBeCloseTo(1.1, 10);
    expect(svc.leaderboardModel).toBe("claude-opus-4-6");
  });

  it("returns all default services when all CLIs are found", async () => {
    const cfg = await loadConfig(undefined, { whichFn: allCliFound });
    expect(Object.keys(cfg.services).sort()).toEqual([
      "claude_code",
      "codex",
      "cursor",
      "gemini_cli",
    ]);
  });

  it("merges overrides onto auto-detected defaults", async () => {
    const yamlText = `
overrides:
  claude_code:
    weight: 1.5
    capabilities:
      execute: 0.5
`;
    const p = await writeTmpYaml("minimal.yaml", yamlText);
    const cfg = await loadConfig(p, { whichFn: allCliFound });
    const cc = cfg.services.claude_code!;
    expect(cc.weight).toBeCloseTo(1.5, 10);
    expect(cc.capabilities.execute).toBeCloseTo(0.5, 10);
    // Non-overridden capability stays at default
    expect(cc.capabilities.plan).toBeCloseTo(1.0, 10);
  });

  it("honors the disabled list", async () => {
    const yamlText = `
disabled: [cursor, codex]
`;
    const p = await writeTmpYaml("disabled.yaml", yamlText);
    const cfg = await loadConfig(p, { whichFn: allCliFound });
    expect(Object.keys(cfg.services).sort()).toEqual(["claude_code", "gemini_cli"]);
  });

  it("adds endpoints from the endpoints: list", async () => {
    const yamlText = `
endpoints:
  - name: ollama
    base_url: http://localhost:11434/v1
    model: llama3
    tier: 3
    weight: 0.8
`;
    const p = await writeTmpYaml("endpoints.yaml", yamlText);
    const cfg = await loadConfig(p, { whichFn: noCliFound });
    expect(cfg.services.ollama).toBeDefined();
    expect(cfg.services.ollama!.type).toBe("openai_compatible");
    expect(cfg.services.ollama!.baseUrl).toBe("http://localhost:11434/v1");
    expect(cfg.services.ollama!.tier).toBe(3);
    expect(cfg.services.ollama!.weight).toBeCloseTo(0.8, 10);
  });
});

describe("loadConfig — ${ENV_VAR} interpolation", () => {
  const origEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...origEnv };
  });

  it("replaces ${GEMINI_API_KEY} with the environment value", async () => {
    process.env.GEMINI_API_KEY = "test-key-xyz";
    const yamlText = `
gemini_api_key: \${GEMINI_API_KEY}
`;
    const p = await writeTmpYaml("env.yaml", yamlText);
    const cfg = await loadConfig(p, { whichFn: noCliFound });
    expect(cfg.geminiApiKey).toBe("test-key-xyz");
  });

  it("interpolates strings inside nested overrides", async () => {
    process.env.MY_MODEL = "custom-model-1";
    const yamlText = `
overrides:
  claude_code:
    model: \${MY_MODEL}
`;
    const p = await writeTmpYaml("nested.yaml", yamlText);
    const cfg = await loadConfig(p, { whichFn: allCliFound });
    expect(cfg.services.claude_code!.model).toBe("custom-model-1");
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

  it("calls onChange when the file's mtime changes", async () => {
    const p = await writeTmpYaml("watch.yaml", "disabled: []\n");
    const events: Array<{ time: number }> = [];
    const w = watchConfig(
      p,
      () => {
        events.push({ time: Date.now() });
      },
      { intervalMs: 50, whichFn: noCliFound },
    );
    watchers.push(w);

    // Wait for initial baseline poll to register current mtime.
    await new Promise((r) => setTimeout(r, 120));

    // Force a visibly newer mtime (some filesystems have 1-second resolution).
    const newMtime = new Date(Date.now() + 2000);
    await fs.writeFile(p, "disabled: [cursor]\n", "utf-8");
    await fs.utimes(p, newMtime, newMtime);

    // Give the poller a couple of ticks to notice.
    await new Promise((r) => setTimeout(r, 250));

    expect(events.length).toBeGreaterThanOrEqual(1);
  });

  it("stops polling after stop() is called", async () => {
    const p = await writeTmpYaml("stop.yaml", "disabled: []\n");
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
    // Modify the file — the stopped watcher should not notice.
    await new Promise((r) => setTimeout(r, 30));
    const newMtime = new Date(Date.now() + 2000);
    await fs.writeFile(p, "disabled: [cursor]\n", "utf-8");
    await fs.utimes(p, newMtime, newMtime);
    await new Promise((r) => setTimeout(r, 120));
    expect(calls).toBe(callsAfterStop);
  });
});
