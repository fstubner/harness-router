/**
 * Unit tests for the pure parts of the onboard wizard. The interactive
 * prompts can't be unit-tested without a TTY, but `buildWizardConfig`
 * (the model-priority + service generator) is a pure function.
 */

import { describe, expect, it } from "vitest";

import { buildWizardConfig, renderWizardYaml } from "../../src/onboarding/wizard.js";
import {
  aggregateCatalog,
  cliModelFor,
  findProviderMatches,
  METERED_PROVIDERS,
} from "../../src/onboarding/models.js";

describe("aggregateCatalog", () => {
  it("merges models served by multiple harnesses", () => {
    const out = aggregateCatalog(["claude_code", "cursor"]);
    // Both harnesses share no canonical name in our catalog (claude_code uses
    // 'opus', 'sonnet'; cursor uses 'Auto', 'Opus 4.6', etc.), so each
    // canonical should be served by exactly one harness.
    for (const row of out) {
      expect(row.servedBy).toHaveLength(1);
    }
    // The aggregated list contains entries from both harnesses.
    const fromClaude = out.filter((r) => r.servedBy.includes("claude_code"));
    const fromCursor = out.filter((r) => r.servedBy.includes("cursor"));
    expect(fromClaude.length).toBeGreaterThan(0);
    expect(fromCursor.length).toBeGreaterThan(0);
  });

  it("returns empty for unknown harnesses", () => {
    expect(aggregateCatalog(["fictional_harness"])).toEqual([]);
  });
});

describe("cliModelFor", () => {
  it("returns the cli-specific name for a known canonical", () => {
    expect(cliModelFor("claude_code", "opus")).toBe("opus");
    expect(cliModelFor("gemini_cli", "pro")).toBe("pro");
    expect(cliModelFor("codex", "gpt-5.4")).toBe("gpt-5.4");
  });

  it("returns undefined when the harness can't serve that canonical", () => {
    expect(cliModelFor("claude_code", "gpt-5.4")).toBeUndefined();
    expect(cliModelFor("codex", "opus")).toBeUndefined();
  });
});

describe("buildWizardConfig", () => {
  it("creates one service per detected harness, pinning each to the highest-priority model it can serve", () => {
    const cfg = buildWizardConfig({
      modelPriority: ["opus", "gpt-5.4", "sonnet"],
      detectedHarnesses: [
        { id: "claude_code", command: "claude" },
        { id: "codex", command: "codex" },
      ],
    });
    // claude_code can serve opus (1st in priority) and sonnet → picks opus
    expect(cfg.services.claude_code).toMatchObject({
      harness: "claude_code",
      command: "claude",
      model: "opus",
      cli_model: "opus",
      tier: "subscription",
    });
    // codex can serve gpt-5.4 (2nd in priority) → picks gpt-5.4
    expect(cfg.services.codex).toMatchObject({
      harness: "codex",
      command: "codex",
      model: "gpt-5.4",
      cli_model: "gpt-5.4",
    });
  });

  it("drops harnesses that can't serve any priority entry", () => {
    const cfg = buildWizardConfig({
      modelPriority: ["opus"], // only opus → codex can't serve, claude_code can
      detectedHarnesses: [
        { id: "claude_code", command: "claude" },
        { id: "codex", command: "codex" },
      ],
    });
    expect(cfg.services.claude_code).toBeDefined();
    expect(cfg.services.codex).toBeUndefined();
  });

  it("preserves modelPriority order verbatim", () => {
    const cfg = buildWizardConfig({
      modelPriority: ["gpt-5.4", "sonnet", "pro"],
      detectedHarnesses: [],
    });
    expect(cfg.modelPriority).toEqual(["gpt-5.4", "sonnet", "pro"]);
  });
});

