/**
 * v0.2 → v0.3 config migrator.
 *
 * Reads a v0.2-shaped config (services-keyed) and produces an equivalent
 * v0.3-shaped config (model-keyed). Pure function — no I/O.
 *
 * The translation is mostly mechanical:
 *   - Each v0.2 service becomes a route under the model it serves.
 *   - Subscription/metered tier in the v0.2 service becomes the route key.
 *   - `cli_model` (when set and ≠ canonical) becomes `cli_model_override`.
 *   - `model_priority` becomes `priority` verbatim (same semantics).
 *   - `mixture_default` flips from service-names to model-names — the
 *     migrator picks each chosen service's `model:` field as the v0.3 model
 *     key and de-duplicates.
 *
 * Lossy parts (callers should warn about these):
 *   - A v0.2 service with no `model:` field is dropped — v0.3 is model-keyed
 *     and there's nowhere to put it.
 *   - Two services serving the same model in the same tier collapse to one
 *     entry; the first one wins.
 *   - `disabled:` list becomes per-route `enabled: false` flags (same effect,
 *     different shape).
 */

import type { ServiceConfig, RouterConfig } from "../types.js";
import type { V3Config, V3ModelEntry, V3MeteredRoute, V3SubscriptionRoute } from "./types.js";

export interface MigrationResult {
  config: V3Config;
  /** Human-readable warnings — services dropped, collapsed, etc. */
  warnings: readonly string[];
}

export function migrateV2ToV3(v2: RouterConfig): MigrationResult {
  const warnings: string[] = [];
  const models: Record<string, V3ModelEntry> = {};
  const disabled = new Set(v2.disabled ?? []);

  // Track which v0.2 service ended up as which (model, tier) so mixture_default
  // can be translated.
  const serviceToModel = new Map<string, string>();

  for (const [name, svc] of Object.entries(v2.services)) {
    if (!svc.model) {
      warnings.push(`service "${name}" had no model field — dropped (v0.3 is model-keyed)`);
      continue;
    }
    const tier = svc.tier ?? "subscription";
    const model = svc.model;
    if (!models[model]) models[model] = {};
    const entry = models[model];

    if (tier === "subscription") {
      if (entry.subscription) {
        warnings.push(
          `services "${name}" and another both serve subscription tier of model "${model}" — keeping the first (${entry.subscription.harness})`,
        );
        continue;
      }
      entry.subscription = buildSubscriptionRoute(name, svc, disabled);
      serviceToModel.set(name, model);
    } else {
      if (entry.metered) {
        warnings.push(
          `services "${name}" and another both serve metered tier of model "${model}" — keeping the first`,
        );
        continue;
      }
      entry.metered = buildMeteredRoute(svc, disabled);
      serviceToModel.set(name, model);
    }
  }

  // priority: filter out any model not present in `models`, warn about losses
  const priority: string[] = [];
  for (const m of v2.modelPriority ?? []) {
    if (models[m]) priority.push(m);
    else warnings.push(`model_priority entry "${m}" has no matching model entry — dropped`);
  }

  // mixture_default: translate service names → model names, deduplicate
  const mixtureDefault: string[] = [];
  if (v2.mixtureDefault) {
    const seen = new Set<string>();
    for (const svcName of v2.mixtureDefault) {
      const model = serviceToModel.get(svcName);
      if (!model) {
        warnings.push(`mixture_default entry "${svcName}" had no surviving model — dropped`);
        continue;
      }
      if (seen.has(model)) continue;
      seen.add(model);
      mixtureDefault.push(model);
    }
  }

  const cfg: V3Config = { priority, models };
  if (mixtureDefault.length > 0) {
    (cfg as { mixture_default?: readonly string[] }).mixture_default = mixtureDefault;
  }
  return { config: cfg, warnings };
}

function buildSubscriptionRoute(
  name: string,
  svc: ServiceConfig,
  disabled: Set<string>,
): V3SubscriptionRoute {
  const route: V3SubscriptionRoute = {
    harness: svc.harness ?? name,
  };
  // cli_model maps to cli_model_override only when it differs from the
  // canonical model. In v0.3 we don't surface a cli_model field at all when
  // canonical = CLI flag.
  if (svc.cliModel && svc.cliModel !== svc.model) {
    route.cli_model_override = svc.cliModel;
  }
  if (svc.command) route.command = svc.command;
  if (disabled.has(name) || svc.enabled === false) route.enabled = false;
  if (svc.genericCli) route.generic_cli = svc.genericCli;
  return route;
}

function buildMeteredRoute(svc: ServiceConfig, disabled: Set<string>): V3MeteredRoute {
  const route: V3MeteredRoute = {
    base_url: svc.baseUrl ?? "",
  };
  if (svc.apiKey) route.api_key = svc.apiKey;
  if (svc.cliModel && svc.cliModel !== svc.model) {
    route.cli_model_override = svc.cliModel;
  }
  if (svc.enabled === false || (svc.name && disabled.has(svc.name))) {
    route.enabled = false;
  }
  return route;
}

// ---------------------------------------------------------------------------
// YAML rendering for the migrator's output
// ---------------------------------------------------------------------------

import yaml from "js-yaml";

/** Serialize a V3Config to YAML text suitable for writing to disk. */
export function renderV3Yaml(cfg: V3Config): string {
  // Build a plain object in deterministic key order for clean diffs.
  const root: Record<string, unknown> = {
    priority: cfg.priority,
    models: serializeModels(cfg.models),
  };
  if (cfg.mixture_default && cfg.mixture_default.length > 0) {
    root.mixture_default = cfg.mixture_default;
  }
  if (cfg.http) root.http = cfg.http;
  return yaml.dump(root, { lineWidth: 100, noRefs: true });
}

function serializeModels(models: Readonly<Record<string, V3ModelEntry>>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(models)) {
    const block: Record<string, unknown> = {};
    if (entry.subscription) {
      const sub: Record<string, unknown> = { harness: entry.subscription.harness };
      if (entry.subscription.command) sub.command = entry.subscription.command;
      if (entry.subscription.cli_model_override) {
        sub.cli_model_override = entry.subscription.cli_model_override;
      }
      if (entry.subscription.enabled === false) sub.enabled = false;
      if (entry.subscription.generic_cli) sub.generic_cli = entry.subscription.generic_cli;
      block.subscription = sub;
    }
    if (entry.metered) {
      const met: Record<string, unknown> = { base_url: entry.metered.base_url };
      if (entry.metered.api_key) met.api_key = entry.metered.api_key;
      if (entry.metered.cli_model_override) {
        met.cli_model_override = entry.metered.cli_model_override;
      }
      if (entry.metered.enabled === false) met.enabled = false;
      block.metered = met;
    }
    out[key] = block;
  }
  return out;
}
