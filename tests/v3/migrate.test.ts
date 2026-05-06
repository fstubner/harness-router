/**
 * Tests for the v0.2 → v0.3 migrator.
 *
 * The migrator is a pure function over RouterConfig (the v0.2 shape) →
 * V3Config + warnings. We construct v0.2 configs in memory rather than
 * reading from YAML to keep the test focused on the transform.
 */

import { describe, expect, it } from "vitest";

import { migrateV2ToV3, renderV3Yaml } from "../../src/v3/migrate.js";
import { parseV3Text } from "../../src/v3/loader.js";
import type { RouterConfig, ServiceConfig } from "../../src/types.js";

function svc(over: Partial<ServiceConfig> & { name: string }): ServiceConfig {
  return {
    enabled: true,
    type: "cli",
    tier: "subscription",
    ...over,
  };
}

describe("migrateV2ToV3", () => {
  it("translates a single subscription service to a model-keyed entry", () => {
    const v2: RouterConfig = {
      services: {
        claude_code: svc({
          name: "claude_code",
          harness: "claude_code",
          command: "claude",
          model: "opus",
        }),
      },
      modelPriority: ["opus"],
    };
    const { config, warnings } = migrateV2ToV3(v2);
    expect(warnings).toEqual([]);
    expect(config.priority).toEqual(["opus"]);
    expect(config.models.opus?.subscription?.harness).toBe("claude_code");
    expect(config.models.opus?.subscription?.command).toBe("claude");
    expect(config.models.opus?.metered).toBeUndefined();
  });

  it("translates subscription + metered for one model into a single entry", () => {
    const v2: RouterConfig = {
      services: {
        claude_code: svc({
          name: "claude_code",
          harness: "claude_code",
          command: "claude",
          model: "opus",
        }),
        anthropic_api_opus: svc({
          name: "anthropic_api_opus",
          type: "openai_compatible",
          baseUrl: "https://api.anthropic.com/v1",
          apiKey: "${ANTHROPIC_API_KEY}",
          model: "opus",
          tier: "metered",
        }),
      },
      modelPriority: ["opus"],
    };
    const { config } = migrateV2ToV3(v2);
    expect(config.models.opus?.subscription?.harness).toBe("claude_code");
    expect(config.models.opus?.metered?.base_url).toBe("https://api.anthropic.com/v1");
    expect(config.models.opus?.metered?.api_key).toBe("${ANTHROPIC_API_KEY}");
  });

  it("emits a warning for services with no model field and drops them", () => {
    const v2: RouterConfig = {
      services: {
        orphan: svc({ name: "orphan", harness: "claude_code", command: "claude" }),
      },
      modelPriority: [],
    };
    const { config, warnings } = migrateV2ToV3(v2);
    expect(Object.keys(config.models)).toEqual([]);
    expect(warnings.some((w) => /no model field/.test(w))).toBe(true);
  });

  it("emits a warning when two services serve the same (model, tier) — keeps first", () => {
    const v2: RouterConfig = {
      services: {
        claude_code: svc({
          name: "claude_code",
          harness: "claude_code",
          command: "claude",
          model: "opus",
        }),
        claude_code_alt: svc({
          name: "claude_code_alt",
          harness: "claude_code",
          command: "claude2",
          model: "opus",
        }),
      },
      modelPriority: ["opus"],
    };
    const { config, warnings } = migrateV2ToV3(v2);
    expect(config.models.opus?.subscription?.command).toBe("claude");
    expect(warnings.some((w) => /both serve subscription/.test(w))).toBe(true);
  });

  it("translates mixture_default from service-names to model-names + dedupes", () => {
    const v2: RouterConfig = {
      services: {
        claude_code: svc({
          name: "claude_code",
          harness: "claude_code",
          command: "claude",
          model: "opus",
        }),
        anthropic_api_opus: svc({
          name: "anthropic_api_opus",
          type: "openai_compatible",
          baseUrl: "https://api.anthropic.com/v1",
          model: "opus",
          tier: "metered",
        }),
        cursor: svc({
          name: "cursor",
          harness: "cursor",
          command: "agent",
          model: "gpt-5.4",
        }),
      },
      modelPriority: ["opus", "gpt-5.4"],
      // Both `claude_code` and `anthropic_api_opus` map to model "opus" — dedupe expected.
      mixtureDefault: ["claude_code", "anthropic_api_opus", "cursor"],
    };
    const { config } = migrateV2ToV3(v2);
    expect(config.mixture_default).toEqual(["opus", "gpt-5.4"]);
  });

  it("only emits cli_model_override when the v0.2 cli_model differed from the canonical", () => {
    const v2: RouterConfig = {
      services: {
        a: svc({
          name: "a",
          harness: "claude_code",
          command: "claude",
          model: "opus",
          cliModel: "opus",
        }),
        b: svc({
          name: "b",
          harness: "claude_code",
          command: "claude",
          model: "claude-opus-4-7",
          cliModel: "opus", // canonical pinned, CLI accepts alias — override needed
        }),
      },
      modelPriority: [],
    };
    const { config } = migrateV2ToV3(v2);
    // cliModel === model → omitted
    expect(config.models.opus?.subscription?.cli_model_override).toBeUndefined();
    // cliModel !== model → preserved
    expect(config.models["claude-opus-4-7"]?.subscription?.cli_model_override).toBe("opus");
  });

  it("propagates the disabled list as per-route enabled: false", () => {
    const v2: RouterConfig = {
      services: {
        a: svc({ name: "a", harness: "claude_code", command: "claude", model: "opus" }),
      },
      modelPriority: [],
      disabled: ["a"],
    };
    const { config } = migrateV2ToV3(v2);
    expect(config.models.opus?.subscription?.enabled).toBe(false);
  });

  it("warns when priority references a model that didn't survive migration", () => {
    const v2: RouterConfig = {
      services: {},
      modelPriority: ["opus", "gpt-5.4"],
    };
    const { config, warnings } = migrateV2ToV3(v2);
    expect(config.priority).toEqual([]);
    expect(warnings.length).toBe(2);
    expect(warnings.every((w) => /no matching model/.test(w))).toBe(true);
  });

  it("round-trips through renderV3Yaml + parseV3Text without loss", () => {
    const v2: RouterConfig = {
      services: {
        claude_code: svc({
          name: "claude_code",
          harness: "claude_code",
          command: "claude",
          model: "opus",
        }),
        anthropic_api_opus: svc({
          name: "anthropic_api_opus",
          type: "openai_compatible",
          baseUrl: "https://api.anthropic.com/v1",
          apiKey: "${ANTHROPIC_API_KEY}",
          model: "opus",
          tier: "metered",
        }),
      },
      modelPriority: ["opus"],
      mixtureDefault: ["claude_code"],
    };
    const { config } = migrateV2ToV3(v2);
    const yaml = renderV3Yaml(config);
    const reparsed = parseV3Text(yaml, () => "literal-passthrough");
    expect(reparsed.priority).toEqual(["opus"]);
    expect(reparsed.models.opus?.subscription?.harness).toBe("claude_code");
    expect(reparsed.models.opus?.metered?.base_url).toBe("https://api.anthropic.com/v1");
    expect(reparsed.mixture_default).toEqual(["opus"]);
  });
});

describe("renderV3Yaml", () => {
  it("emits a clean ordered structure with priority before models", () => {
    const yaml = renderV3Yaml({
      priority: ["opus"],
      models: { opus: { subscription: { harness: "claude_code" } } },
    });
    const priorityIdx = yaml.indexOf("priority:");
    const modelsIdx = yaml.indexOf("models:");
    expect(priorityIdx).toBeGreaterThanOrEqual(0);
    expect(modelsIdx).toBeGreaterThan(priorityIdx);
  });

  it("omits mixture_default when absent", () => {
    const yaml = renderV3Yaml({
      priority: ["opus"],
      models: { opus: { subscription: { harness: "claude_code" } } },
    });
    expect(yaml).not.toContain("mixture_default");
  });

  it("never embeds raw env values — placeholder syntax preserved", () => {
    const yaml = renderV3Yaml({
      priority: ["opus"],
      models: {
        opus: {
          metered: {
            base_url: "https://api.anthropic.com/v1",
            api_key: "${ANTHROPIC_API_KEY}",
          },
        },
      },
    });
    expect(yaml).toContain("${ANTHROPIC_API_KEY}");
  });
});
