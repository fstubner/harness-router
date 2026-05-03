/**
 * Configuration loading for harness-router-mcp.
 *
 * Two entry points:
 *   loadConfig(path?)   — if no path, auto-detects installed CLIs on PATH.
 *                         If path points to a YAML with a `services:` key,
 *                         returns it verbatim. Otherwise merges minimal
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
  RouteTier,
  RouterConfig,
  ServiceConfig,
  ThinkingLevel,
} from "./types.js";

// ---------------------------------------------------------------------------
// Built-in defaults for auto-detected CLIs.
// Each CLI gets a sensible default model. Users override via `overrides:`
// or the legacy `services:` block.
// ---------------------------------------------------------------------------

interface CliDefaults {
  command: string;
  harness: string;
  /** Canonical model ID this CLI serves by default. */
  model: string;
  thinkingLevel?: ThinkingLevel;
  maxOutputTokens?: number;
  maxInputTokens?: number;
}

// Token limits as of April 2026. Conservative upper bounds.
const CLI_DEFAULTS: Record<string, CliDefaults> = {
  claude_code: {
    command: "claude",
    harness: "claude_code",
    model: "claude-sonnet-4.6",
    maxOutputTokens: 64_000,
    maxInputTokens: 1_000_000,
  },
  codex: {
    command: "codex",
    harness: "codex",
    model: "gpt-5.4",
    maxOutputTokens: 128_000,
    maxInputTokens: 400_000,
  },
  cursor: {
    command: "agent",
    harness: "cursor",
    model: "claude-sonnet-4.6",
    maxOutputTokens: 64_000,
    maxInputTokens: 1_000_000,
  },
  gemini_cli: {
    command: "gemini",
    harness: "gemini_cli",
    model: "gemini-3.1-pro",
    thinkingLevel: "high",
    maxOutputTokens: 65_536,
    maxInputTokens: 2_000_000,
  },
  opencode: {
    command: "opencode",
    harness: "opencode",
    model: "claude-sonnet-4.6",
    maxOutputTokens: 64_000,
    maxInputTokens: 1_000_000,
  },
  copilot: {
    command: "copilot",
    harness: "copilot",
    model: "gpt-5.4",
    maxOutputTokens: 64_000,
    maxInputTokens: 200_000,
  },
};

/**
 * Default model priority for auto-detected configs. Walked in this order
 * when no explicit `model_priority` is declared. Built from the union of
 * CLI_DEFAULTS' models — order is "good general-purpose default" picks.
 */
const DEFAULT_MODEL_PRIORITY: readonly string[] = [
  "claude-opus-4.7",
  "gpt-5.4",
  "claude-sonnet-4.6",
  "gemini-3.1-pro",
];

// ---------------------------------------------------------------------------
// Env var interpolation (${VAR_NAME})
// Only interpolates when a string consists ENTIRELY of one `${VAR}` reference.
// ---------------------------------------------------------------------------

const ENV_VAR_RE = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;

function interpolateEnv(value: string): string {
  const m = ENV_VAR_RE.exec(value);
  if (!m) return value;
  return process.env[m[1]!] ?? "";
}

function interpolateTree(node: unknown): unknown {
  if (typeof node === "string") return interpolateEnv(node);
  if (Array.isArray(node)) return node.map(interpolateTree);
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

function tierFrom(v: unknown): RouteTier {
  return v === "metered" ? "metered" : "subscription";
}

function modelPriorityFrom(raw: unknown): readonly string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v === "string" && v !== "") out.push(v);
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Parse a `generic_cli` service's recipe block from raw YAML.
 * Accepts both snake_case and camelCase field names. All fields optional.
 */