describe("renderWizardYaml", () => {
  it("emits a valid YAML structure with model_priority + services", () => {
    const cfg = buildWizardConfig({
      modelPriority: ["opus", "gpt-5.4"],
      detectedHarnesses: [
        { id: "claude_code", command: "claude" },
        { id: "codex", command: "codex" },
      ],
    });
    const out = renderWizardYaml(cfg);
    expect(out).toContain("model_priority:");
    expect(out).toContain("- opus");
    expect(out).toContain("- gpt-5.4");
    expect(out).toContain("services:");
    expect(out).toContain("claude_code:");
    expect(out).toContain("codex:");
    expect(out).toContain("model: opus");
    expect(out).toContain("cli_model: opus");
    expect(out).toContain("tier: subscription");
  });

  it("emits mixture_default when set", () => {
    const cfg = buildWizardConfig({
      modelPriority: ["opus"],
      detectedHarnesses: [{ id: "claude_code", command: "claude" }],
      mixtureDefault: ["claude_code"],
    });
    const out = renderWizardYaml(cfg);
    expect(out).toContain("mixture_default:");
    expect(out).toMatch(/mixture_default:\s*\n\s+- claude_code/);
  });

  it("omits mixture_default when not set", () => {
    const cfg = buildWizardConfig({
      modelPriority: ["opus"],
      detectedHarnesses: [{ id: "claude_code", command: "claude" }],
    });
    expect(renderWizardYaml(cfg)).not.toContain("mixture_default");
  });
});

describe("METERED_PROVIDERS catalog", () => {
  it("ships the 3 providers we expect — Anthropic, OpenAI, Google", () => {
    const ids = METERED_PROVIDERS.map((p) => p.id).sort();
    expect(ids).toEqual(["anthropic_api", "google_api", "openai_api"]);
  });

  it("Anthropic recognises bare aliases and maps them to pinned API IDs", () => {
    const a = METERED_PROVIDERS.find((p) => p.id === "anthropic_api")!;
    expect(a.matchesCanonical("opus")).toBe(true);
    expect(a.matchesCanonical("sonnet")).toBe(true);
    expect(a.matchesCanonical("haiku")).toBe(true);
    expect(a.matchesCanonical("claude-opus-4-7")).toBe(true);
    expect(a.matchesCanonical("gpt-5.4")).toBe(false);
    // Aliases get mapped to API-pinned IDs.
    expect(a.cliModelFor("opus")).toMatch(/^claude-opus/);
    expect(a.cliModelFor("sonnet")).toMatch(/^claude-sonnet/);
  });

  it("OpenAI passes canonical verbatim (no override)", () => {
    const o = METERED_PROVIDERS.find((p) => p.id === "openai_api")!;
    expect(o.matchesCanonical("gpt-5.4")).toBe(true);
    expect(o.matchesCanonical("gpt-5.4-mini")).toBe(true);
    expect(o.matchesCanonical("o1-pro")).toBe(true);
    expect(o.matchesCanonical("opus")).toBe(false);
    expect(o.cliModelFor("gpt-5.4")).toBeUndefined();
  });

  it("Google maps Gemini aliases to pinned IDs", () => {
    const g = METERED_PROVIDERS.find((p) => p.id === "google_api")!;
    expect(g.matchesCanonical("pro")).toBe(true);
    expect(g.matchesCanonical("flash")).toBe(true);
    expect(g.matchesCanonical("gemini-2.5-pro")).toBe(true);
    expect(g.matchesCanonical("gpt-5.4")).toBe(false);
    expect(g.cliModelFor("pro")).toBe("gemini-2.5-pro");
    expect(g.cliModelFor("flash")).toBe("gemini-2.5-flash");
  });
});

