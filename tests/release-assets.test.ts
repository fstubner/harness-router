import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { parseConfigText, toRouterConfig } from "../src/config/index.js";

const root = process.cwd();

describe("release assets", () => {
  it("keeps package-lock identity aligned with package.json", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      name: string;
      version: string;
    };
    const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8")) as {
      name: string;
      version: string;
      packages: Record<string, { name?: string; version?: string }>;
    };

    expect(lock.name).toBe(pkg.name);
    expect(lock.version).toBe(pkg.version);
    expect(lock.packages[""]?.name).toBe(pkg.name);
    expect(lock.packages[""]?.version).toBe(pkg.version);
  });

  it("keeps config.example.yaml parseable by the v0.3 schema", () => {
    const yaml = readFileSync(join(root, "config.example.yaml"), "utf8");
    const parsed = parseConfigText(yaml, (name) => `env:${name}`);
    const runtime = toRouterConfig(parsed);

    expect(parsed.priority).toContain("claude-opus-4-7");
    expect(parsed.models["claude-opus-4-7"]?.subscription).toHaveLength(2);
    expect(runtime.services["claude-opus-4-7::claude_code"]?.model).toBe("claude-opus-4-7");
    expect(runtime.services["gpt-5.4::api.openai.com"]?.tier).toBe("metered");
  });
});
