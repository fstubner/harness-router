/**
 * Tests for the YAML → Config parser.
 *
 * Covers: shape validation, env-var interpolation, multi-route support
 * (single-object shorthand vs array form), cross-reference checks
 * (priority/mixture_default → models), HTTP auth force-on for non-loopback
 * bind.
 */

import { describe, expect, it } from "vitest";

import { parseConfigText } from "../../src/config/parser.js";
import { ConfigError } from "../../src/config/types.js";

describe("parser — happy path", () => {
  it("parses a minimal valid config (single subscription, shorthand)", () => {
    const yaml = `
priority: [opus]
models:
  opus:
    subscription:
      harness: claude_code
`;
    const cfg = parseConfigText(yaml);
    expect(cfg.priority).toEqual(["opus"]);
    expect(cfg.models.opus?.subscription).toHaveLength(1);
    expect(cfg.models.opus?.subscription?.[0]?.harness).toBe("claude_code");
    expect(cfg.models.opus?.metered).toBeUndefined();
  });

  it("parses array form for multi-harness subscription", () => {
    const yaml = `
priority: [opus]
models:
  opus:
    subscription:
      - harness: claude_code
      - harness: cursor
      - harness: opencode
`;
    const cfg = parseConfigText(yaml);
    expect(cfg.models.opus?.subscription).toHaveLength(3);
    expect(cfg.models.opus?.subscription?.map((r) => r.harness)).toEqual([
      "claude_code",
      "cursor",
      "opencode",
    ]);
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
    const cfg = parseConfigText(yaml, (n) => (n === "ANTHROPIC_API_KEY" ? "sk-test" : undefined));
    expect(cfg.models.opus?.subscription?.[0]?.harness).toBe("claude_code");
    expect(cfg.models.opus?.metered?.[0]?.api_key).toBe("sk-test");
    expect(cfg.models.opus?.metered?.[0]?.base_url).toBe("https://api.anthropic.com/v1");
  });

  it("parses multi-route metered (e.g. Anthropic API + local proxy)", () => {
    const yaml = `
priority: [opus]
models:
  opus:
    metered:
      - base_url: https://api.anthropic.com/v1
        api_key: \${ANTHROPIC_API_KEY}
      - base_url: http://localhost:11434/v1
        api_key: ollama
`;
    const cfg = parseConfigText(yaml, () => "x");
    expect(cfg.models.opus?.metered).toHaveLength(2);
    expect(cfg.models.opus?.metered?.[0]?.base_url).toMatch(/anthropic/);
    expect(cfg.models.opus?.metered?.[1]?.base_url).toMatch(/localhost/);
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
    const cfg = parseConfigText(yaml, (n) => ({ MY_URL: "http://x", MY_KEY: "k" })[n]);
    expect(cfg.models.m?.metered?.[0]?.base_url).toBe("http://x");
    expect(cfg.models.m?.metered?.[0]?.api_key).toBe("k");
  });

  it("leaves unresolved ${VAR} as literal", () => {
    const yaml = `
priority: [m]
models:
  m:
    metered:
      base_url: \${MISSING}
`;
    const cfg = parseConfigText(yaml, () => undefined);
    expect(cfg.models.m?.metered?.[0]?.base_url).toBe("${MISSING}");
  });

  it("freezes the returned config (catches accidental mutation)", () => {
    const cfg = parseConfigText(`
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
    expect(() => parseConfigText("priority: []\n")).toThrow(/models field missing/);
  });

  it("rejects a model with neither subscription nor metered", () => {
    const yaml = `
priority: []
models:
  empty: {}
`;
    expect(() => parseConfigText(yaml)).toThrow(/at least one of subscription, metered/);
  });

  it("rejects a subscription route without a harness", () => {
    const yaml = `
priority: []
models:
  m:
    subscription: {}
`;
    expect(() => parseConfigText(yaml)).toThrow(/harness/);
  });

  it("rejects a metered route without a base_url", () => {
    const yaml = `
priority: []
models:
  m:
    metered: {}
`;
    expect(() => parseConfigText(yaml)).toThrow(/base_url/);
  });

  it("rejects priority entries that don't reference a model", () => {
    const yaml = `
priority: [opus, missing]
models:
  opus:
    subscription:
      harness: claude_code
`;
    expect(() => parseConfigText(yaml)).toThrow(/"missing"/);
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
    expect(() => parseConfigText(yaml)).toThrow(/"ghost"/);
  });

  it("rejects bare-non-array subscription (e.g. a string)", () => {
    const yaml = `
priority: []
models:
  m:
    subscription: "not-an-object"
`;
    expect(() => parseConfigText(yaml)).toThrow(/object or an array/);
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
      parseConfigText(yaml);
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      const issues = (err as ConfigError).issues;
      expect(issues.length).toBeGreaterThanOrEqual(4);
    }
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
    const cfg = parseConfigText(yaml);
    expect(cfg.http?.port).toBe(9000);
  });

  it("forces auth.required when bind is non-loopback", () => {
    const yaml = `
priority: [opus]
models:
  opus:
    subscription: { harness: claude_code }
http:
  bind: 0.0.0.0
  port: 9000
  auth:
    required: false
`;
    const cfg = parseConfigText(yaml);
    expect(cfg.http?.auth?.required).toBe(true);
  });

  it("respects auth.required: false when bind is loopback", () => {
    const yaml = `
priority: [opus]
models:
  opus:
    subscription: { harness: claude_code }
http:
  bind: 127.0.0.1
  auth:
    required: false
`;
    const cfg = parseConfigText(yaml);
    expect(cfg.http?.auth?.required).toBe(false);
  });

  it("rejects a non-integer port", () => {
    const yaml = `
priority: [opus]
models:
  opus:
    subscription: { harness: claude_code }
http:
  port: not-a-number
`;
    expect(() => parseConfigText(yaml)).toThrow(/port/);
  });
});
