/**
 * Tests for the v0.3 wizard's pure parts.
 *
 * The interactive prompts can't be unit-tested without a TTY, but
 * `buildWizardConfig` (the model-keyed config builder) is a pure function.
 */

import { describe, expect, it } from "vitest";

import {
  buildWizardConfig,
  renderWizardYaml,
  type ModelChoice,
} from "../../src/onboarding/wizard.js";
import type { HarnessId } from "../../src/harnesses.js";

const harnessCommand = (id: HarnessId): string =>
  ({
    claude_code: "claude",
    codex: "codex",
    cursor: "agent",
    gemini_cli: "gemini",
    opencode: "opencode",
    copilot: "copilot",
  })[id] ?? id;

describe("buildWizardConfig — single harness", () => {
  it("builds a model-keyed entry with one subscription harness", () => {
    const cfg = buildWizardConfig({
      priority: ["opus"],
      choices: [{ key: "opus", subscriptionHarnesses: ["claude_code"] }],
      harnessCommand,
      envFn: () => undefined,
    });
    expect(cfg.priority).toEqual(["opus"]);
    expect(cfg.models.opus?.subscription).toHaveLength(1);
    expect(cfg.models.opus?.subscription?.[0]?.harness).toBe("claude_code");
    expect(cfg.models.opus?.subscription?.[0]?.command).toBe("claude");
    expect(cfg.models.opus?.metered).toBeUndefined();
  });

  it("does not include subscription when subscriptionHarnesses is empty/undefined", () => {
    // Use a model name that triggers the Anthropic provider matcher
    // (requires "claude" substring) so addMetered actually produces a route.
    const cfg = buildWizardConfig({
      priority: ["claude-opus-4-7"],
      choices: [{ key: "claude-opus-4-7", addMetered: true }],
      harnessCommand,
      envFn: (n) => (n === "ANTHROPIC_API_KEY" ? "sk" : undefined),
    });
    expect(cfg.models["claude-opus-4-7"]?.subscription).toBeUndefined();
    expect(cfg.models["claude-opus-4-7"]?.metered).toHaveLength(1);
  });
});

describe("buildWizardConfig — multi-harness subscription", () => {
  it("emits N subscription routes for N harnesses, in order", () => {
    const cfg = buildWizardConfig({
      priority: ["opus"],
      choices: [
        {
          key: "opus",
          subscriptionHarnesses: ["claude_code", "cursor", "opencode"],
        },
      ],
      harnessCommand,
      envFn: () => undefined,
    });
    expect(cfg.models.opus?.subscription).toHaveLength(3);
    expect(cfg.models.opus?.subscription?.map((r) => r.harness)).toEqual([
      "claude_code",
      "cursor",
      "opencode",
    ]);
    expect(cfg.models.opus?.subscription?.map((r) => r.command)).toEqual([
      "claude",
      "agent",
      "opencode",
    ]);
  });

  it("preserves harness order so router walks priority within tier", () => {
    // Order matters — the router uses array index as a quota-tiebreak when
    // multiple routes have equal headroom. Putting claude_code first means
    // it wins ties, e.g. when both Claude Pro and Cursor Pro have full quota.
    const cfg = buildWizardConfig({
      priority: ["opus"],
      choices: [{ key: "opus", subscriptionHarnesses: ["cursor", "claude_code"] }],
      harnessCommand,
      envFn: () => undefined,
    });
    expect(cfg.models.opus?.subscription?.[0]?.harness).toBe("cursor");
    expect(cfg.models.opus?.subscription?.[1]?.harness).toBe("claude_code");
  });
});

