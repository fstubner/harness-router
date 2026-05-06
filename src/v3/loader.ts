/**
 * v0.3 config loader.
 *
 * Reads YAML from disk, validates against the v0.3 schema, returns a frozen
 * V3Config. Every validation error is collected before throwing — the user
 * sees every problem in one shot.
 *
 * Env-var interpolation (`${VAR}`) runs once on the raw YAML string before
 * parsing. Same syntax used by metered route api_keys.
 *
 * Greenfield project: there is no migrator. A YAML with no `models:` key
 * gets a normal V3ConfigError pointing the user at the v0.3 schema; the
 * wizard (`harness-router onboard`) is the recommended way to get a
 * working config.
 */

import { promises as fs } from "node:fs";

import yaml from "js-yaml";

import type {
  V3Config,
  V3HttpConfig,
  V3Issue,
  V3MeteredRoute,
  V3ModelEntry,
  V3SubscriptionRoute,
} from "./types.js";
import { V3ConfigError } from "./types.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface LoadV3Opts {
  /** Override env lookups for testing. Defaults to `process.env`. */
  env?: (name: string) => string | undefined;
}

export async function loadV3Config(path: string, opts: LoadV3Opts = {}): Promise<V3Config> {
  const text = await fs.readFile(path, "utf-8");
  const env = opts.env ?? ((n) => process.env[n]);
  const interpolated = interpolateEnv(text, env);
  const raw = (yaml.load(interpolated) ?? {}) as Record<string, unknown>;
  return parseV3(raw);
}

/** Synchronous parse — useful for tests. Mirrors loadV3Config but takes raw text. */
export function parseV3Text(text: string, env?: (name: string) => string | undefined): V3Config {
  const lookup = env ?? ((n: string) => process.env[n]);
  const raw = (yaml.load(interpolateEnv(text, lookup)) ?? {}) as Record<string, unknown>;
  return parseV3(raw);
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function interpolateEnv(text: string, env: (name: string) => string | undefined): string {
  return text.replace(/\$\{([A-Z0-9_]+)\}/g, (whole, name: string) => env(name) ?? whole);
}

function parseV3(raw: Record<string, unknown>): V3Config {
  const issues: V3Issue[] = [];

  // ---- models ------------------------------------------------------------
  const rawModels = raw.models;
  if (!rawModels || typeof rawModels !== "object" || Array.isArray(rawModels)) {
    issues.push({
      path: "models",
      message: "must be a map of {modelKey: {subscription?, metered?}}",
    });
    throw new V3ConfigError("Invalid v0.3 config — models field missing or wrong shape", issues);
  }

  const models: Record<string, V3ModelEntry> = {};
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
    throw new V3ConfigError(
      `Found ${issues.length} issue${issues.length === 1 ? "" : "s"} in config:\n${summary}`,
      issues,
    );
  }

  const cfg: V3Config = { priority, models };
  if (mixtureDefault)
    (cfg as { mixture_default?: readonly string[] }).mixture_default = mixtureDefault;
  if (http) (cfg as { http?: V3HttpConfig }).http = http;
  return Object.freeze(cfg);
}

function parseModelEntry(
  path: string,
  value: unknown,
  issues: V3Issue[],
): V3ModelEntry | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    issues.push({ path, message: "must be an object with subscription? and/or metered?" });
    return undefined;
  }
  const obj = value as Record<string, unknown>;
  const entry: V3ModelEntry = {};

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
  issues: V3Issue[],
): V3SubscriptionRoute[] {
  // Single-object shorthand: { harness: "claude_code" }
  // Multi-route form:        [{ harness: "claude_code" }, { harness: "cursor" }]
  // Both normalise to V3SubscriptionRoute[] internally.
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const route = parseSubscription(path, value as Record<string, unknown>, issues);
    return route ? [route] : [];
  }
  if (!Array.isArray(value)) {
    issues.push({ path, message: "must be an object or an array of objects" });
    return [];
  }
  const list: unknown[] = value;
  const out: V3SubscriptionRoute[] = [];
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

function parseMeteredList(path: string, value: unknown, issues: V3Issue[]): V3MeteredRoute[] {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const route = parseMetered(path, value as Record<string, unknown>, issues);
    return route ? [route] : [];
  }
  if (!Array.isArray(value)) {
    issues.push({ path, message: "must be an object or an array of objects" });
    return [];
  }
  const list: unknown[] = value;
  const out: V3MeteredRoute[] = [];
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
  issues: V3Issue[],
): V3SubscriptionRoute | undefined {
  if (typeof obj.harness !== "string" || obj.harness === "") {
    issues.push({ path: `${path}.harness`, message: "required string (e.g. claude_code)" });
    return undefined;
  }
  const route: V3SubscriptionRoute = { harness: obj.harness };
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
  issues: V3Issue[],
): V3MeteredRoute | undefined {
  if (typeof obj.base_url !== "string" || obj.base_url === "") {
    issues.push({ path: `${path}.base_url`, message: "required string (https URL)" });
    return undefined;
  }
  const route: V3MeteredRoute = { base_url: obj.base_url };
  if (typeof obj.api_key === "string") route.api_key = obj.api_key;
  if (typeof obj.cli_model_override === "string") route.cli_model_override = obj.cli_model_override;
  if (typeof obj.enabled === "boolean") route.enabled = obj.enabled;
  return route;
}

function parseStringList(
  raw: unknown,
  models: Record<string, V3ModelEntry>,
  issues: V3Issue[],
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
  models: Record<string, V3ModelEntry>,
  issues: V3Issue[],
): readonly string[] {
  return parseStringList(raw, models, issues, "priority") ?? [];
}

function parseMixtureDefault(
  raw: unknown,
  models: Record<string, V3ModelEntry>,
  issues: V3Issue[],
): readonly string[] | undefined {
  const result = parseStringList(raw, models, issues, "mixture_default");
  if (!result) return undefined;
  return result.length > 0 ? result : undefined;
}

function parseHttp(raw: unknown, issues: V3Issue[]): V3HttpConfig | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    issues.push({ path: "http", message: "must be an object" });
    return undefined;
  }
  const obj = raw as Record<string, unknown>;
  const out: V3HttpConfig = {};
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
      const auth: NonNullable<V3HttpConfig["auth"]> = {};
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
