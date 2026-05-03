/**
 * Configuration loading for harness-router-mcp.
 *
 * Two entry points:
 *   loadConfig(path?)   — if no path, auto-detects installed CLIs on PATH.
 *                         If path points to a legacy YAML with a `services:`
 *                         key, returns it verbatim. Otherwise merges minimal
 *                         overrides onto auto-detected defaults.
 *   watchConfig(path)   — poll the file's mtime once a second and reload on
 *                         change. Returns {stop} to cancel the poller.
 *
 * All string values are scanned for ${ENV_VAR} references and replaced with
 * the corresponding environment variable.
 */

import { promises as fs } from "node:fs";
import yaml from "js-yaml";
import which from "which";

import type {
  GenericCliRecipe,
  RouterConfig,
  ServiceConfig,
  TaskType,
  ThinkingLevel,
} from "./types.js";

// ---------------------------------------------------------------------------
// Built-in defaults for auto-detected CLIs.
// Mirrors Python config.py _CLI_DEFAULTS exactly.
// ---------------------------------------------------------------------------

interface CliDefaults {
  command: string;
  harness: string;
  leaderboardModel: string;
  cliCapability: number;
  tier: number;
  thinkingLevel?: "low" | "medium" | "high";
  capabilities: { execute: number; plan: number; review: number };
  maxOutputTokens?: number;
  maxInputTokens?: number;
}

// Token limits as of April 2026. Treat as conservative upper bounds —
// providers occasionally raise them, rarely lower them.
const CLI_DEFAULTS: Record<string, CliDefaults> = {
  claude_code: {
    command: "claude",
    harness: "claude_code",
    leaderboardModel: "claude-opus-4-6",
    cliCapability: 1.1,
    tier: 1,
    capabilities: { execute: 0.95, plan: 1.0, review: 1.0 },
    maxOutputTokens: 64_000,
    maxInputTokens: 1_000_000, // Opus + Sonnet 1M context
  },
  codex: {
    command: "codex",
    harness: "codex",
    leaderboardModel: "gpt-5.4",
    cliCapability: 1.08,
    tier: 1,
    capabilities: { execute: 1.0, plan: 0.83, review: 0.82 },
    maxOutputTokens: 128_000,
    maxInputTokens: 400_000,
  },
  cursor: {
    command: "agent",
    harness: "cursor",
    leaderboardModel: "claude-sonnet-4-6",
    cliCapability: 1.05,
    tier: 1,
    capabilities: { execute: 1.0, plan: 0.82, review: 0.9 },
    maxOutputTokens: 64_000,
    maxInputTokens: 1_000_000,
  },
  gemini_cli: {
    command: "gemini",
    harness: "gemini_cli",
    leaderboardModel: "gemini-3.1-pro-preview",
    cliCapability: 1.0,
    tier: 1,
    thinkingLevel: "high",
    capabilities: { execute: 0.87, plan: 0.97, review: 0.95 },
    maxOutputTokens: 65_536,
    maxInputTokens: 2_000_000, // Gemini 3.1 Pro 2M context
  },
  opencode: {
    command: "opencode",
    harness: "opencode",
    // OpenCode is provider-agnostic — leaderboard model is whatever the user
    // configured in opencode.json. Default to a reasonable Claude entry so the
    // ELO lookup gives a sensible baseline; users can override via config.yaml.
    leaderboardModel: "claude-sonnet-4-6",
    cliCapability: 1.05, // open-source harness with active dev; calibrate as we learn
    tier: 1,
    capabilities: { execute: 0.92, plan: 0.95, review: 0.93 },
    maxOutputTokens: 64_000,
    maxInputTokens: 1_000_000,
  },
  copilot: {
    // GitHub's standalone agentic CLI (`@github/copilot` npm package).
    // Distinct from VS Code's Copilot extension (which has no headless
    // CLI and isn't routable). Underlying model varies by user policy /
    // org (GPT-4o / GPT-5 / Claude depending on Copilot Business config).
    command: "copilot",
    harness: "copilot",
    // Copilot's selectable model is opaque to the router (set via Copilot
    // settings, not per-call). We pin the leaderboard entry to a strong
    // baseline; recalibrate once empirical numbers are in.
    leaderboardModel: "gpt-5.4",
    cliCapability: 1.03, // GitHub-tooling-aware; calibrate as we learn
    tier: 1,
    capabilities: { execute: 0.9, plan: 0.85, review: 0.88 },
    maxOutputTokens: 64_000,
    maxInputTokens: 200_000,
  },
};

