/**
 * `harness-router migrate` — translate a v0.2 config.yaml into v0.3 shape.
 *
 * Reads the legacy file, runs the in-memory migrator, writes the v0.3 YAML
 * back to the same path. The original is preserved as `<path>.v2.bak`. All
 * warnings emitted by the migrator are surfaced to stderr so the user sees
 * dropped/collapsed services.
 *
 * Idempotent: if the file is already v0.3 shape, it prints a notice and
 * exits 0 without writing.
 */

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import yaml from "js-yaml";

import type { RouterConfig, ServiceConfig } from "../types.js";
import { migrateV2ToV3, renderV3Yaml } from "../v3/migrate.js";
import { parseV3Text } from "../v3/loader.js";
import { LegacyConfigError } from "../v3/loader.js";

export interface MigrateCmdOpts {
  /** Explicit path. Defaults to ~/.harness-router/config.yaml. */
  configPath?: string;
  /** Skip the .v2.bak backup. Default: keep the backup. */
  noBackup?: boolean;
  /** Where to write log output. Defaults to process.stdout/stderr. */
  out?: NodeJS.WritableStream;
  err?: NodeJS.WritableStream;
}

export async function cmdMigrate(opts: MigrateCmdOpts = {}): Promise<number> {
  const out = opts.out ?? process.stdout;
  const err = opts.err ?? process.stderr;
  const configPath = opts.configPath ?? join(homedir(), ".harness-router", "config.yaml");

  let text: string;
  try {
    text = await fs.readFile(configPath, "utf-8");
  } catch (e: unknown) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      err.write(
        `migrate: no config at ${configPath}. ` +
          `Run \`harness-router onboard\` to create one, or pass --config <path>.\n`,
      );
      return 1;
    }
    err.write(`migrate: cannot read ${configPath}: ${(e as Error).message}\n`);
    return 1;
  }

  // Already v0.3? Idempotent no-op.
  try {
    parseV3Text(text);
    out.write(`migrate: ${configPath} is already in v0.3 shape — nothing to do.\n`);
    return 0;
  } catch (e: unknown) {
    if (!(e instanceof LegacyConfigError)) {
      // Some other parse error — surface it.
      err.write(`migrate: cannot parse ${configPath}: ${(e as Error).message}\n`);
      return 1;
    }
    // Fall through — file is legacy, this is what migrate is for.
  }

  // Parse the v0.2 YAML into a RouterConfig with the *legacy* parser. We
  // can't call loadConfig() because it now refuses legacy shapes outright.
  // The legacy parsing logic lives in src/config.ts; rather than re-export
  // the private buildLegacyConfig, we re-implement the minimal pieces we
  // need here against the YAML directly.
  const v2 = parseLegacyForMigration(text);
  if (!v2) {
    err.write(
      `migrate: ${configPath} doesn't look like a recognised v0.2 config. ` +
        `Run \`harness-router onboard\` to start fresh.\n`,
    );
    return 1;
  }

  const { config: v3, warnings } = migrateV2ToV3(v2);
  const yamlOut = renderV3Yaml(v3);

  if (!opts.noBackup) {
    const backup = `${configPath}.v2.bak`;
    await fs.writeFile(backup, text, "utf-8");
    out.write(`migrate: backed up original to ${backup}\n`);
  }
  await fs.writeFile(configPath, yamlOut, "utf-8");
  out.write(`migrate: wrote v0.3 config to ${configPath}\n`);

  if (warnings.length > 0) {
    err.write(`migrate: ${warnings.length} warning(s):\n`);
    for (const w of warnings) {
      err.write(`  - ${w}\n`);
    }
  }
  return 0;
}

/**
 * Minimal legacy-YAML parser, scoped to what {@link migrateV2ToV3} needs.
 *
 * We deliberately don't go through src/config.ts loadConfig because that
 * function now throws LegacyConfigError on any v0.2 shape — it's the v0.3
 * runtime's "refuse to run on stale config" behaviour, not appropriate
 * for the migration command itself.
 *
 * Returns `null` when the YAML doesn't have a recognisable v0.2 services
 * map. Doesn't try to faithfully reproduce auto-detect / overrides /
 * endpoints branches — those are translated into the in-memory `services`
 * shape by the same recipe loadConfig used, here implemented inline.
 */
