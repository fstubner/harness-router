/**
 * Tests for the `harness-router migrate` CLI command.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";

import { cmdMigrate } from "../../src/cli/migrate.js";

let tmp: string;

class StringSink extends Writable {
  text = "";
  override _write(chunk: Buffer | string, _enc: BufferEncoding, cb: () => void): void {
    this.text += typeof chunk === "string" ? chunk : chunk.toString("utf-8");
    cb();
  }
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "harness-router-migrate-test-"));
});

afterEach(() => {
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    // Best-effort.
  }
});

function legacyYaml(): string {
  return [
    "model_priority:",
    "  - opus",
    "  - gpt-5.4",
    "services:",
    "  claude_code:",
    "    enabled: true",
    "    type: cli",
    "    harness: claude_code",
    "    command: claude",
    "    model: opus",
    "    tier: subscription",
    "  anthropic_api_opus:",
    "    enabled: true",
    "    type: openai_compatible",
    "    base_url: https://api.anthropic.com/v1",
    "    api_key: ${ANTHROPIC_API_KEY}",
    "    model: opus",
    "    tier: metered",
    "mixture_default:",
    "  - claude_code",
    "  - anthropic_api_opus",
    "",
  ].join("\n");
}

describe("cmdMigrate", () => {
  it("translates a v0.2 file in place and writes a .v2.bak backup", async () => {
    const cfg = join(tmp, "config.yaml");
    writeFileSync(cfg, legacyYaml(), "utf-8");
    const out = new StringSink();
    const err = new StringSink();

    const code = await cmdMigrate({ configPath: cfg, out, err });
    expect(code).toBe(0);

    // Backup written.
    const backup = readFileSync(`${cfg}.v2.bak`, "utf-8");
    expect(backup).toBe(legacyYaml());

    // Main file replaced with v0.3 shape.
    const v3 = readFileSync(cfg, "utf-8");
    expect(v3).toContain("priority:");
    expect(v3).toContain("models:");
    expect(v3).toContain("opus:");
    expect(v3).toContain("claude_code");
    expect(v3).toContain("https://api.anthropic.com/v1");
    expect(v3).toContain("${ANTHROPIC_API_KEY}");
    // mixture_default flipped from service-names to model-names + deduped.
    expect(v3).toMatch(/mixture_default:\s*\n\s+- opus/);
    expect(v3).not.toContain("mixture_default:\n  - claude_code");
  });

  it("skips the backup when --no-backup is set", async () => {
    const cfg = join(tmp, "config.yaml");
    writeFileSync(cfg, legacyYaml(), "utf-8");
    const out = new StringSink();
    const err = new StringSink();

    const code = await cmdMigrate({ configPath: cfg, noBackup: true, out, err });
    expect(code).toBe(0);
    expect(() => readFileSync(`${cfg}.v2.bak`, "utf-8")).toThrow();
  });

  it("is idempotent on a v0.3 file (no write, exit 0)", async () => {
    const cfg = join(tmp, "config.yaml");
    const v3Yaml = [
      "priority:",
      "  - opus",
      "models:",
      "  opus:",
      "    subscription:",
      "      harness: claude_code",
      "",
    ].join("\n");
    writeFileSync(cfg, v3Yaml, "utf-8");
    const out = new StringSink();
    const err = new StringSink();

    const code = await cmdMigrate({ configPath: cfg, out, err });
    expect(code).toBe(0);
    expect(out.text).toMatch(/already in v0\.3/);
    // File unchanged (no surprise edits).
    expect(readFileSync(cfg, "utf-8")).toBe(v3Yaml);
    // No backup written.
    expect(() => readFileSync(`${cfg}.v2.bak`, "utf-8")).toThrow();
  });

  it("returns 1 when the file doesn't exist, with a directive to onboard", async () => {
    const out = new StringSink();
    const err = new StringSink();
    const code = await cmdMigrate({
      configPath: join(tmp, "missing.yaml"),
      out,
      err,
    });
    expect(code).toBe(1);
    expect(err.text).toMatch(/onboard|--config/i);
  });

  it("surfaces migration warnings to stderr (e.g. dropped services)", async () => {
    const cfg = join(tmp, "config.yaml");
    // A service with no model field — migrator drops it and warns.
    writeFileSync(
      cfg,
      [
        "services:",
        "  orphan:",
        "    enabled: true",
        "    type: cli",
        "    harness: claude_code",
        "    command: claude",
        "    tier: subscription",
        "model_priority: []",
        "",
      ].join("\n"),
      "utf-8",
    );
    const out = new StringSink();
    const err = new StringSink();
    const code = await cmdMigrate({ configPath: cfg, noBackup: true, out, err });
    expect(code).toBe(0);
    expect(err.text).toMatch(/no model field/i);
  });
});
