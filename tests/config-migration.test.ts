/**
 * Schema-migration tests: a v0.1-shaped config.yaml loaded through the v0.2
 * parser. Greenfield project, but we still want users who edit a stale config
 * to get sensible behaviour rather than silent surprises.
 */

import { describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadConfig } from "../src/config.js";

async function writeTmp(name: string, content: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "harness-router-mcp-mig-"));
  const p = path.join(dir, name);
  await fs.writeFile(p, content, "utf-8");
  return p;
}

describe("v0.1 → v0.2 schema migration", () => {
  it("loads a fully v0.1-shaped config without crashing and surfaces a tier warning", async () => {
    // The full v0.1 service shape that v0.2 doesn't speak any more. Every
    // field below was meaningful in v0.1; v0.2 should silently drop the
    // ones that no longer exist (weight, cli_capability, capabilities,
    // escalate_*, leaderboard_model) and migrate `tier: 1|2|3` to a sane
    // string default.
    const yaml = [
      "services:",
      "  claude_code:",
      "    enabled: true",
      "    type: cli",
      "    command: claude",
      "    model: sonnet",
      "    tier: 1",
      "    weight: 1.5",
      "    cli_capability: 1.10",
      "    leaderboard_model: claude-opus-4-6",
      "    escalate_model: claude-opus-4-6",
      "    escalate_on: [plan, review]",
      "    capabilities:",
      "      execute: 0.95",
      "      plan: 1.0",
      "      review: 1.0",
      "  ollama_local:",
      "    enabled: true",
      "    type: openai_compatible",
      "    base_url: http://localhost:11434/v1",
      "    model: llama3",
      "    tier: 3",
      "    weight: 0.8",
    ].join("\n");
    const file = await writeTmp("v01.yaml", yaml);

    const warnings: string[] = [];
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
      warnings.push(typeof chunk === "string" ? chunk : String(chunk));
      return true;
    }) as typeof process.stderr.write);
    try {
      const cfg = await loadConfig(file, { whichFn: async () => null });

      // Every service still loads (no parse crash on unknown fields).
      expect(Object.keys(cfg.services).sort()).toEqual(["claude_code", "ollama_local"]);

      // tier number → migrated to string. Values that look like a v0.1 tier
      // number should NOT silently become "subscription" — that's a quiet
      // semantic shift. We expect at least a stderr warning so the operator
      // notices.
      const tierWarnings = warnings.filter((w) => /tier/i.test(w));
      expect(tierWarnings.length).toBeGreaterThan(0);

      // Sanity: the v0.1 shape that's now meaningless is silently absent
      // (TS would reject these fields on the type, but at runtime js-yaml
      // hands us extras and the parser ignores them). Confirm by spreading
      // and looking for them.
      const cc = cfg.services.claude_code as unknown as Record<string, unknown>;
      expect(cc.weight).toBeUndefined();
      expect(cc.cliCapability).toBeUndefined();
      expect(cc.capabilities).toBeUndefined();
      expect(cc.leaderboardModel).toBeUndefined();
      expect(cc.escalateModel).toBeUndefined();
      expect(cc.escalateOn).toBeUndefined();

      // The migrated tier should be a v0.2 string. We don't pin exactly to
      // "subscription" or "metered" yet — what matters is that it's one of
      // the two strings, not the original number.
      expect(["subscription", "metered"]).toContain(cfg.services.claude_code!.tier);
      expect(["subscription", "metered"]).toContain(cfg.services.ollama_local!.tier);

      // The legacy `services:` block path doesn't auto-derive modelPriority
      // unless model_priority is explicitly declared. With the new
      // greenfield default, the loader should still produce a non-empty
      // priority that includes both services' models.
      const priority = cfg.modelPriority ?? [];
      expect(priority).toContain("sonnet");
      expect(priority).toContain("llama3");
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it("treats a tier=3 (v0.1 fast/local tier) as metered for OpenAI-compatible services", async () => {
    // v0.1 convention: `tier: 3` was reserved for fast/local/API endpoints.
    // v0.2's two-tier split (subscription/metered) maps tier=3 most
    // naturally to metered for `openai_compatible` services. Verify that
    // migration produces the cost-conscious default.
    const yaml = [
      "services:",
      "  ollama_local:",
      "    enabled: true",
      "    type: openai_compatible",
      "    base_url: http://localhost:11434/v1",
      "    model: llama3",
      "    tier: 3",
    ].join("\n");
    const file = await writeTmp("v01-endpoint.yaml", yaml);
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const cfg = await loadConfig(file, { whichFn: async () => null });
      expect(cfg.services.ollama_local!.tier).toBe("metered");
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it("treats a tier=1 (v0.1 frontier tier) as subscription for built-in CLIs", async () => {
    const yaml = [
      "services:",
      "  claude_code:",
      "    enabled: true",
      "    type: cli",
      "    command: claude",
      "    model: sonnet",
      "    tier: 1",
    ].join("\n");
    const file = await writeTmp("v01-cli.yaml", yaml);
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const cfg = await loadConfig(file, { whichFn: async () => null });
      expect(cfg.services.claude_code!.tier).toBe("subscription");
    } finally {
      stderrSpy.mockRestore();
    }
  });
});
