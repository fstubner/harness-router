/**
 * YAML → Config parser.
 *
 * Reads YAML text, validates against the schema, returns a frozen Config.
 * Every validation error is collected before throwing — the user sees every
 * problem in one shot, not one at a time as they fix and re-run.
 *
 * Env-var interpolation (`${VAR}`) runs once on the raw YAML string before
 * parsing. Same syntax used by metered route api_keys.
 */

import { promises as fs } from "node:fs";

import yaml from "js-yaml";

import type {
  Config,
  ConfigIssue,
  HttpConfig,
  MeteredRoute,
  ModelEntry,
  SubscriptionRoute,
} from "./types.js";
import { ConfigError } from "./types.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface LoadOpts {
  /** Override env lookups for testing. Defaults to `process.env`. */
  env?: (name: string) => string | undefined;
}

/** Read a YAML file from disk and parse to Config. */
export async function parseConfigFile(path: string, opts: LoadOpts = {}): Promise<Config> {
  const text = await fs.readFile(path, "utf-8");
  return parseConfigText(text, opts.env);
}

/** Synchronous parse — useful for tests. Mirrors parseConfigFile but takes raw text. */
export function parseConfigText(text: string, env?: (name: string) => string | undefined): Config {
  const lookup = env ?? ((n: string): string | undefined => process.env[n]);
  const raw = (yaml.load(interpolateEnv(text, lookup)) ?? {}) as Record<string, unknown>;
  return parse(raw);
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function interpolateEnv(text: string, env: (name: string) => string | undefined): string {
  return text.replace(/\$\{([A-Z0-9_]+)\}/g, (whole, name: string) => env(name) ?? whole);
}

function parse(raw: Record<string, unknown>): Config {
  const issues: ConfigIssue[] = [];

  // ---- models ------------------------------------------------------------
  const rawModels = raw.models;
  if (!rawModels || typeof rawModels !== "object" || Array.isArray(rawModels)) {
    issues.push({
      path: "models",
      message: "must be a map of {modelKey: {subscription?, metered?}}",
    });
    throw new ConfigError("Invalid config — models field missing or wrong shape", issues);
  }

  const models: Record<string, ModelEntry> = {};
  for (const [key, value] of Object.entries(rawModels as Record<string, unknown>)) {
    const entry = parseModelEntry(`models.${key}`, value, issues);
    if (entry) models[key] = entry;
  }

  // ---- priority ----------------------------------------------------------
  const priority = parsePriority(raw.priority, models, issues);

  // ---- mixture_default ---------------------------------------------------
  const mixtureDefault = parseMixtureDefault(raw.mixture_default, models, issues);

  // ---- http (optional) ---------------------------------------------------
  const http = parseHttp(raw.http, issues);

  if (issues.length > 0) {
    const summary = issues.map((i) => `  - ${i.path}: ${i.message}`).join("\n");
    throw new ConfigError(
      `Found ${issues.length} issue${issues.length === 1 ? "" : "s"} in config:\n${summary}`,
      issues,
    );
  }

  const cfg: Config = { priority, models };
  if (mixtureDefault)
    (cfg as { mixture_default?: readonly string[] }).mixture_default = mixtureDefault;
  if (http) (cfg as { http?: HttpConfig }).http = http;
  return Object.freeze(cfg);
}

function parseModelEntry(
  path: string,
  value: unknown,
  issues: ConfigIssue[],
): ModelEntry | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    issues.push({ path, message: "must be an object with subscription? and/or metered?" });
    return undefined;
  }
  const obj = value as Record<string, unknown>;
  const entry: ModelEntry = {};

  // Subscription routes — accept either a single object (shorthand for one
  // route) or an array of objects (multiple harnesses serving the same
  // model). Normalises to readonly array regardless.
  if (obj.subscription !== undefined) {
    const subs = parseSubscriptionList(`${path}.subscription`, obj.subscription, issues);
    if (subs.length > 0) entry.subscription = subs;
  }
  if (obj.metered !== undefined) {
    const meds = parseMeteredList(`${path}.metered`, obj.metered, issues);
    if (meds.length > 0) entry.metered = meds;
  }

  if (!entry.subscription && !entry.metered) {
    issues.push({ path, message: "must define at least one of subscription, metered" });
    return undefined;
  }
  return entry;
}

function parseSubscriptionList(
  path: string,
  value: unknown,
  issues: ConfigIssue[],
): SubscriptionRoute[] {
  // Single-object shorthand: { harness: "claude_code" }
  // Multi-route form:        [{ harness: "claude_code" }, { harness: "cursor" }]
  // Both normalise to SubscriptionRoute[] internally.
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const route = parseSubscription(path, value as Record<string, unknown>, issues);
    return route ? [route] : [];
  }
  if (!Array.isArray(value)) {
    issues.push({ path, message: "must be an object or an array of objects" });
    return [];
  }
  const list: unknown[] = value;
  const out: SubscriptionRoute[] = [];
  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      issues.push({ path: `${path}[${i}]`, message: "must be an object" });
      continue;
    }
    const route = parseSubscription(`${path}[${i}]`, item as Record<string, unknown>, issues);
    if (route) out.push(route);
  }
  return out;
}

