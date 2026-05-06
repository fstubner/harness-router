/**
 * Tests for the v0.3 wizard's pure parts.
 *
 * The interactive prompts can't be unit-tested without a TTY, but
 * `buildV3WizardConfig` (the model-keyed config builder) is a pure
 * function — same testability story as v0.2's buildWizardConfig.
 */

import { describe, expect, it } from "vitest";

import {
  buildV3WizardConfig,
  renderV3WizardYaml,
  type ModelChoice,
} from "../../src/onboarding/wizard.js";
import type { HarnessId } from "../../src/onboarding.js";

const harnessCommand = (id: HarnessId): string =>
  ({
    claude_code: "claude",
    codex: "codex",
    cursor: "agent",
    gemini_cli: "gemini",
    opencode: "opencode",
    copilot: "copilot",
  })[id] ?? id;

describe("buildV3WizardConfig", () => {
  it("builds a model-keyed entry with subscription route only", () => {
    const cfg = buildV3WizardConfig({
      priority: ["opus"],
      choices: [{ key: "opus", subscriptionHarness: "claude_code" }],
      harnessCommand,
      envFn: () => undefined,
    });
    expect(cfg.priority).toEqual(["opus"]);
    expect(cfg.models.opus?.subscription?.harness).toBe("claude_code");
    expect(cfg.models.opus?.subscription?.command).toBe("claude");
    expect(cfg.models.opus?.metered).toBeUndefined();
  });

  it("adds a metered route when addMetered is true and the env var is set", () => {
    const cfg = buildV3WizardConfig({
      priority: ["claude-opus-4-7"],
      choices: [{ key: "claude-opus-4-7", subscriptionHarness: "claude_code", addMetered: true }],
      harnessCommand,
      envFn: (n) => (n === "ANTHROPIC_API_KEY" ? "sk-test" : undefined),
    });
    expect(cfg.models["claude-opus-4-7"]?.metered).toBeDefined();
    expect(cfg.models["claude-opus-4-7"]?.metered?.base_url).toBe("https://api.anthropic.com/v1");
    // Never embeds the actual key value — uses the ${VAR} placeholder.
    expect(cfg.models["claude-opus-4-7"]?.metered?.api_key).toBe("${ANTHROPIC_API_KEY}");
  });

  it("does not add metered when addMetered is true but no env var is set", () => {
    const cfg = buildV3WizardConfig({
      priority: ["claude-opus-4-7"],
      choices: [{ key: "claude-opus-4-7", addMetered: true }], // no subscription either
      harnessCommand,
      envFn: () => undefined,
    });
    // Entry with neither route should be skipped entirely — no orphan model
    // entry appears in the output.
    expect(cfg.models["claude-opus-4-7"]).toBeUndefined();
    expect(cfg.priority).toEqual([]);
  });

  it("routes the right provider per model key based on heuristic match", () => {
    const cfg = buildV3WizardConfig({
      priority: ["claude-opus-4-7", "gpt-5.4", "gemini-2.5-pro"],
      choices: [
        { key: "claude-opus-4-7", addMetered: true },
        { key: "gpt-5.4", addMetered: true },
        { key: "gemini-2.5-pro", addMetered: true },
      ],
      harnessCommand,
      envFn: (n) =>
        n === "ANTHROPIC_API_KEY" || n === "OPENAI_API_KEY" || n === "GEMINI_API_KEY"
          ? "sk-test"
          : undefined,
    });
    expect(cfg.models["claude-opus-4-7"]?.metered?.base_url).toMatch(/anthropic/);
    expect(cfg.models["gpt-5.4"]?.metered?.base_url).toMatch(/openai/);
    expect(cfg.models["gemini-2.5-pro"]?.metered?.base_url).toMatch(/googleapis/);
  });

  it("filters priority to entries that survived (no orphan keys)", () => {
    const cfg = buildV3WizardConfig({
      priority: ["alive", "dead"],
      choices: [
        { key: "alive", subscriptionHarness: "claude_code" },
        { key: "dead" }, // no harness, no metered → dropped
      ],
      harnessCommand,
      envFn: () => undefined,
    });
    expect(cfg.priority).toEqual(["alive"]);
    expect(cfg.models.alive).toBeDefined();
    expect(cfg.models.dead).toBeUndefined();
  });

  it("preserves mixture_default and dedupes", () => {
    const cfg = buildV3WizardConfig({
      priority: ["a", "b"],
      choices: [
        { key: "a", subscriptionHarness: "claude_code" },
        { key: "b", subscriptionHarness: "codex" },
      ],
      mixtureDefault: ["a", "b", "a"], // dupe
      harnessCommand,
      envFn: () => undefined,
    });
    expect(cfg.mixture_default).toEqual(["a", "b"]);
  });

  it("filters mixture_default to keys that exist in models", () => {
    const cfg = buildV3WizardConfig({
      priority: ["a"],
      choices: [{ key: "a", subscriptionHarness: "claude_code" }],
      mixtureDefault: ["a", "ghost"],
      harnessCommand,
      envFn: () => undefined,
    });
    expect(cfg.mixture_default).toEqual(["a"]);
  });

  it("omits mixture_default when no surviving entries", () => {
    const cfg = buildV3WizardConfig({
      priority: ["a"],
      choices: [{ key: "a", subscriptionHarness: "claude_code" }],
      mixtureDefault: ["ghost"],
      harnessCommand,
      envFn: () => undefined,
    });
    expect(cfg.mixture_default).toBeUndefined();
  });

  it("handles a model with both subscription harness and metered fallback", () => {
    const choices: ModelChoice[] = [
      {
        key: "claude-opus-4-7",
        subscriptionHarness: "claude_code",
        addMetered: true,
      },
    ];
    const cfg = buildV3WizardConfig({
      priority: ["claude-opus-4-7"],
      choices,
      harnessCommand,
      envFn: (n) => (n === "ANTHROPIC_API_KEY" ? "sk-test" : undefined),
    });
    expect(cfg.models["claude-opus-4-7"]?.subscription).toBeDefined();
    expect(cfg.models["claude-opus-4-7"]?.metered).toBeDefined();
  });
});

describe("renderV3WizardYaml", () => {
  it("emits valid YAML with priority + models + mixture_default", () => {
    const cfg = buildV3WizardConfig({
      priority: ["opus", "gpt-5.4"],
      choices: [
        { key: "opus", subscriptionHarness: "claude_code" },
        { key: "gpt-5.4", subscriptionHarness: "cursor" },
      ],
      mixtureDefault: ["opus", "gpt-5.4"],
      harnessCommand,
      envFn: () => undefined,
    });
    const out = renderV3WizardYaml(cfg);
    expect(out).toContain("priority:");
    expect(out).toContain("- opus");
    expect(out).toContain("- gpt-5.4");
    expect(out).toContain("models:");
    expect(out).toContain("opus:");
    expect(out).toContain("subscription:");
    expect(out).toContain("harness: claude_code");
    expect(out).toContain("mixture_default:");
  });

  it("never embeds the raw env var value — only the ${VAR} placeholder", () => {
    const cfg = buildV3WizardConfig({
      priority: ["claude-opus-4-7"],
      choices: [{ key: "claude-opus-4-7", addMetered: true }],
      harnessCommand,
      envFn: (n) => (n === "ANTHROPIC_API_KEY" ? "sk-secret-DO-NOT-LEAK" : undefined),
    });
    const yaml = renderV3WizardYaml(cfg);
    expect(yaml).not.toContain("sk-secret-DO-NOT-LEAK");
    expect(yaml).toContain("${ANTHROPIC_API_KEY}");
  });
});
