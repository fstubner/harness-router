/**
 * Adapter tests — V3Config → RouterConfig.
 *
 * The adapter is the bridge that lets the existing v0.2 runtime consume
 * v0.3 configs without changes elsewhere. Tests focus on:
 *   - synthetic service id round-trip
 *   - v0.2 ServiceConfig shape correctness for both tiers
 *   - mixture_default expansion (model-keyed → service-id list)
 *   - disabled-route propagation
 */

import { describe, expect, it } from "vitest";

import {
  parseSyntheticServiceId,
  syntheticServiceId,
  v3ToRouterConfig,
} from "../../src/v3/adapter.js";
import type { V3Config } from "../../src/v3/types.js";

describe("syntheticServiceId / parseSyntheticServiceId", () => {
  it("round-trips simple model names", () => {
    const id = syntheticServiceId("opus", "subscription");
    expect(id).toBe("opus__subscription");
    expect(parseSyntheticServiceId(id)).toEqual({ model: "opus", tier: "subscription" });
  });

  it("round-trips model names containing underscores", () => {
    const id = syntheticServiceId("gpt_5_4", "metered");
    expect(parseSyntheticServiceId(id)).toEqual({ model: "gpt_5_4", tier: "metered" });
  });

  it("round-trips model names containing dots and dashes", () => {
    const id = syntheticServiceId("claude-opus-4-7", "subscription");
    expect(parseSyntheticServiceId(id)).toEqual({
      model: "claude-opus-4-7",
      tier: "subscription",
    });
  });

  it("returns null for ids without the separator", () => {
    expect(parseSyntheticServiceId("just-a-name")).toBeNull();
  });

  it("returns null for ids whose tail isn't a known tier", () => {
    expect(parseSyntheticServiceId("opus__premium")).toBeNull();
  });
});

describe("v3ToRouterConfig — shape correctness", () => {
  it("emits one subscription service per model with subscription route", () => {
    const v3: V3Config = {
      priority: ["opus"],
      models: {
        opus: { subscription: { harness: "claude_code", command: "claude" } },
      },
    };
    const v2 = v3ToRouterConfig(v3);
    const svc = v2.services["opus__subscription"];
    expect(svc).toBeDefined();
    expect(svc?.tier).toBe("subscription");
    expect(svc?.harness).toBe("claude_code");
    expect(svc?.command).toBe("claude");
    expect(svc?.model).toBe("opus");
    expect(svc?.type).toBe("cli");
  });

  it("emits one metered service per model with metered route", () => {
    const v3: V3Config = {
      priority: ["opus"],
      models: {
        opus: {
          metered: {
            base_url: "https://api.anthropic.com/v1",
            api_key: "sk-test",
          },
        },
      },
    };
    const v2 = v3ToRouterConfig(v3);
    const svc = v2.services["opus__metered"];
    expect(svc).toBeDefined();
    expect(svc?.tier).toBe("metered");
    expect(svc?.type).toBe("openai_compatible");
    expect(svc?.baseUrl).toBe("https://api.anthropic.com/v1");
    expect(svc?.apiKey).toBe("sk-test");
  });

  it("emits both services for a model with both routes", () => {
    const v3: V3Config = {
      priority: ["opus"],
      models: {
        opus: {
          subscription: { harness: "claude_code", command: "claude" },
          metered: { base_url: "https://api.anthropic.com/v1" },
        },
      },
    };
    const v2 = v3ToRouterConfig(v3);
    expect(Object.keys(v2.services).sort()).toEqual(["opus__metered", "opus__subscription"]);
  });

  it("propagates cli_model_override to ServiceConfig.cliModel", () => {
    const v3: V3Config = {
      priority: ["claude-opus-4-7"],
      models: {
        "claude-opus-4-7": {
          subscription: {
            harness: "claude_code",
            command: "claude",
            cli_model_override: "opus",
          },
        },
      },
    };
    const v2 = v3ToRouterConfig(v3);
    const svc = v2.services["claude-opus-4-7__subscription"];
    expect(svc?.cliModel).toBe("opus");
    expect(svc?.model).toBe("claude-opus-4-7");
  });

  it("uses generic_cli type when generic_cli recipe is present", () => {
    const v3: V3Config = {
      priority: ["x"],
      models: {
        x: {
          subscription: {
            harness: "x",
            command: "x-bin",
            generic_cli: { argsBeforePrompt: ["run"] },
          },
        },
      },
    };
    const v2 = v3ToRouterConfig(v3);
    const svc = v2.services["x__subscription"];
    expect(svc?.type).toBe("generic_cli");
    expect(svc?.genericCli).toEqual({ argsBeforePrompt: ["run"] });
  });

  it("preserves modelPriority verbatim", () => {
    const v3: V3Config = {
      priority: ["opus", "gpt-5.4", "pro"],
      models: {
        opus: { subscription: { harness: "claude_code" } },
        "gpt-5.4": { subscription: { harness: "cursor" } },
        pro: { metered: { base_url: "https://generativelanguage.googleapis.com/v1beta/openai" } },
      },
    };
    const v2 = v3ToRouterConfig(v3);
    expect(v2.modelPriority).toEqual(["opus", "gpt-5.4", "pro"]);
  });
});

describe("v3ToRouterConfig — mixture_default expansion", () => {
  it("expands a model-keyed mixture_default to all of that model's tier service ids", () => {
    const v3: V3Config = {
      priority: ["opus", "gpt-5.4"],
      mixture_default: ["opus"],
      models: {
        opus: {
          subscription: { harness: "claude_code" },
          metered: { base_url: "https://api.anthropic.com/v1" },
        },
        "gpt-5.4": { subscription: { harness: "cursor" } },
      },
    };
    const v2 = v3ToRouterConfig(v3);
    // mixture_default: [opus] → both subscription + metered service ids for opus
    expect(v2.mixtureDefault).toEqual(["opus__subscription", "opus__metered"]);
  });

  it("only emits service ids that exist (skips models with no entry)", () => {
    const v3: V3Config = {
      priority: [],
      mixture_default: ["opus", "ghost"], // ghost not in models
      models: {
        opus: { subscription: { harness: "claude_code" } },
      },
    };
    const v2 = v3ToRouterConfig(v3);
    expect(v2.mixtureDefault).toEqual(["opus__subscription"]);
  });

  it("omits mixtureDefault when expansion produces zero ids", () => {
    const v3: V3Config = {
      priority: [],
      mixture_default: ["ghost"],
      models: { opus: { subscription: { harness: "claude_code" } } },
    };
    const v2 = v3ToRouterConfig(v3);
    expect(v2.mixtureDefault).toBeUndefined();
  });
});

describe("v3ToRouterConfig — disabled propagation", () => {
  it("includes disabled routes in the disabled list AND marks svc.enabled false", () => {
    const v3: V3Config = {
      priority: ["opus"],
      models: {
        opus: {
          subscription: { harness: "claude_code", enabled: false },
          metered: { base_url: "https://api.anthropic.com/v1" },
        },
      },
    };
    const v2 = v3ToRouterConfig(v3);
    expect(v2.services["opus__subscription"]?.enabled).toBe(false);
    expect(v2.services["opus__metered"]?.enabled).toBe(true);
    expect(v2.disabled).toContain("opus__subscription");
    expect(v2.disabled).not.toContain("opus__metered");
  });

  it("omits disabled list when no routes are disabled", () => {
    const v3: V3Config = {
      priority: ["opus"],
      models: {
        opus: { subscription: { harness: "claude_code" } },
      },
    };
    const v2 = v3ToRouterConfig(v3);
    expect(v2.disabled).toBeUndefined();
  });
});