function parseMeteredList(path: string, value: unknown, issues: ConfigIssue[]): MeteredRoute[] {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const route = parseMetered(path, value as Record<string, unknown>, issues);
    return route ? [route] : [];
  }
  if (!Array.isArray(value)) {
    issues.push({ path, message: "must be an object or an array of objects" });
    return [];
  }
  const list: unknown[] = value;
  const out: MeteredRoute[] = [];
  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      issues.push({ path: `${path}[${i}]`, message: "must be an object" });
      continue;
    }
    const route = parseMetered(`${path}[${i}]`, item as Record<string, unknown>, issues);
    if (route) out.push(route);
  }
  return out;
}

function parseSubscription(
  path: string,
  obj: Record<string, unknown>,
  issues: ConfigIssue[],
): SubscriptionRoute | undefined {
  if (typeof obj.harness !== "string" || obj.harness === "") {
    issues.push({ path: `${path}.harness`, message: "required string (e.g. claude_code)" });
    return undefined;
  }
  const route: SubscriptionRoute = { harness: obj.harness };
  if (typeof obj.cli_model_override === "string") route.cli_model_override = obj.cli_model_override;
  if (typeof obj.command === "string") route.command = obj.command;
  if (typeof obj.enabled === "boolean") route.enabled = obj.enabled;
  // generic_cli passes through verbatim. After the narrowing checks the type
  // is `object & {}`, structurally compatible with GenericCliRecipe.
  if (obj.generic_cli && typeof obj.generic_cli === "object" && !Array.isArray(obj.generic_cli)) {
    route.generic_cli = obj.generic_cli;
  }
  return route;
}

function parseMetered(
  path: string,
  obj: Record<string, unknown>,
  issues: ConfigIssue[],
): MeteredRoute | undefined {
  if (typeof obj.base_url !== "string" || obj.base_url === "") {
    issues.push({ path: `${path}.base_url`, message: "required string (https URL)" });
    return undefined;
  }
  const route: MeteredRoute = { base_url: obj.base_url };
  if (typeof obj.api_key === "string") route.api_key = obj.api_key;
  if (typeof obj.cli_model_override === "string") route.cli_model_override = obj.cli_model_override;
  if (typeof obj.enabled === "boolean") route.enabled = obj.enabled;
  return route;
}

function parseStringList(
  raw: unknown,
  models: Record<string, ModelEntry>,
  issues: ConfigIssue[],
  fieldName: "priority" | "mixture_default",
): readonly string[] | undefined {
  if (raw === undefined && fieldName === "mixture_default") return undefined;
  if (!Array.isArray(raw)) {
    issues.push({ path: fieldName, message: "must be an array of model keys" });
    return fieldName === "priority" ? [] : undefined;
  }
  const list: unknown[] = raw;
  const out: string[] = [];
  for (let i = 0; i < list.length; i++) {
    const entry: unknown = list[i];
    if (typeof entry !== "string") {
      issues.push({ path: `${fieldName}[${i}]`, message: "must be a string" });
      continue;
    }
    if (!(entry in models)) {
      issues.push({
        path: `${fieldName}[${i}]`,
        message: `references "${entry}" which is not defined under models`,
      });
      continue;
    }
    out.push(entry);
  }
  return out;
}

function parsePriority(
  raw: unknown,
  models: Record<string, ModelEntry>,
  issues: ConfigIssue[],
): readonly string[] {
  return parseStringList(raw, models, issues, "priority") ?? [];
}

function parseMixtureDefault(
  raw: unknown,
  models: Record<string, ModelEntry>,
  issues: ConfigIssue[],
): readonly string[] | undefined {
  const result = parseStringList(raw, models, issues, "mixture_default");
  if (!result) return undefined;
  return result.length > 0 ? result : undefined;
}

function parseHttp(raw: unknown, issues: ConfigIssue[]): HttpConfig | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    issues.push({ path: "http", message: "must be an object" });
    return undefined;
  }
  const obj = raw as Record<string, unknown>;
  const out: HttpConfig = {};
  if (typeof obj.bind === "string") out.bind = obj.bind;
  if (typeof obj.port === "number" && Number.isInteger(obj.port) && obj.port > 0) {
    out.port = obj.port;
  } else if (obj.port !== undefined) {
    issues.push({ path: "http.port", message: "must be a positive integer" });
  }
  if (obj.auth !== undefined) {
    if (!obj.auth || typeof obj.auth !== "object" || Array.isArray(obj.auth)) {
      issues.push({ path: "http.auth", message: "must be an object" });
    } else {
      const a = obj.auth as Record<string, unknown>;
      const auth: NonNullable<HttpConfig["auth"]> = {};
      if (typeof a.required === "boolean") auth.required = a.required;
      if (typeof a.token_file === "string") auth.token_file = a.token_file;
      out.auth = auth;
    }
  }
  // Force-on auth when binding non-loopback. The wizard would normally do this
  // too, but enforcing it here means hand-edited configs can't accidentally
  // expose an unauthenticated server to the network.
  if (out.bind && !isLoopback(out.bind)) {
    out.auth = { ...(out.auth ?? {}), required: true };
  }
  return out;
}

function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}
