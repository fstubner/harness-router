/**
 * Adapter tests — Config → RouterConfig.
 *
 * The adapter is the bridge that lets the runtime consume the on-disk
 * Config shape without internal layer changes. Tests focus on:
 *   - synthetic service id format `${model}::${routeKey}`
 *   - one ServiceConfig per route (multi-harness produces multiple services)
 *   - mixture_default expansion (model-keyed → all per-model service ids)
 *   - disabled-route propagation
 *   - collision handling when route keys would collide
 */

import { describe, expect, it } from "vitest";

import { syntheticServiceId, toRouterConfig } from "../../src/config/adapter.js";
import type { Config } from "../../src/config/types.js";

describe("syntheticServiceId", () => {
  it("composes a stable model::routeKey id", () => {
    expect(syntheticServiceId("opus", "claude_code")).toBe("opus::claude_code");
    expect(syntheticServiceId("gpt-5.4", "cursor")).toBe("gpt-5.4::cursor");
    expect(syntheticServiceId("opus", "api.anthropic.com")).toBe("opus::api.anthropic.com");
  });
});

describe("toRouterConfig — single-route shape", () => {
  it("emits one subscription service per (model, harness)", () => {
    const v3: Config = {
      priority: ["opus"],
      models: {
        opus: { subscription: [{ harness: "claude_code", command: "claude" }] },
      },
    };
    const v2 = toRouterConfig(v3);
    const id = "opus::claude_code";
    expect(v2.services[id]).toBeDefined();
    expect(v2.services[id]?.tier).toBe("subscription");
    expect(v2.services[id]?.harness).toBe("claude_code");
    expect(v2.services[id]?.command).toBe("claude");
    expect(v2.services[id]?.model).toBe("opus");
    expect(v2.services[id]?.type).toBe("cli");
  });

  it("emits one metered service per (model, base_url-host)", () => {
    const v3: Config = {
      priority: ["opus"],
      models: {
        opus: {
          metered: [{ base_url: "https://api.anthropic.com/v1", api_key: "sk-test" }],
        },
      },
    };
    const v2 = toRouterConfig(v3);
    const id = "opus::api.anthropic.com";
    expect(v2.services[id]).toBeDefined();
    expect(v2.services[id]?.tier).toBe("metered");
    expect(v2.services[id]?.type).toBe("openai_compatible");
    expect(v2.services[id]?.baseUrl).toBe("https://api.anthropic.com/v1");
    expect(v2.services[id]?.apiKey).toBe("sk-test");
  });
});

describe("toRouterConfig — multi-harness subscription", () => {
  it("emits one synthetic service per harness in the array", () => {
    const v3: Config = {
      priority: ["opus"],
      models: {
        opus: {
          subscription: [
            { harness: "claude_code", command: "claude" },
            { harness: "cursor", command: "agent" },
            { harness: "opencode", command: "opencode" },
          ],
        },
      },
    };
    const v2 = toRouterConfig(v3);
    expect(Object.keys(v2.services).sort()).toEqual([
      "opus::claude_code",
      "opus::cursor",
      "opus::opencode",
    ]);
    expect(v2.services["opus::claude_code"]?.harness).toBe("claude_code");
    expect(v2.services["opus::cursor"]?.harness).toBe("cursor");
    expect(v2.services["opus::opencode"]?.harness).toBe("opencode");
    // All three carry the same canonical model.
    for (const id of ["opus::claude_code", "opus::cursor", "opus::opencode"]) {
      expect(v2.services[id]?.model).toBe("opus");
    }
  });

  it("emits both subscription and metered services for one model", () => {
    const v3: Config = {
      priority: ["opus"],
      models: {
        opus: {
          subscription: [{ harness: "claude_code" }, { harness: "cursor" }],
          metered: [
            { base_url: "https://api.anthropic.com/v1" },
            { base_url: "http://localhost:11434/v1" },
          ],
        },
      },
    };
    const v2 = toRouterConfig(v3);
    expect(Object.keys(v2.services).sort()).toEqual([
      "opus::api.anthropic.com",
      "opus::claude_code",
      "opus::cursor",
      "opus::localhost:11434",
    ]);
  });

  it("disambiguates duplicate route keys with #1, #2, …", () => {
    // Two metered routes with the same hostname (different paths) — rare,
    // but the adapter must produce unique service ids to avoid map collisions.
    const v3: Config = {
      priority: ["opus"],
      models: {
        opus: {
          metered: [{ base_url: "https://proxy.local/v1" }, { base_url: "https://proxy.local/v2" }],
        },
      },
    };
    const v2 = toRouterConfig(v3);
    expect(Object.keys(v2.services).sort()).toEqual(["opus::proxy.local", "opus::proxy.local#1"]);
  });
});

