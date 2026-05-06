/**
 * Tests for the v0.3 config loader.
 *
 * Covers: shape validation, env-var interpolation, legacy detection,
 * cross-reference checks (priority/mixture_default → models), HTTP auth
 * force-on for non-loopback bind.
 */

import { describe, expect, it } from "vitest";

import { LegacyConfigError, parseV3Text } from "../../src/v3/loader.js";
import { V3ConfigError } from "../../src/v3/types.js";

describe("v0.3 loader — happy path", () => {
  it("parses a minimal valid config", () => {
    const yaml = `
priority: [opus]
models:
  opus:
    subscription:
      harness: claude_code
`;
    const cfg = parseV3Text(yaml);
    expect(cfg.priority).toEqual(["opus"]);
    expect(cfg.models.opus?.subscription?.harness).toBe("claude_code");
    expect(cfg.models.opus?.metered).toBeUndefined();
  });

  it("parses both subscription and metered routes for one model", () => {
    const yaml = `
priority: [opus]
models:
  opus:
    subscription:
      harness: claude_code
    metered:
      base_url: https://api.anthropic.com/v1
      api_key: \${ANTHROPIC_API_KEY}
`;
    const cfg = parseV3Text(yaml, (n) => (n === "ANTHROPIC_API_KEY" ? "sk-test" : undefined));
    expect(cfg.models.opus?.subscription?.harness).toBe("claude_code");
    expect(cfg.models.opus?.metered?.api_key).toBe("sk-test");
    expect(cfg.models.opus?.metered?.base_url).toBe("https://api.anthropic.com/v1");
  });

  it("interpolates ${VAR} references in strings", () => {
    const yaml = `
priority: [m]
models:
  m:
    metered:
      base_url: \${MY_URL}
      api_key: \${MY_KEY}
`;
    const cfg = parseV3Text(yaml, (n) => ({ MY_URL: "http://x", MY_KEY: "k" })[n]);
    expect(cfg.models.m?.metered?.base_url).toBe("http://x");
    expect(cfg.models.m?.metered?.api_key).toBe("k");
  });

  it("leaves unresolved ${VAR} as literal", () => {
    const yaml = `
priority: [m]
models:
  m:
    metered:
      base_url: \${MISSING}
`;
    const cfg = parseV3Text(yaml, () => undefined);
    expect(cfg.models.m?.metered?.base_url).toBe("${MISSING}");
  });

  it("freezes the returned config (catches accidental mutation)", () => {
    const cfg = parseV3Text(`
priority: [opus]
models:
  opus:
    subscription:
      harness: claude_code
`);
    expect(Object.isFrozen(cfg)).toBe(true);
  });
});

describe("v0.3 loader — validation", () => {
  it("rejects a config with no models field", () => {
    expect(() => parseV3Text("priority: []\n")).toThrow(/models field missing/);
  });

  it("rejects a model with neither subscription nor metered", () => {
    const yaml = `
priority: []
models:
  empty: {}
`;
    expect(() => parseV3Text(yaml)).toThrow(/at least one of subscription, metered/);
  });

  it("rejects a subscription route without a harness", () => {
    const yaml = `
priority: []
models:
  m:
    subscription: {}
`;
    expect(() => parseV3Text(yaml)).toThrow(/harness/);
  });

  it("rejects a metered route without a base_url", () => {
    const yaml = `
priority: []
models:
  m:
    metered: {}
`;
    expect(() => parseV3Text(yaml)).toThrow(/base_url/);
  });

  it("rejects priority entries that don't reference a model", () => {
    const yaml = `
priority: [opus, missing]
models:
  opus:
    subscription:
      harness: claude_code
`;
    expect(() => parseV3Text(yaml)).toThrow(/"missing"/);
  });

  it("rejects mixture_default entries that don't reference a model", () => {
    const yaml = `
priority: [opus]
mixture_default: [opus, ghost]
models:
  opus:
    subscription:
      harness: claude_code
`;
    expect(() => parseV3Text(yaml)).toThrow(/"ghost"/);
  });

  it("collects multiple issues and reports them all in one throw", () => {
    const yaml = `
priority: [missing1, missing2]
models:
  empty: {}
  bad-sub:
    subscription: {}
`;
    try {
      parseV3Text(yaml);
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(V3ConfigError);
      const issues = (err as V3ConfigError).issues;
      // priority[0], priority[1], models.empty, models.bad-sub.subscription.harness — at least 4
      expect(issues.length).toBeGreaterThanOrEqual(4);
    }
  });
});

describe("v0.3 loader — legacy detection", () => {
  it("throws LegacyConfigError when a top-level services: key is present without models:", () => {
    const yaml = `
services:
  claude_code:
    type: cli
    model: opus
`;
    expect(() => parseV3Text(yaml)).toThrow(LegacyConfigError);
    expect(() => parseV3Text(yaml)).toThrow(/migrate/i);
  });

  it("throws LegacyConfigError when overrides: is present without models:", () => {
    expect(() => parseV3Text("overrides: {}\n")).toThrow(LegacyConfigError);
  });

  it("throws LegacyConfigError when endpoints: is present without models:", () => {
    expect(() => parseV3Text("endpoints: []\n")).toThrow(LegacyConfigError);
  });

  it("does NOT throw legacy when models: is present alongside legacy keys (mixed config tolerated)", () => {
    const yaml = `
priority: [opus]
services: {}
models:
  opus:
    subscription:
      harness: claude_code
`;
    expect(() => parseV3Text(yaml)).not.toThrow();
  });
});

describe("v0.3 loader — http config", () => {
  it("loads a minimal http block", () => {
    const yaml = `
priority: []
models: {}
http:
  port: 9000
`;
    const cfg = parseV3Text(yaml);
    expect(cfg.http?.port).toBe(9000);
  });

  it("forces auth.required when bind is non-loopback", () => {
    const yaml = `
priority: []
models: {}
http:
  bind: 0.0.0.0
  port: 9000
  auth:
    required: false  # user tries to disable; loader overrides
`;
    const cfg = parseV3Text(yaml);
    expect(cfg.http?.auth?.required).toBe(true);
  });

  it("respects auth.required: false when bind is loopback", () => {
    const yaml = `
priority: []
models: {}
http:
  bind: 127.0.0.1
  auth:
    required: false
`;
    const cfg = parseV3Text(yaml);
    expect(cfg.http?.auth?.required).toBe(false);
  });

  it("rejects a non-integer port", () => {
    const yaml = `
priority: []
models: {}
http:
  port: not-a-number
`;
    expect(() => parseV3Text(yaml)).toThrow(/port/);
  });
});
