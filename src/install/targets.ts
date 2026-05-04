/**
 * MCP-host install targets — write `harness-router-mcp` into each MCP-aware
 * host's user-scoped config so the host picks it up on next launch.
 *
 * Per-host adapter implements:
 *   - `configPath()` — resolve the host's config file path (env-var aware).
 *     Returns `null` when the host clearly isn't installed on this machine.
 *   - `install(entry)` — read existing config, merge our entry into the
 *     mcp_servers / mcpServers namespace, write back. Idempotent.
 *   - `uninstall()` — remove our entry, leave the rest untouched.
 *   - `printSnippet(entry)` — emit a copy-pasteable block when the user
 *     wants to install manually rather than having us write the file.
 *
 * Scope distinction vs xtctx: we target *user-scoped* host configs (e.g.
 * `~/.cursor/mcp.json`, `%APPDATA%/Claude/claude_desktop_config.json`) —
 * once per machine, applies everywhere. xtctx targets *project-scoped*
 * configs (`<project>/.mcp.json`, `<project>/.cursor/mcp.json`) — different
 * file, different lifecycle, no overlap.
 */

import { promises as fs, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { parse as parseToml, stringify as stringifyToml } from "smol-toml";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The MCP server entry we want each host to launch. */
export interface McpServerEntry {
  /** Server name as it'll appear in the host's mcp_servers namespace. */
  name: string;
  /** Executable, e.g. `npx` or `node` or absolute path. */
  command: string;
  /** Argv passed to the executable. */
  args: string[];
  /** Optional env vars to inject at server start. */
  env?: Record<string, string>;
}

export interface InstallResult {
  ok: boolean;
  /** Resolved config path (if known, even on failure). */
  path?: string;
  /** Already present + identical — no write happened. */
  alreadyPresent?: boolean;
  /** Already present but with different content — replaced. */
  replaced?: boolean;
  error?: string;
}

export interface InstallTarget {
  /** Stable id used in the CLI flag (`--target=claude-desktop`). */
  id: string;
  /** Human-readable name for log lines. */
  displayName: string;
  /** Resolve the host's config path. Returns `null` when host isn't installed. */
  configPath(): string | null;
  /** Install (idempotent). */
  install(entry: McpServerEntry): Promise<InstallResult>;
  /** Remove our entry. Leaves other entries alone. */
  uninstall(name: string): Promise<InstallResult>;
  /** Render a copy-pasteable snippet for manual installation. */
  printSnippet(entry: McpServerEntry): string;
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function homedir(): string {
  return os.homedir();
}

/**
 * Resolve `%APPDATA%` (Windows) or fall back to `~/Library/Application Support`
 * (macOS) / `~/.config` (Linux). Used by Claude Desktop, whose config lives in
 * a different per-OS location.
 */
function appDataDir(appFolder: string): string {
  if (process.platform === "win32") {
    const appData = process.env.APPDATA;
    if (appData) return path.join(appData, appFolder);
    return path.join(homedir(), "AppData", "Roaming", appFolder);
  }
  if (process.platform === "darwin") {
    return path.join(homedir(), "Library", "Application Support", appFolder);
  }
  // linux + others
  return path.join(homedir(), ".config", appFolder);
}

function fileExists(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function dirExists(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// JSON helpers (Claude Desktop, Cursor)
// ---------------------------------------------------------------------------

async function readJsonOrEmpty(p: string): Promise<Record<string, unknown>> {
  try {
    const text = await fs.readFile(p, "utf-8");
    if (!text.trim()) return {};
    const parsed: unknown = JSON.parse(text);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") return {};
    throw err;
  }
}

async function writeJsonAtomically(p: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2) + "\n", "utf-8");
  await fs.rename(tmp, p);
}

function entryToJsonObject(entry: McpServerEntry): Record<string, unknown> {
  const out: Record<string, unknown> = {
    command: entry.command,
    args: entry.args,
  };
  if (entry.env && Object.keys(entry.env).length > 0) out.env = entry.env;
  return out;
}

function jsonEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Shared JSON-merger for hosts whose MCP entries live under `mcpServers`
 * (Claude Desktop, Cursor). Read → set → write atomically. Preserves all
 * other top-level keys verbatim.
 */
async function jsonInstall(p: string, entry: McpServerEntry): Promise<InstallResult> {
  const cfg = await readJsonOrEmpty(p);
  const servers = (cfg.mcpServers as Record<string, unknown>) ?? {};
  const desired = entryToJsonObject(entry);
  const existing = servers[entry.name];
  if (existing && jsonEqual(existing, desired)) {
    return { ok: true, path: p, alreadyPresent: true };
  }
  servers[entry.name] = desired;
  cfg.mcpServers = servers;
  await writeJsonAtomically(p, cfg);
  return { ok: true, path: p, replaced: existing !== undefined };
}

async function jsonUninstall(p: string, name: string): Promise<InstallResult> {
  let cfg: Record<string, unknown>;
  try {
    cfg = await readJsonOrEmpty(p);
  } catch (err) {
    return { ok: false, path: p, error: (err as Error).message };
  }
  const servers = cfg.mcpServers as Record<string, unknown> | undefined;
  if (!servers || !(name in servers)) {
    return { ok: true, path: p, alreadyPresent: false };
  }
  delete servers[name];
  cfg.mcpServers = servers;
  await writeJsonAtomically(p, cfg);
  return { ok: true, path: p, replaced: true };
}

// ---------------------------------------------------------------------------
// TOML helpers (Codex CLI / Desktop share `~/.codex/config.toml`)
// ---------------------------------------------------------------------------

async function readTomlOrEmpty(p: string): Promise<Record<string, unknown>> {
  try {
    const text = await fs.readFile(p, "utf-8");
    if (!text.trim()) return {};
    return parseToml(text);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") return {};
    throw err;
  }
}

async function writeTomlAtomically(p: string, value: Record<string, unknown>): Promise<void> {
  await fs.mkdir(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  // Cast through unknown — smol-toml's StringifyableTable type is wider than
  // our intent, but a freshly-built Record<string, unknown> tree is safe.
  await fs.writeFile(tmp, stringifyToml(value as Parameters<typeof stringifyToml>[0]), "utf-8");
  await fs.rename(tmp, p);
}

function entryToTomlObject(entry: McpServerEntry): Record<string, unknown> {
  const out: Record<string, unknown> = {
    command: entry.command,
    args: entry.args,
  };
  if (entry.env && Object.keys(entry.env).length > 0) out.env = entry.env;
  return out;
}

async function tomlInstall(p: string, entry: McpServerEntry): Promise<InstallResult> {
  const cfg = await readTomlOrEmpty(p);
  const servers = (cfg.mcp_servers as Record<string, unknown>) ?? {};
  const desired = entryToTomlObject(entry);
  const existing = servers[entry.name];
  if (existing && jsonEqual(existing, desired)) {
    return { ok: true, path: p, alreadyPresent: true };
  }
  servers[entry.name] = desired;
  cfg.mcp_servers = servers;
  await writeTomlAtomically(p, cfg);
  return { ok: true, path: p, replaced: existing !== undefined };
}

async function tomlUninstall(p: string, name: string): Promise<InstallResult> {
  let cfg: Record<string, unknown>;
  try {
    cfg = await readTomlOrEmpty(p);
  } catch (err) {
    return { ok: false, path: p, error: (err as Error).message };
  }
  const servers = cfg.mcp_servers as Record<string, unknown> | undefined;
  if (!servers || !(name in servers)) {
    return { ok: true, path: p, alreadyPresent: false };
  }
  delete servers[name];
  cfg.mcp_servers = servers;
  await writeTomlAtomically(p, cfg);
  return { ok: true, path: p, replaced: true };
}

// ---------------------------------------------------------------------------
// Per-host adapters
// ---------------------------------------------------------------------------

const claudeDesktopTarget: InstallTarget = {
  id: "claude-desktop",
  displayName: "Claude Desktop",
  configPath() {
    const dir = appDataDir("Claude");
    if (!dirExists(dir)) return null;
    return path.join(dir, "claude_desktop_config.json");
  },
  async install(entry) {
    const p = this.configPath();
    if (!p) return { ok: false, error: "Claude Desktop is not installed (no app data dir found)" };
    return jsonInstall(p, entry);
  },
  async uninstall(name) {
    const p = this.configPath();
    if (!p) return { ok: true, alreadyPresent: false };
    return jsonUninstall(p, name);
  },
  printSnippet(entry) {
    return [
      "// Add to ~/Library/Application Support/Claude/claude_desktop_config.json",
      "// (macOS) or %APPDATA%\\Claude\\claude_desktop_config.json (Windows)",
      "// — under the mcpServers key:",
      JSON.stringify({ mcpServers: { [entry.name]: entryToJsonObject(entry) } }, null, 2),
    ].join("\n");
  },
};

const cursorTarget: InstallTarget = {
  id: "cursor",
  displayName: "Cursor IDE (user-scoped MCP)",
  configPath() {
    const dir = path.join(homedir(), ".cursor");
    if (!dirExists(dir)) return null;
    return path.join(dir, "mcp.json");
  },
  async install(entry) {
    const p = this.configPath();
    if (!p) return { ok: false, error: "Cursor is not installed (no ~/.cursor dir found)" };
    return jsonInstall(p, entry);
  },
  async uninstall(name) {
    const p = this.configPath();
    if (!p) return { ok: true, alreadyPresent: false };
    return jsonUninstall(p, name);
  },
  printSnippet(entry) {
    return [
      "// Add to ~/.cursor/mcp.json — under the mcpServers key:",
      JSON.stringify({ mcpServers: { [entry.name]: entryToJsonObject(entry) } }, null, 2),
    ].join("\n");
  },
};

const codexTarget: InstallTarget = {
  id: "codex",
  displayName: "Codex CLI / Desktop",
  configPath() {
    const dir = path.join(homedir(), ".codex");
    if (!dirExists(dir)) return null;
    return path.join(dir, "config.toml");
  },
  async install(entry) {
    const p = this.configPath();
    if (!p) return { ok: false, error: "Codex is not installed (no ~/.codex dir found)" };
    return tomlInstall(p, entry);
  },
  async uninstall(name) {
    const p = this.configPath();
    if (!p) return { ok: true, alreadyPresent: false };
    return tomlUninstall(p, name);
  },
  printSnippet(entry) {
    const argsLiteral = JSON.stringify(entry.args);
    const lines = [
      "# Add to ~/.codex/config.toml:",
      `[mcp_servers.${entry.name}]`,
      `command = ${JSON.stringify(entry.command)}`,
      `args = ${argsLiteral}`,
    ];
    if (entry.env && Object.keys(entry.env).length > 0) {
      lines.push(`env = ${JSON.stringify(entry.env)}`);
    }
    return lines.join("\n");
  },
};

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export const INSTALL_TARGETS: readonly InstallTarget[] = [
  claudeDesktopTarget,
  cursorTarget,
  codexTarget,
];

/** Default MCP server entry for harness-router-mcp. Override via flags. */
export function defaultEntry(): McpServerEntry {
  return {
    name: "harness-router",
    command: "npx",
    args: ["-y", "harness-router-mcp", "mcp"],
  };
}

/** Test seam: override the homedir resolver and platform check for unit tests. */
export interface InstallEnv {
  homedir?: string;
  appDataDir?: string;
  platform?: NodeJS.Platform;
}

/** Build a target list bound to a specific environment. Used by tests. */
export function targetsForEnv(env: InstallEnv): readonly InstallTarget[] {
  const home = env.homedir ?? os.homedir();
  const ad =
    env.appDataDir ??
    (env.platform === "win32"
      ? path.join(home, "AppData", "Roaming")
      : env.platform === "darwin"
        ? path.join(home, "Library", "Application Support")
        : path.join(home, ".config"));

  const pathFor = (target: "claude-desktop" | "cursor" | "codex"): string => {
    if (target === "claude-desktop") return path.join(ad, "Claude", "claude_desktop_config.json");
    if (target === "cursor") return path.join(home, ".cursor", "mcp.json");
    return path.join(home, ".codex", "config.toml");
  };

  return [
    {
      id: "claude-desktop",
      displayName: "Claude Desktop",
      configPath: () => pathFor("claude-desktop"),
      install: (entry) => jsonInstall(pathFor("claude-desktop"), entry),
      uninstall: (name) => jsonUninstall(pathFor("claude-desktop"), name),
      printSnippet: claudeDesktopTarget.printSnippet,
    },
    {
      id: "cursor",
      displayName: "Cursor IDE (user-scoped MCP)",
      configPath: () => pathFor("cursor"),
      install: (entry) => jsonInstall(pathFor("cursor"), entry),
      uninstall: (name) => jsonUninstall(pathFor("cursor"), name),
      printSnippet: cursorTarget.printSnippet,
    },
    {
      id: "codex",
      displayName: "Codex CLI / Desktop",
      configPath: () => pathFor("codex"),
      install: (entry) => tomlInstall(pathFor("codex"), entry),
      uninstall: (name) => tomlUninstall(pathFor("codex"), name),
      printSnippet: codexTarget.printSnippet,
    },
  ];
}

// Re-export so consumers get one named module.
export {
  fileExists as _fileExistsForTests,
  jsonInstall as _jsonInstallForTests,
  tomlInstall as _tomlInstallForTests,
};
