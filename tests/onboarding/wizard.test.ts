/**
 * Unit tests for the pure parts of the onboard wizard. The interactive
 * prompts can't be unit-tested without a TTY, but `buildWizardConfig`
 * (the model-priority + service generator) is a pure function.
 */

import { describe, expect, it } from "vitest";

import { buildWizardConfig, renderWizardYaml } from "../../src/onboarding/wizard.js";
import { aggregateCatalog, cliModelFor } from "../../src/onboarding/models.js";

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
});