function parseGenericCliRecipe(svc: Record<string, unknown>): GenericCliRecipe {
  const recipe: GenericCliRecipe = {};
  const stringList = (raw: unknown): string[] | undefined => {
    if (!Array.isArray(raw)) return undefined;
    const out: string[] = [];
    for (const v of raw) if (typeof v === "string") out.push(v);
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
  const rawJsonl = (svc.output_jsonl ?? svc.outputJsonl) as Record<string, unknown> | undefined;
  if (rawJsonl && typeof rawJsonl === "object") {
    const textDeltaPath = str(rawJsonl.text_delta_path ?? rawJsonl.textDeltaPath);
    if (textDeltaPath) {
      const jsonl: NonNullable<GenericCliRecipe["outputJsonl"]> = { textDeltaPath };
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
      tier: tierFrom(svc.tier),
      ...(() => {
        const t = thinkingFrom(svc.thinking_level);
        return t !== undefined ? { thinkingLevel: t } : {};
      })(),
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

  const cfg: RouterConfig = { services };
  const priority = modelPriorityFrom(raw.model_priority);
  if (priority) cfg.modelPriority = priority;
  if (Array.isArray(raw.disabled)) cfg.disabled = (raw.disabled as string[]).slice();
  const geminiKey = str(raw.gemini_api_key);
  if (geminiKey) cfg.geminiApiKey = geminiKey;
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

    const override = overrides[name] ?? {};
    const svc: ServiceConfig = {
      name,
      enabled: true,
      type: "cli",
      harness: str(override.harness) ?? defaults.harness,
      command: str(override.command) ?? defaults.command,
      ...(apiKeys[name] ? { apiKey: apiKeys[name] } : {}),
      model: str(override.model) ?? defaults.model,
      tier: tierFrom(override.tier ?? "subscription"),
      ...(() => {
        const overrideThinking = thinkingFrom(override.thinking_level);
        if (overrideThinking !== undefined) return { thinkingLevel: overrideThinking };
        if (defaults.thinkingLevel !== undefined) return { thinkingLevel: defaults.thinkingLevel };
        return {};
      })(),
      ...(() => {
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
  for (const name of Object.keys(CLI_DEFAULTS)) {
    const shorthand = `${name}_api_key`;
    const v = raw[shorthand];
    if (typeof v === "string" && v !== "") apiKeys[name] = v;
  }
  if (typeof raw.gemini_api_key === "string" && raw.gemini_api_key !== "") {
    apiKeys.gemini_cli = raw.gemini_api_key;
  }
  if (!apiKeys.gemini_cli) {
    const fromEnv = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
    if (fromEnv) apiKeys.gemini_cli = fromEnv;
  }
  return apiKeys;
}

/**
 * Add metered API endpoints from the YAML `endpoints:` block. Endpoints
 * default to `tier: metered` since they're per-token-billed APIs (override
 * via `tier: subscription` if you have a flat-rate API arrangement).
 */
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
      tier: tierFrom(ep.tier ?? "metered"),
    };
    services[name] = svc;
  }
}

// ---------------------------------------------------------------------------
// Public: loadConfig
// ---------------------------------------------------------------------------

export interface LoadConfigOptions {
  whichFn?: WhichFn;
}

/**
 * Load a RouterConfig.
 *
 * If `path` is omitted (or the file doesn't exist), auto-detect CLIs on
 * PATH. If the file has a `services:` key, parse it in legacy mode.
 * Otherwise auto-detect and merge `overrides`. `${ENV_VAR}` interpolation
 * is supported throughout.
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
        raw = interpolateTree(parsed) as Record<string, unknown>;
      }
    } catch (err: unknown) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== "ENOENT") throw err;
    }
  }

  // Legacy full format: explicit `services:` block.
  if (raw.services && typeof raw.services === "object") {
    return buildLegacyConfig(raw);
  }

  const disabled: string[] = Array.isArray(raw.disabled) ? (raw.disabled as string[]).slice() : [];
  const overrides = (raw.overrides ?? {}) as Record<string, Record<string, unknown>>;

  const apiKeys = collectApiKeys(raw);
  const services = await detectServices(disabled, apiKeys, overrides, whichFn);
  addEndpoints(services, raw);

  const explicitPriority = modelPriorityFrom(raw.model_priority);
  const cfg: RouterConfig = {
    services,
    modelPriority: explicitPriority ?? DEFAULT_MODEL_PRIORITY,
    disabled,
  };
  if (apiKeys.gemini_cli) cfg.geminiApiKey = apiKeys.gemini_cli;
  return cfg;
}

// ---------------------------------------------------------------------------
// Public: watchConfig
// ---------------------------------------------------------------------------

export interface ConfigWatcher {
  stop(): void;
}

/**
 * Poll the config file's mtime once per second. When it changes, reload
 * and invoke `onChange`. Errors during reload are swallowed so a transient
 * parse error doesn't kill the watcher.
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

  const handle = setInterval(() => void tick(), intervalMs);
  handle.unref?.();

  return { stop: (): void => clearInterval(handle) };
}