// ---------------------------------------------------------------------------
// Env var interpolation (${VAR_NAME})
//
// NOTE: this regex is anchored to `^...$`, so a string is only interpolated
// when it consists ENTIRELY of one `${VAR}` reference.
//
//   gemini_api_key: ${GEMINI_API_KEY}             ← interpolated
//   url: "https://api.example.com?key=${KEY}"     ← NOT interpolated (literal preserved)
//
// This intentionally matches the Python reference's behaviour. Mid-string
// interpolation has not been requested; if you need it, change the regex
// to `\$\{([A-Za-z_][A-Za-z0-9_]*)\}` (no anchors) and use String.replace
// to swap each match — but be aware existing configs that contain literal
// `${...}` values would change meaning.
// ---------------------------------------------------------------------------

const ENV_VAR_RE = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;

function interpolateEnv(value: string): string {
  const m = ENV_VAR_RE.exec(value);
  if (!m) return value;
  return process.env[m[1]!] ?? "";
}

/**
 * Walk an arbitrary parsed-YAML tree and replace any "${VAR}" string leaves
 * with their corresponding environment-variable values.
 *
 * The input is `unknown` because YAML trees can hold any leaf type (string,
 * number, boolean, null, array, object) — `js-yaml` doesn't constrain
 * shape. We preserve the input's runtime structure precisely; only string
 * leaves get rewritten. The previous implementation used a generic
 * `<T>` parameter and `as unknown as T` to make TS pass, but the generic
 * was a fiction — the caller could pass any tree, and the return wasn't
 * actually shape-preserving at the type level.
 *
 * This shape (input/output `unknown`) is honest about what the function
 * does. Callers narrow the result via the parser-builder helpers below.
 */
function interpolateTree(node: unknown): unknown {
  if (typeof node === "string") {
    return interpolateEnv(node);
  }
  if (Array.isArray(node)) {
    return node.map(interpolateTree);
  }
  if (node !== null && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      out[k] = interpolateTree(v);
    }
    return out;
  }
  return node;
}

// ---------------------------------------------------------------------------
// `which` — pluggable for tests
// ---------------------------------------------------------------------------

/** Injection seam for tests. Set via loadConfig({ whichFn }) if needed. */
export type WhichFn = (cmd: string) => Promise<string | null>;

const defaultWhich: WhichFn = async (cmd: string): Promise<string | null> => {
  try {
    const r = await which(cmd, { nothrow: true });
    return r ?? null;
  } catch {
    return null;
  }
};

// ---------------------------------------------------------------------------
// Normalization helpers
// ---------------------------------------------------------------------------

function num(v: unknown, def: number): number {
  if (typeof v === "number") return v;
  if (typeof v === "string" && v !== "") {
    const n = Number(v);
    if (!Number.isNaN(n)) return n;
  }
  return def;
}

function int(v: unknown, def: number): number {
  return Math.trunc(num(v, def));
}

function bool(v: unknown, def: boolean): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") {
    if (v === "true") return true;
    if (v === "false") return false;
  }
  return def;
}

function str(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  if (v === "") return undefined;
  return v;
}

function thinkingFrom(v: unknown): ThinkingLevel | undefined {
  if (v === "low" || v === "medium" || v === "high") return v;
  return undefined;
}

function capsFrom(raw: unknown): { execute: number; plan: number; review: number } {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    execute: num(r.execute, 1.0),
    plan: num(r.plan, 1.0),
    review: num(r.review, 1.0),
  };
}

function escalateOnFrom(raw: unknown): TaskType[] {
  if (!Array.isArray(raw)) return ["plan", "review"];
  const out: TaskType[] = [];
  for (const v of raw) {
    if (v === "execute" || v === "plan" || v === "review" || v === "local") {
      out.push(v);
    }
  }
  return out.length > 0 ? out : ["plan", "review"];
}

