/**
 * V3Config → YAML serializer.
 *
 * Used by the onboard wizard to write `~/.harness-router/config.yaml` after
 * the user confirms their picks. Pure function, no I/O.
 *
 * The serializer is shape-aware rather than handing js-yaml a generic
 * object: it walks the V3Config struct and emits keys in a deterministic
 * order (priority, models, mixture_default, http) so the resulting file
 * has clean diffs across re-runs of the wizard.
 */

import yaml from "js-yaml";

import type { V3Config, V3MeteredRoute, V3ModelEntry, V3SubscriptionRoute } from "./types.js";

/** Serialize a V3Config to YAML text suitable for writing to disk. */
export function renderV3Yaml(cfg: V3Config): string {
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
    if (entry.subscription && entry.subscription.length > 0) {
      block.subscription = entry.subscription.map(serializeSubscription);
    }
    if (entry.metered && entry.metered.length > 0) {
      block.metered = entry.metered.map(serializeMetered);
    }
    out[key] = block;
  }
  return out;
}

function serializeSubscription(route: V3SubscriptionRoute): Record<string, unknown> {
  const out: Record<string, unknown> = { harness: route.harness };
  if (route.command) out.command = route.command;
  if (route.cli_model_override) out.cli_model_override = route.cli_model_override;
  if (route.enabled === false) out.enabled = false;
  if (route.generic_cli) out.generic_cli = route.generic_cli;
  return out;
}

function serializeMetered(route: V3MeteredRoute): Record<string, unknown> {
  const out: Record<string, unknown> = { base_url: route.base_url };
  if (route.api_key) out.api_key = route.api_key;
  if (route.cli_model_override) out.cli_model_override = route.cli_model_override;
  if (route.enabled === false) out.enabled = false;
  return out;
}