describe("buildWizardConfig — metered fallback", () => {
  it("adds a metered route when addMetered is true and the env var is set", () => {
    const cfg = buildWizardConfig({
      priority: ["claude-opus-4-7"],
      choices: [
        {
          key: "claude-opus-4-7",
          subscriptionHarnesses: ["claude_code"],
          addMetered: true,
        },
      ],
      harnessCommand,
      envFn: (n) => (n === "ANTHROPIC_API_KEY" ? "sk-test" : undefined),
    });
    expect(cfg.models["claude-opus-4-7"]?.metered).toHaveLength(1);
    expect(cfg.models["claude-opus-4-7"]?.metered?.[0]?.base_url).toBe(
      "https://api.anthropic.com/v1",
    );
    // Never embeds the actual key value — uses the ${VAR} placeholder.
    expect(cfg.models["claude-opus-4-7"]?.metered?.[0]?.api_key).toBe("${ANTHROPIC_API_KEY}");
  });

  it("does not add metered when addMetered is true but no env var is set", () => {
    const cfg = buildWizardConfig({
      priority: ["claude-opus-4-7"],
      choices: [{ key: "claude-opus-4-7", addMetered: true }],
      harnessCommand,
      envFn: () => undefined,
    });
    // Entry with neither route should be skipped — no orphan model entry.
    expect(cfg.models["claude-opus-4-7"]).toBeUndefined();
    expect(cfg.priority).toEqual([]);
  });

  it("routes the right provider per model key based on heuristic match", () => {
    const cfg = buildWizardConfig({
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
    expect(cfg.models["claude-opus-4-7"]?.metered?.[0]?.base_url).toMatch(/anthropic/);
    expect(cfg.models["gpt-5.4"]?.metered?.[0]?.base_url).toMatch(/openai/);
    expect(cfg.models["gemini-2.5-pro"]?.metered?.[0]?.base_url).toMatch(/googleapis/);
  });
});

describe("buildWizardConfig — priority + mixture filtering", () => {
  it("filters priority to entries that survived (no orphan keys)", () => {
    const cfg = buildWizardConfig({
      priority: ["alive", "dead"],
      choices: [
        { key: "alive", subscriptionHarnesses: ["claude_code"] },
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
    const cfg = buildWizardConfig({
      priority: ["a", "b"],
      choices: [
        { key: "a", subscriptionHarnesses: ["claude_code"] },
        { key: "b", subscriptionHarnesses: ["codex"] },
      ],
      mixtureDefault: ["a", "b", "a"], // dupe
      harnessCommand,
      envFn: () => undefined,
    });
    expect(cfg.mixture_default).toEqual(["a", "b"]);
  });

  it("filters mixture_default to keys that exist in models", () => {
    const cfg = buildWizardConfig({
      priority: ["a"],
      choices: [{ key: "a", subscriptionHarnesses: ["claude_code"] }],
      mixtureDefault: ["a", "ghost"],
      harnessCommand,
      envFn: () => undefined,
    });
    expect(cfg.mixture_default).toEqual(["a"]);
  });

  it("omits mixture_default when no surviving entries", () => {
    const cfg = buildWizardConfig({
      priority: ["a"],
      choices: [{ key: "a", subscriptionHarnesses: ["claude_code"] }],
      mixtureDefault: ["ghost"],
      harnessCommand,
      envFn: () => undefined,
    });
    expect(cfg.mixture_default).toBeUndefined();
  });

  it("handles a model with multiple subscription harnesses + metered fallback", () => {
    const choices: ModelChoice[] = [
      {
        key: "claude-opus-4-7",
        subscriptionHarnesses: ["claude_code", "cursor"],
        addMetered: true,
      },
    ];
    const cfg = buildWizardConfig({
      priority: ["claude-opus-4-7"],
      choices,
      harnessCommand,
      envFn: (n) => (n === "ANTHROPIC_API_KEY" ? "sk-test" : undefined),
    });
    expect(cfg.models["claude-opus-4-7"]?.subscription).toHaveLength(2);
    expect(cfg.models["claude-opus-4-7"]?.metered).toHaveLength(1);
  });
});

describe("renderWizardYaml", () => {
  it("emits valid YAML with priority + models + mixture_default", () => {
    const cfg = buildWizardConfig({
      priority: ["opus", "gpt-5.4"],
      choices: [
        { key: "opus", subscriptionHarnesses: ["claude_code", "cursor"] },
        { key: "gpt-5.4", subscriptionHarnesses: ["cursor"] },
      ],
      mixtureDefault: ["opus", "gpt-5.4"],
      harnessCommand,
      envFn: () => undefined,
    });
    const out = renderWizardYaml(cfg);
    expect(out).toContain("priority:");
    expect(out).toContain("- opus");
    expect(out).toContain("- gpt-5.4");
    expect(out).toContain("models:");
    expect(out).toContain("opus:");
    expect(out).toContain("subscription:");
    expect(out).toContain("harness: claude_code");
    expect(out).toContain("harness: cursor");
    expect(out).toContain("mixture_default:");
  });

  it("never embeds the raw env var value — only the ${VAR} placeholder", () => {
    const cfg = buildWizardConfig({
      priority: ["claude-opus-4-7"],
      choices: [{ key: "claude-opus-4-7", addMetered: true }],
      harnessCommand,
      envFn: (n) => (n === "ANTHROPIC_API_KEY" ? "sk-secret-DO-NOT-LEAK" : undefined),
    });
    const yaml = renderWizardYaml(cfg);
    expect(yaml).not.toContain("sk-secret-DO-NOT-LEAK");
    expect(yaml).toContain("${ANTHROPIC_API_KEY}");
  });
});