/**
 * Parse a `generic_cli` service's recipe block from raw YAML.
 *
 * Accepts both snake_case (idiomatic for YAML) and the camelCase TS field
 * names — same convention as the surrounding parser. All fields are
 * optional; missing fields use the dispatcher's defaults.
 */
function parseGenericCliRecipe(svc: Record<string, unknown>): GenericCliRecipe {
  const recipe: GenericCliRecipe = {};
  const stringList = (raw: unknown): string[] | undefined => {
    if (!Array.isArray(raw)) return undefined;
    const out: string[] = [];
    for (const v of raw) {
      if (typeof v === "string") out.push(v);
    }
    return out.length > 0 ? out : undefined;
  };
  const argsBefore = stringList(svc.args_before_prompt ?? svc.argsBeforePrompt);
  if (argsBefore) recipe.argsBeforePrompt = argsBefore;
  const argsAfter = stringList(svc.args_after_prompt ?? svc.argsAfterPrompt);
  if (argsAfter) recipe.argsAfterPrompt = argsAfter;
  const modelFlag = str(svc.model_flag ?? svc.modelFlag);
  if (modelFlag) recipe.modelFlag = modelFlag;
  const cwdFlag = str(svc.cwd_flag ?? svc.cwdFlag);
  if (cwdFlag) recipe.cwdFlag = cwdFlag;
  const promptDelivery = str(svc.prompt_delivery ?? svc.promptDelivery);
  if (promptDelivery === "positional" || promptDelivery === "flag" || promptDelivery === "stdin") {
    recipe.promptDelivery = promptDelivery;
  }
  const promptFlag = str(svc.prompt_flag ?? svc.promptFlag);
  if (promptFlag) recipe.promptFlag = promptFlag;
  const forwardEnv = stringList(svc.forward_env ?? svc.forwardEnv);
  if (forwardEnv) recipe.forwardEnv = forwardEnv;
  const outputJsonPath = str(svc.output_json_path ?? svc.outputJsonPath);
  if (outputJsonPath) recipe.outputJsonPath = outputJsonPath;
  const tokensJsonPath = str(svc.tokens_json_path ?? svc.tokensJsonPath);
  if (tokensJsonPath) recipe.tokensJsonPath = tokensJsonPath;
  const authCommand = str(svc.auth_command ?? svc.authCommand);
  if (authCommand) recipe.authCommand = authCommand;
  const argsPerFile = stringList(svc.args_per_file ?? svc.argsPerFile);
  if (argsPerFile) recipe.argsPerFile = argsPerFile;
  // outputJsonl is a nested block. Both snake_case and camelCase fields
  // accepted. textDeltaPath is required; the rest are optional.
  const rawJsonl = (svc.output_jsonl ?? svc.outputJsonl) as Record<string, unknown> | undefined;
  if (rawJsonl && typeof rawJsonl === "object") {
    const textDeltaPath = str(rawJsonl.text_delta_path ?? rawJsonl.textDeltaPath);
    if (textDeltaPath) {
      const jsonl: NonNullable<GenericCliRecipe["outputJsonl"]> = {
        textDeltaPath,
      };
      const toolNamePath = str(rawJsonl.tool_name_path ?? rawJsonl.toolNamePath);
      if (toolNamePath) jsonl.toolNamePath = toolNamePath;
      const toolInputPath = str(rawJsonl.tool_input_path ?? rawJsonl.toolInputPath);
      if (toolInputPath) jsonl.toolInputPath = toolInputPath;
      const thinkingPath = str(rawJsonl.thinking_path ?? rawJsonl.thinkingPath);
      if (thinkingPath) jsonl.thinkingPath = thinkingPath;
      const tokensPath = str(rawJsonl.tokens_path ?? rawJsonl.tokensPath);
      if (tokensPath) jsonl.tokensPath = tokensPath;
      recipe.outputJsonl = jsonl;
    }
  }
  return recipe;
}

// ---------------------------------------------------------------------------
// Legacy full-format parser (YAML with top-level `services:` key)
// ---------------------------------------------------------------------------