describe("toRouterConfig — generic_cli + cli_model_override", () => {
  it("propagates cli_model_override to ServiceConfig.cliModel", () => {
    const v3: Config = {
      priority: ["claude-opus-4-7"],
      models: {
        "claude-opus-4-7": {
          subscription: [
            {
              harness: "claude_code",
              command: "claude",
              cli_model_override: "opus",
            },
          ],
        },
      },
    };
    const v2 = toRouterConfig(v3);
    const id = "claude-opus-4-7::claude_code";
    expect(v2.services[id]?.cliModel).toBe("opus");
    expect(v2.services[id]?.model).toBe("claude-opus-4-7");
  });

  it("uses generic_cli type when generic_cli recipe is present", () => {
    const v3: Config = {
      priority: ["x"],
      models: {
        x: {
          subscription: [
            {
              harness: "x",
              command: "x-bin",
              generic_cli: { argsBeforePrompt: ["run"] },
            },
          ],
        },
      },
    };
    const v2 = toRouterConfig(v3);
    const id = "x::x";
    expect(v2.services[id]?.type).toBe("generic_cli");
    expect(v2.services[id]?.genericCli).toEqual({ argsBeforePrompt: ["run"] });
  });

  it("preserves modelPriority verbatim", () => {
    const v3: Config = {
      priority: ["opus", "gpt-5.4", "pro"],
      models: {
        opus: { subscription: [{ harness: "claude_code" }] },
        "gpt-5.4": { subscription: [{ harness: "cursor" }] },
        pro: {
          metered: [{ base_url: "https://generativelanguage.googleapis.com/v1beta/openai" }],
        },
      },
    };
    const v2 = toRouterConfig(v3);
    expect(v2.modelPriority).toEqual(["opus", "gpt-5.4", "pro"]);
  });
});

describe("toRouterConfig — mixture_default expansion", () => {
  it("expands a model-keyed mixture_default to ALL per-model service ids", () => {
    const v3: Config = {
      priority: ["opus", "gpt-5.4"],
      mixture_default: ["opus"],
      models: {
        opus: {
          subscription: [{ harness: "claude_code" }, { harness: "cursor" }],
          metered: [{ base_url: "https://api.anthropic.com/v1" }],
        },
        "gpt-5.4": { subscription: [{ harness: "codex" }] },
      },
    };
    const v2 = toRouterConfig(v3);
    // mixture_default: [opus] → all 3 opus service ids (2 subscription + 1 metered)
    expect([...(v2.mixtureDefault ?? [])].sort()).toEqual([
      "opus::api.anthropic.com",
      "opus::claude_code",
      "opus::cursor",
    ]);
  });

  it("only emits service ids that exist (skips models with no entry)", () => {
    const v3: Config = {
      priority: [],
      mixture_default: ["opus", "ghost"],
      models: {
        opus: { subscription: [{ harness: "claude_code" }] },
      },
    };
    const v2 = toRouterConfig(v3);
    expect(v2.mixtureDefault).toEqual(["opus::claude_code"]);
  });

  it("omits mixtureDefault when expansion produces zero ids", () => {
    const v3: Config = {
      priority: [],
      mixture_default: ["ghost"],
      models: { opus: { subscription: [{ harness: "claude_code" }] } },
    };
    const v2 = toRouterConfig(v3);
    expect(v2.mixtureDefault).toBeUndefined();
  });
});

describe("toRouterConfig — disabled propagation", () => {
  it("includes disabled routes in the disabled list AND marks svc.enabled false", () => {
    const v3: Config = {
      priority: ["opus"],
      models: {
        opus: {
          subscription: [{ harness: "claude_code", enabled: false }],
          metered: [{ base_url: "https://api.anthropic.com/v1" }],
        },
      },
    };
    const v2 = toRouterConfig(v3);
    expect(v2.services["opus::claude_code"]?.enabled).toBe(false);
    expect(v2.services["opus::api.anthropic.com"]?.enabled).toBe(true);
    expect(v2.disabled).toContain("opus::claude_code");
    expect(v2.disabled).not.toContain("opus::api.anthropic.com");
  });

  it("omits disabled list when no routes are disabled", () => {
    const v3: Config = {
      priority: ["opus"],
      models: {
        opus: { subscription: [{ harness: "claude_code" }] },
      },
    };
    const v2 = toRouterConfig(v3);
    expect(v2.disabled).toBeUndefined();
  });
});
