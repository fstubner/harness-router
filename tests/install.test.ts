/**
 * Unit tests for the install module.
 *
 * Each test isolates the host configs to a tmp dir via `targetsForEnv`. The
 * targets adapter writes to the tmp dir's mock layout, so we never touch the
 * host machine's real Claude Desktop / Cursor / Codex configs.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { defaultEntry, targetsForEnv, type McpServerEntry } from "../src/install/targets.js";

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "harness-router-install-"));
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

function tmpEnv(platform: NodeJS.Platform = "linux") {
  return targetsForEnv({
    homedir: tmp,
    appDataDir: path.join(tmp, "AppData", "Roaming"),
    platform,
  });
}

const ENTRY: McpServerEntry = {
  name: "harness-router",
  command: "npx",
  args: ["-y", "harness-router", "mcp"],
};

// ---------------------------------------------------------------------------
// JSON hosts (Claude Desktop, Cursor)
// ---------------------------------------------------------------------------

describe("install — JSON hosts (Claude Desktop, Cursor)", () => {
  for (const targetId of ["claude-desktop", "cursor"]) {
    describe(targetId, () => {
      it(`creates ${targetId} config from scratch when missing`, async () => {
        const target = tmpEnv().find((t) => t.id === targetId)!;
        const result = await target.install(ENTRY);
        expect(result.ok).toBe(true);
        expect(result.replaced).toBe(false);
        expect(result.alreadyPresent).toBeUndefined();

        const written = JSON.parse(await fs.readFile(target.configPath()!, "utf-8")) as {
          mcpServers: Record<string, unknown>;
        };
        expect(written.mcpServers["harness-router"]).toEqual({
          command: "npx",
          args: ["-y", "harness-router", "mcp"],
        });
      });

      it(`is idempotent — second install reports alreadyPresent`, async () => {
        const target = tmpEnv().find((t) => t.id === targetId)!;
        const first = await target.install(ENTRY);
        expect(first.ok).toBe(true);
        const second = await target.install(ENTRY);
        expect(second.ok).toBe(true);
        expect(second.alreadyPresent).toBe(true);
      });

      it(`preserves existing unrelated entries`, async () => {
        const target = tmpEnv().find((t) => t.id === targetId)!;
        await fs.mkdir(path.dirname(target.configPath()!), { recursive: true });
        const existing = {
          mcpServers: {
            github: { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] },
          },
          preferences: { theme: "dark" },
        };
        await fs.writeFile(target.configPath()!, JSON.stringify(existing, null, 2));

        await target.install(ENTRY);
        const after = JSON.parse(await fs.readFile(target.configPath()!, "utf-8")) as Record<
          string,
          unknown
        >;
        expect((after.mcpServers as Record<string, unknown>).github).toEqual(
          existing.mcpServers.github,
        );
        expect((after.mcpServers as Record<string, unknown>)["harness-router"]).toBeDefined();
        expect(after.preferences).toEqual({ theme: "dark" });
      });

      it(`uninstall removes only the harness-router entry`, async () => {
        const target = tmpEnv().find((t) => t.id === targetId)!;
        await target.install(ENTRY);
        // Add an unrelated entry too.
        const cfg = JSON.parse(await fs.readFile(target.configPath()!, "utf-8")) as Record<
          string,
          unknown
        >;
        (cfg.mcpServers as Record<string, unknown>).github = { command: "x" };
        await fs.writeFile(target.configPath()!, JSON.stringify(cfg, null, 2));

        const result = await target.uninstall("harness-router");
        expect(result.ok).toBe(true);
        expect(result.replaced).toBe(true);

        const after = JSON.parse(await fs.readFile(target.configPath()!, "utf-8")) as Record<
          string,
          unknown
        >;
        expect((after.mcpServers as Record<string, unknown>)["harness-router"]).toBeUndefined();
        expect((after.mcpServers as Record<string, unknown>).github).toBeDefined();
      });

      it(`uninstall is no-op when entry isn't present`, async () => {
        const target = tmpEnv().find((t) => t.id === targetId)!;
        const result = await target.uninstall("harness-router");
        expect(result.ok).toBe(true);
        expect(result.alreadyPresent).toBe(false);
      });

      it(`replaces an existing entry with new shape rather than merging`, async () => {
        const target = tmpEnv().find((t) => t.id === targetId)!;
        const old: McpServerEntry = {
          name: "harness-router",
          command: "node",
          args: ["/old/path/bin.js", "mcp"],
        };
        await target.install(old);
        const result = await target.install(ENTRY);
        expect(result.ok).toBe(true);
        expect(result.replaced).toBe(true);
        const after = JSON.parse(await fs.readFile(target.configPath()!, "utf-8")) as {
          mcpServers: Record<string, { command: string; args: string[] }>;
        };
        expect(after.mcpServers["harness-router"]!.command).toBe("npx");
      });
    });
  }
});

// ---------------------------------------------------------------------------
// TOML host (Codex)
// ---------------------------------------------------------------------------

describe("install — TOML host (Codex)", () => {
  it("creates codex config from scratch when missing", async () => {
    const target = tmpEnv().find((t) => t.id === "codex")!;
    const result = await target.install(ENTRY);
    expect(result.ok).toBe(true);
    const text = await fs.readFile(target.configPath()!, "utf-8");
    expect(text).toContain("mcp_servers");
    expect(text).toContain('command = "npx"');
    expect(text).toContain("harness-router");
  });

  it("preserves existing codex sections", async () => {
    const target = tmpEnv().find((t) => t.id === "codex")!;
    await fs.mkdir(path.dirname(target.configPath()!), { recursive: true });
    await fs.writeFile(
      target.configPath()!,
      [
        'model = "gpt-5.5"',
        'sandbox_mode = "workspace-write"',
        "",
        "[mcp_servers.context7]",
        'command = "npx"',
        'args = ["-y", "@upstash/context7-mcp@latest"]',
        "",
      ].join("\n"),
    );
    await target.install(ENTRY);
    const text = await fs.readFile(target.configPath()!, "utf-8");
    expect(text).toContain('model = "gpt-5.5"');
    expect(text).toContain("[mcp_servers.context7]");
    expect(text).toContain('"@upstash/context7-mcp@latest"');
    expect(text).toContain("[mcp_servers.harness-router]");
  });

  it("uninstall removes the harness-router section but keeps others", async () => {
    const target = tmpEnv().find((t) => t.id === "codex")!;
    await fs.mkdir(path.dirname(target.configPath()!), { recursive: true });
    await fs.writeFile(
      target.configPath()!,
      [
        "[mcp_servers.context7]",
        'command = "npx"',
        'args = ["-y", "@upstash/context7-mcp@latest"]',
        "",
      ].join("\n"),
    );
    await target.install(ENTRY);
    const result = await target.uninstall("harness-router");
    expect(result.ok).toBe(true);
    const text = await fs.readFile(target.configPath()!, "utf-8");
    expect(text).toContain("[mcp_servers.context7]");
    expect(text).not.toContain("harness-router");
  });
});

// ---------------------------------------------------------------------------
// Default entry
// ---------------------------------------------------------------------------

describe("install — defaultEntry", () => {
  it("returns a sensible npx command (v0.3 bare invocation = stdio MCP)", () => {
    const e = defaultEntry();
    expect(e.command).toBe("npx");
    expect(e.args).toContain("harness-router");
    // v0.3 dropped the `mcp` subcommand: bare `npx harness-router` IS the
    // stdio MCP server. The host config carries no extra subcommand arg.
    expect(e.args).not.toContain("mcp");
    expect(e.args).toEqual(["-y", "harness-router"]);
    expect(e.name).toBe("harness-router");
  });
});

// ---------------------------------------------------------------------------
// Snippet printer
// ---------------------------------------------------------------------------

describe("install — printSnippet (no file writes)", () => {
  it("Claude Desktop snippet is valid JSON", () => {
    const target = tmpEnv().find((t) => t.id === "claude-desktop")!;
    const snippet = target.printSnippet(ENTRY);
    // Strip the leading comment lines, parse the JSON tail.
    const jsonStart = snippet.indexOf("{");
    expect(jsonStart).toBeGreaterThan(0);
    const parsed = JSON.parse(snippet.slice(jsonStart)) as { mcpServers: Record<string, unknown> };
    expect(parsed.mcpServers["harness-router"]).toBeDefined();
  });

  it("Codex snippet has the right TOML section header", () => {
    const target = tmpEnv().find((t) => t.id === "codex")!;
    const snippet = target.printSnippet(ENTRY);
    expect(snippet).toContain("[mcp_servers.harness-router]");
    expect(snippet).toContain('command = "npx"');
  });
});