function buildLegacyConfig(raw: Record<string, unknown>): RouterConfig {
  const services: Record<string, ServiceConfig> = {};
  const rawServices = (raw.services ?? {}) as Record<string, Record<string, unknown>>;

  for (const [name, svc] of Object.entries(rawServices)) {
    const rawType = str(svc.type) ?? "cli";
    // Validate type against the union. Unknown types fall back to "cli"
    // so an old config with a typo doesn't silently disappear from
    // routing entirely — the dispatcher factory will either find a
    // harness match for `name` or skip the service.
    //
    // Audit pass A flagged this as a UX smell: `type: generic-cli`
    // (hyphen) silently degrades to "cli". We surface a stderr warning
    // so the operator sees the typo on first run. Stderr — not stdout —
    // because stdout is reserved for MCP JSON-RPC.
    const isKnownType =
      rawType === "cli" || rawType === "openai_compatible" || rawType === "generic_cli";
    if (!isKnownType) {
      process.stderr.write(
        `[harness-router-mcp] WARN: service "${name}" has unknown type "${rawType}" — ` +
          `falling back to "cli". Valid types: cli, openai_compatible, generic_cli.\n`,
      );
    }
    const type: ServiceConfig["type"] = isKnownType ? rawType : "cli";
    const svcConfig: ServiceConfig = {
      name,
      enabled: bool(svc.enabled, true),
      type,
      ...(str(svc.harness) !== undefined ? { harness: str(svc.harness)! } : {}),
      command: str(svc.command) ?? name,
      ...(str(svc.api_key) !== undefined ? { apiKey: str(svc.api_key)! } : {}),
      ...(str(svc.base_url) !== undefined ? { baseUrl: str(svc.base_url)! } : {}),
      ...(str(svc.model) !== undefined ? { model: str(svc.model)! } : {}),
      tier: int(svc.tier, 1),
      weight: num(svc.weight, 1.0),
      cliCapability: num(svc.cli_capability, 1.0),
      ...(str(svc.leaderboard_model) !== undefined
        ? { leaderboardModel: str(svc.leaderboard_model)! }
        : {}),
      ...(() => {
        const t = thinkingFrom(svc.thinking_level);
        return t !== undefined ? { thinkingLevel: t } : {};
      })(),
      ...(str(svc.escalate_model) !== undefined ? { escalateModel: str(svc.escalate_model)! } : {}),
      escalateOn: escalateOnFrom(svc.escalate_on),
      capabilities: capsFrom(svc.capabilities),
      // Use num()/int() so YAML strings ("64000") are accepted alongside numbers,
      // matching the rest of the parser.
      ...(svc.max_output_tokens !== undefined
        ? { maxOutputTokens: int(svc.max_output_tokens, 0) }
        : {}),
      ...(svc.max_input_tokens !== undefined
        ? { maxInputTokens: int(svc.max_input_tokens, 0) }
        : {}),
      ...(type === "generic_cli" ? { genericCli: parseGenericCliRecipe(svc) } : {}),
    };
    services[name] = svcConfig;
  }

  const cfg: RouterConfig = {
    services,
    ...(Array.isArray(raw.disabled) ? { disabled: (raw.disabled as string[]).slice() } : {}),
    ...(str(raw.gemini_api_key) !== undefined ? { geminiApiKey: str(raw.gemini_api_key)! } : {}),
  };
  return cfg;
}

// ---------------------------------------------------------------------------
// Auto-detect loader
// ---------------------------------------------------------------------------

interface ApiKeys {
  [service: string]: string;
}