function parseLegacyForMigration(text: string): RouterConfig | null {
  const raw = (yaml.load(text) ?? {}) as Record<string, unknown>;
  if (!raw || typeof raw !== "object") return null;

  const services: Record<string, ServiceConfig> = {};
  const rawServices = raw.services;
  if (rawServices && typeof rawServices === "object" && !Array.isArray(rawServices)) {
    for (const [name, value] of Object.entries(rawServices as Record<string, unknown>)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const svc = parseLegacyServiceEntry(name, value as Record<string, unknown>);
      if (svc) services[name] = svc;
    }
  }

  // Endpoints list → openai_compatible metered services
  const rawEndpoints = raw.endpoints;
  if (Array.isArray(rawEndpoints)) {
    for (const ep of rawEndpoints) {
      if (!ep || typeof ep !== "object" || Array.isArray(ep)) continue;
      const e = ep as Record<string, unknown>;
      const name = typeof e.name === "string" ? e.name : null;
      const baseUrl = typeof e.base_url === "string" ? e.base_url : null;
      const model = typeof e.model === "string" ? e.model : null;
      if (!name || !baseUrl) continue;
      const svc: ServiceConfig = {
        name,
        enabled: true,
        type: "openai_compatible",
        baseUrl,
        tier: "metered",
      };
      if (model) svc.model = model;
      if (typeof e.api_key === "string") svc.apiKey = e.api_key;
      services[name] = svc;
    }
  }

  // model_priority
  const priority: string[] = [];
  if (Array.isArray(raw.model_priority)) {
    for (const m of raw.model_priority) {
      if (typeof m === "string" && m !== "") priority.push(m);
    }
  }

  const cfg: RouterConfig = {
    services,
    modelPriority: priority,
  };
  if (Array.isArray(raw.disabled)) {
    cfg.disabled = (raw.disabled as unknown[]).filter((x): x is string => typeof x === "string");
  }
  if (Array.isArray(raw.mixture_default)) {
    cfg.mixtureDefault = (raw.mixture_default as unknown[]).filter(
      (x): x is string => typeof x === "string",
    );
  }
  if (Object.keys(services).length === 0 && priority.length === 0) {
    return null;
  }
  return cfg;
}

function parseLegacyServiceEntry(name: string, raw: Record<string, unknown>): ServiceConfig | null {
  const type: ServiceConfig["type"] =
    raw.type === "openai_compatible" || raw.type === "generic_cli" || raw.type === "cli"
      ? raw.type
      : "cli";
  const svc: ServiceConfig = {
    name,
    enabled: raw.enabled !== false,
    type,
  };
  if (typeof raw.harness === "string") svc.harness = raw.harness;
  if (typeof raw.command === "string") svc.command = raw.command;
  if (typeof raw.api_key === "string") svc.apiKey = raw.api_key;
  if (typeof raw.base_url === "string") svc.baseUrl = raw.base_url;
  if (typeof raw.model === "string") svc.model = raw.model;
  if (typeof raw.cli_model === "string") svc.cliModel = raw.cli_model;

  // Tier: v0.1 used numeric (1=subscription, 2/3=metered); v0.2 used strings.
  if (raw.tier === "subscription" || raw.tier === "metered") {
    svc.tier = raw.tier;
  } else if (typeof raw.tier === "number") {
    svc.tier = raw.tier === 1 ? "subscription" : "metered";
  } else {
    svc.tier = "subscription";
  }

  // generic_cli recipe — pass through verbatim, snake_case fields handled by
  // the migrator/V3 loader which both already accept that shape. After the
  // narrowing checks the type is `object & {}`, structurally compatible with
  // GenericCliRecipe (all fields optional).
  if (raw.generic_cli && typeof raw.generic_cli === "object" && !Array.isArray(raw.generic_cli)) {
    svc.genericCli = raw.generic_cli;
  }
  return svc;
}