describe("findProviderMatches", () => {
  it("only returns providers whose env var is set", () => {
    const env = (n: string) => (n === "ANTHROPIC_API_KEY" ? "sk-…" : undefined);
    const matches = findProviderMatches(["opus", "gpt-5.4"], env);
    expect(matches).toHaveLength(1);
    expect(matches[0]!.provider.id).toBe("anthropic_api");
    expect(matches[0]!.models).toEqual(["opus"]);
  });

  it("filters models to ones each provider can serve", () => {
    const env = () => "sk-…"; // all keys present
    const matches = findProviderMatches(["opus", "gpt-5.4", "pro"], env);
    expect(matches).toHaveLength(3);
    const byId = new Map(matches.map((m) => [m.provider.id, m.models]));
    expect(byId.get("anthropic_api")).toEqual(["opus"]);
    expect(byId.get("openai_api")).toEqual(["gpt-5.4"]);
    expect(byId.get("google_api")).toEqual(["pro"]);
  });

  it("drops a provider with no matching priority models", () => {
    const env = () => "sk-…";
    const matches = findProviderMatches(["opus"], env); // only Claude-shaped
    expect(matches.map((m) => m.provider.id)).toEqual(["anthropic_api"]);
  });

  it("returns empty when no env vars are set", () => {
    expect(findProviderMatches(["opus", "gpt-5.4"], () => undefined)).toEqual([]);
  });
});

describe("buildWizardConfig — metered fallback", () => {
  it("generates one openai_compatible service per (provider × matching model)", () => {
    const env = () => "sk-…";
    const meteredProviders = findProviderMatches(["opus", "gpt-5.4"], env);
    const cfg = buildWizardConfig({
      modelPriority: ["opus", "gpt-5.4"],
      detectedHarnesses: [{ id: "claude_code", command: "claude" }],
      meteredProviders,
    });
    // 1 subscription service (claude_code) + 2 metered (anthropic for opus, openai for gpt-5.4)
    expect(Object.keys(cfg.services).sort()).toEqual([
      "anthropic_api_opus",
      "claude_code",
      "openai_api_gpt-5_4", // dot replaced with underscore
    ]);
    const anthropic = cfg.services.anthropic_api_opus!;
    expect(anthropic).toMatchObject({
      type: "openai_compatible",
      tier: "metered",
      base_url: "https://api.anthropic.com/v1",
      api_key: "${ANTHROPIC_API_KEY}", // env-interpolation token, not the actual key
      model: "opus",
    });
    // Anthropic maps "opus" alias to a pinned API id
    expect(anthropic.cli_model).toMatch(/^claude-opus/);
    const openai = cfg.services["openai_api_gpt-5_4"]!;
    expect(openai).toMatchObject({
      type: "openai_compatible",
      tier: "metered",
      api_key: "${OPENAI_API_KEY}",
      model: "gpt-5.4",
      cli_model: "gpt-5.4", // OpenAI passes verbatim
    });
  });

  it("never embeds the real env var value — only the ${VAR} placeholder", () => {
    // Critical: we must not expand env at YAML write time, or the secret
    // ends up on disk. The wizard writes the literal placeholder; the
    // config loader resolves at startup.
    const env = (n: string) => (n === "ANTHROPIC_API_KEY" ? "sk-secret-DO-NOT-LEAK" : undefined);
    const meteredProviders = findProviderMatches(["opus"], env);
    const cfg = buildWizardConfig({
      modelPriority: ["opus"],
      detectedHarnesses: [],
      meteredProviders,
    });
    const yaml = renderWizardYaml(cfg);
    expect(yaml).not.toContain("sk-secret-DO-NOT-LEAK");
    expect(yaml).toContain("${ANTHROPIC_API_KEY}");
  });

  it("renders an openai_compatible service with the right shape (no cli-only fields)", () => {
    const env = () => "sk-…";
    const meteredProviders = findProviderMatches(["opus"], env);
    const cfg = buildWizardConfig({
      modelPriority: ["opus"],
      detectedHarnesses: [],
      meteredProviders,
    });
    const yaml = renderWizardYaml(cfg);
    // openai_compatible services should NOT carry harness/command (those
    // are CLI-shape fields). Should carry base_url + api_key.
    expect(yaml).toContain("type: openai_compatible");
    expect(yaml).toContain("base_url:");
    expect(yaml).toContain("api_key:");
    expect(yaml).toContain("tier: metered");
    // anthropic block should not have a `harness:` key (only CLI services do).
    const anthropicBlock = yaml.split("anthropic_api_opus:")[1]!.split(/^\S/m)[0]!;
    expect(anthropicBlock).not.toMatch(/^\s*harness:/m);
    expect(anthropicBlock).not.toMatch(/^\s*command:/m);
  });
});