async function detectServices(
  disabled: string[],
  apiKeys: ApiKeys,
  overrides: Record<string, Record<string, unknown>>,
  whichFn: WhichFn,
): Promise<Record<string, ServiceConfig>> {
  const services: Record<string, ServiceConfig> = {};
  const disabledSet = new Set(disabled);
  for (const [name, defaults] of Object.entries(CLI_DEFAULTS)) {
    if (disabledSet.has(name)) continue;
    const found = await whichFn(defaults.command);
    if (!found) continue;

    const override = { ...(overrides[name] ?? {}) };
    // Capabilities merge-over-defaults.
    const caps = { ...defaults.capabilities };
    if (override.capabilities && typeof override.capabilities === "object") {
      const oc = override.capabilities as Record<string, unknown>;
      if (oc.execute !== undefined) caps.execute = num(oc.execute, caps.execute);
      if (oc.plan !== undefined) caps.plan = num(oc.plan, caps.plan);
      if (oc.review !== undefined) caps.review = num(oc.review, caps.review);
      delete override.capabilities;
    }

    const svc: ServiceConfig = {
      name,
      enabled: true,
      type: "cli",
      harness: str(override.harness) ?? defaults.harness,
      command: str(override.command) ?? defaults.command,
      ...(apiKeys[name] ? { apiKey: apiKeys[name] } : {}),
      ...(str(override.model) !== undefined ? { model: str(override.model)! } : {}),
      ...(str(override.base_url) !== undefined ? { baseUrl: str(override.base_url)! } : {}),
      weight: num(override.weight, 1.0),
      tier: int(override.tier, defaults.tier),
      cliCapability: num(override.cli_capability, defaults.cliCapability),
      leaderboardModel: str(override.leaderboard_model) ?? defaults.leaderboardModel,
      ...(() => {
        const overrideThinking = thinkingFrom(override.thinking_level);
        if (overrideThinking !== undefined) return { thinkingLevel: overrideThinking };
        if (defaults.thinkingLevel !== undefined) {
          return { thinkingLevel: defaults.thinkingLevel };
        }
        return {};
      })(),
      ...(str(override.escalate_model) !== undefined
        ? { escalateModel: str(override.escalate_model)! }
        : {}),
      escalateOn: escalateOnFrom(override.escalate_on),
      capabilities: caps,
      ...(() => {
        // Accept both numbers and YAML strings; fall back to the default if
        // the override is absent or unparseable.
        const m = override.max_output_tokens;
        if (m !== undefined) {
          const parsed = int(m, NaN);
          if (Number.isFinite(parsed)) return { maxOutputTokens: parsed };
        }
        return defaults.maxOutputTokens !== undefined
          ? { maxOutputTokens: defaults.maxOutputTokens }
          : {};
      })(),
      ...(() => {
        const m = override.max_input_tokens;
        if (m !== undefined) {
          const parsed = int(m, NaN);
          if (Number.isFinite(parsed)) return { maxInputTokens: parsed };
        }
        return defaults.maxInputTokens !== undefined
          ? { maxInputTokens: defaults.maxInputTokens }
          : {};
      })(),
    };
    services[name] = svc;
  }
  return services;
}

function collectApiKeys(raw: Record<string, unknown>): ApiKeys {
  const apiKeys: ApiKeys = {};

  const rawApiKeys = (raw.api_keys ?? {}) as Record<string, unknown>;
  for (const [k, v] of Object.entries(rawApiKeys)) {
    if (typeof v === "string" && v !== "") apiKeys[k] = v;
  }

  // Shorthand: gemini_api_key, codex_api_key, etc.
  for (const name of Object.keys(CLI_DEFAULTS)) {
    const shorthand = `${name}_api_key`;
    const v = raw[shorthand];
    if (typeof v === "string" && v !== "") apiKeys[name] = v;
  }
  // Top-level gemini_api_key is the common case -> gemini_cli.
  if (typeof raw.gemini_api_key === "string" && raw.gemini_api_key !== "") {
    apiKeys.gemini_cli = raw.gemini_api_key;
  }
  // Fall back to env directly for Gemini.
  if (!apiKeys.gemini_cli) {
    const fromEnv = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
    if (fromEnv) apiKeys.gemini_cli = fromEnv;
  }

  return apiKeys;
}

