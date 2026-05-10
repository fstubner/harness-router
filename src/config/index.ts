/**
 * Public config surface: `loadConfig` and `watchConfig`.
 *
 * `loadConfig(path?)`:
 *   - Reads the YAML at `path` (or `~/.harness-router/config.yaml` when
 *     omitted), runs env-var interpolation, parses through the schema
 *     parser, and returns a `RouterConfig` (the runtime shape) via the
 *     adapter.
 *   - Throws when the file is missing, with a clear "run onboard" hint.
 *     Greenfield: there's no auto-detect default, no fallback to magic
 *     defaults — the wizard is the single path to a working config.
 *
 * `watchConfig(path, onChange)`:
 *   - Polls mtime every `intervalMs` (default 1s) and re-runs loadConfig
 *     on change. Transient parse errors are swallowed so a half-saved
 *     YAML doesn't kill the watcher; the next tick retries.
 *
 * Other config concerns live in sibling modules:
 *   - ./types.ts    — Config, ModelEntry, route shapes, ConfigError
 *   - ./parser.ts   — parseConfigText (YAML → Config + validation)
 *   - ./adapter.ts  — Config → RouterConfig (synthetic service ids)
 *   - ./render.ts   — Config → YAML (for the wizard's writeback)
 */

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { RouterConfig } from "../types.js";
import { parseConfigText } from "./parser.js";
import { toRouterConfig } from "./adapter.js";

export type { Config, ModelEntry, SubscriptionRoute, MeteredRoute, HttpConfig } from "./types.js";
export { ConfigError } from "./types.js";
export { parseConfigText, parseConfigFile } from "./parser.js";
export { toRouterConfig } from "./adapter.js";
export { renderConfigYaml } from "./render.js";

export class ConfigMissingError extends Error {
  constructor(public readonly path: string) {
    super(
      `No config at ${path}. Run \`harness-router onboard\` to create one, ` +
        `or pass --config <path> to point at a hand-written file.`,
    );
    this.name = "ConfigMissingError";
  }
}

export interface LoadConfigOptions {
  /** Override env lookups for testing. Defaults to process.env. */
  env?: (name: string) => string | undefined;
}

/** Default config location written by the `onboard` wizard. */
export function defaultUserConfigPath(): string {
  return join(homedir(), ".harness-router", "config.yaml");
}

/**
 * Load the on-disk Config and adapt it for the runtime.
 *
 * Path resolution priority:
 *   1. Explicit `path` arg.
 *   2. `~/.harness-router/config.yaml`.
 *
 * Throws ConfigMissingError when no file exists at the resolved path.
 * Throws ConfigError when the file exists but doesn't validate.
 */
export async function loadConfig(
  path?: string,
  opts: LoadConfigOptions = {},
): Promise<RouterConfig> {
  const resolvedPath = path ?? defaultUserConfigPath();

  let text: string;
  try {
    text = await fs.readFile(resolvedPath, "utf-8");
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") throw new ConfigMissingError(resolvedPath);
    throw err;
  }

  const env = opts.env ?? ((n: string): string | undefined => process.env[n]);
  const config = parseConfigText(text, env);
  return toRouterConfig(config);
}

// ---------------------------------------------------------------------------
// Public: watchConfig
// ---------------------------------------------------------------------------

export interface ConfigWatcher {
  stop(): void;
}

/**
 * Poll the config file's mtime once per `intervalMs` (default 1 s). When it
 * changes, re-run `loadConfig` and invoke `onChange`. Transient errors
 * (mid-edit YAML, ENOENT during atomic rename) are swallowed so the watcher
 * doesn't die on partial writes.
 */
export function watchConfig(
  path: string,
  onChange: (c: RouterConfig) => void,
  opts: { intervalMs?: number; env?: (n: string) => string | undefined } = {},
): ConfigWatcher {
  const intervalMs = opts.intervalMs ?? 1000;
  let lastMtime = 0;

  const tick = async (): Promise<void> => {
    try {
      const stat = await fs.stat(path);
      const mtime = stat.mtimeMs;
      if (lastMtime === 0) {
        lastMtime = mtime;
        return;
      }
      if (mtime !== lastMtime) {
        lastMtime = mtime;
        const loadOpts: LoadConfigOptions = {};
        if (opts.env) loadOpts.env = opts.env;
        const cfg = await loadConfig(path, loadOpts);
        onChange(cfg);
      }
    } catch {
      // Transient errors (parse mid-edit, ENOENT during rename) — ignore.
    }
  };

  const handle = setInterval(() => void tick(), intervalMs);
  handle.unref?.();

  return { stop: (): void => clearInterval(handle) };
}