function addEndpoints(services: Record<string, ServiceConfig>, raw: Record<string, unknown>): void {
  const endpoints = Array.isArray(raw.endpoints)
    ? (raw.endpoints as Record<string, unknown>[])
    : [];
  for (const ep of endpoints) {
    const name = str(ep.name);
    const baseUrl = str(ep.base_url);
    const model = str(ep.model);
    if (!name || !baseUrl || !model) continue;

    const svc: ServiceConfig = {
      name,
      enabled: bool(ep.enabled, true),
      type: "openai_compatible",
      baseUrl,
      model,
      command: "",
      ...(str(ep.api_key) !== undefined ? { apiKey: str(ep.api_key)! } : {}),
      weight: num(ep.weight, 0.6),
      tier: int(ep.tier, 3),
      cliCapability: num(ep.cli_capability, 1.0),
      ...(str(ep.leaderboard_model) !== undefined
        ? { leaderboardModel: str(ep.leaderboard_model)! }
        : {}),
      escalateOn: escalateOnFrom(ep.escalate_on),
      capabilities: capsFrom(ep.capabilities),
    };
    services[name] = svc;
  }
}

// ---------------------------------------------------------------------------
// Public: loadConfig
// ---------------------------------------------------------------------------

export interface LoadConfigOptions {
  /** Override `which` for tests — return null when a CLI is "not found". */
  whichFn?: WhichFn;
}

/**
 * Load a RouterConfig.
 *
 * If `path` is omitted (or the file doesn't exist), auto-detect CLIs on PATH
 * and use built-in defaults. If the file has a top-level `services:` key,
 * parse it in legacy mode. Otherwise auto-detect and merge `overrides`.
 *
 * Supports ${ENV_VAR} interpolation for any string value.
 */
export async function loadConfig(
  path?: string,
  opts: LoadConfigOptions = {},
): Promise<RouterConfig> {
  const whichFn = opts.whichFn ?? defaultWhich;

  let raw: Record<string, unknown> = {};
  if (path) {
    try {
      const text = await fs.readFile(path, "utf-8");
      const parsed = yaml.load(text);
      if (parsed && typeof parsed === "object") {
        // interpolateTree returns `unknown`; we just verified `parsed` is
        // an object, and the function preserves runtime shape, so the
        // narrowing is safe here.
        raw = interpolateTree(parsed) as Record<string, unknown>;
      }
    } catch (err: unknown) {
      // File not found -> auto-detect mode. Any other error -> rethrow.
      const e = err as NodeJS.ErrnoException;
      if (e.code !== "ENOENT") throw err;
    }
  }

  // Legacy full format: has a `services:` key -> use as-is.
  if (raw.services && typeof raw.services === "object") {
    return buildLegacyConfig(raw);
  }

  const disabled: string[] = Array.isArray(raw.disabled) ? (raw.disabled as string[]).slice() : [];
  const overrides = (raw.overrides ?? {}) as Record<string, Record<string, unknown>>;

  const apiKeys = collectApiKeys(raw);
  const services = await detectServices(disabled, apiKeys, overrides, whichFn);
  addEndpoints(services, raw);

  const cfg: RouterConfig = {
    services,
    disabled,
    ...(apiKeys.gemini_cli ? { geminiApiKey: apiKeys.gemini_cli } : {}),
  };
  return cfg;
}

// ---------------------------------------------------------------------------
// Public: watchConfig
// ---------------------------------------------------------------------------

export interface ConfigWatcher {
  stop(): void;
}

/**
 * Poll the config file's mtime once per second. When it changes, reload and
 * invoke `onChange`. The returned handle's stop() cancels the poller.
 *
 * Errors from reload are swallowed so a transient parse error doesn't kill
 * the watcher — the next successful poll will pick up a repaired file.
 */
export function watchConfig(
  path: string,
  onChange: (c: RouterConfig) => void,
  opts: { intervalMs?: number; whichFn?: WhichFn } = {},
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
        const cfg = await loadConfig(path, opts.whichFn ? { whichFn: opts.whichFn } : {});
        onChange(cfg);
      }
    } catch {
      // ignore transient errors
    }
  };

  const handle = setInterval(() => {
    void tick();
  }, intervalMs);
  // Don't keep the host process alive just because a watcher is running.
  // Library users who forget to call `stop()` would otherwise hang on
  // exit. The MCP server doesn't use this entry point (ConfigHotReloader
  // polls lazily between tool calls), so this primarily affects external
  // consumers of the public API.
  handle.unref?.();

  return {
    stop(): void {
      clearInterval(handle);
    },
  };
}
