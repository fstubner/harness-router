/**
 * V3Config → RouterConfig adapter.
 *
 * The existing router / dispatchers / quota layer is built around the v0.2
 * `RouterConfig` shape (services keyed by name, tier as a field). v0.3
 * configs are model-keyed. This adapter generates a v0.2-shaped view from
 * a V3Config so the existing runtime can keep working unchanged while the
 * config schema is the new shape on disk.
 *
 * Synthetic service ids are produced as `${model}__${tier}` (double
 * underscore separator to avoid collision with model names that already
 * contain `_`). They never appear in user-facing config — they exist only
 * as internal handles the dispatcher factory and circuit breakers key on.
 *
 * Pure function. No I/O.
 */

import type { RouterConfig, ServiceConfig } from "../types.js";
import type { V3Config, V3MeteredRoute, V3ModelEntry, V3SubscriptionRoute } from "./types.js";

const SEPARATOR = "__";

/** Build the synthetic service id used internally by the router. */
export function syntheticServiceId(model: string, tier: "subscription" | "metered"): string {
  return `${model}${SEPARATOR}${tier}`;
}

/**
 * Reverse of {@link syntheticServiceId}. Returns null if the id doesn't
 * follow the synthetic convention.
 */
export function parseSyntheticServiceId(
  id: string,
): { model: string; tier: "subscription" | "metered" } | null {
  const idx = id.lastIndexOf(SEPARATOR);
  if (idx < 0) return null;
  const tier = id.slice(idx + SEPARATOR.length);
  if (tier !== "subscription" && tier !== "metered") return null;
  return { model: id.slice(0, idx), tier };
}

export function v3ToRouterConfig(v3: V3Config): RouterConfig {
  const services: Record<string, ServiceConfig> = {};
  const disabled: string[] = [];

  for (const [model, entry] of Object.entries(v3.models)) {
    if (entry.subscription) {
      const { id, svc, isDisabled } = subscriptionToService(model, entry.subscription);
      services[id] = svc;
      if (isDisabled) disabled.push(id);
    }
    if (entry.metered) {
      const { id, svc, isDisabled } = meteredToService(model, entry.metered);
      services[id] = svc;
      if (isDisabled) disabled.push(id);
    }
  }

  const cfg: RouterConfig = {
    services,
    modelPriority: v3.priority,
  };
  if (disabled.length > 0) cfg.disabled = disabled;
  if (v3.mixture_default && v3.mixture_default.length > 0) {
    // v0.2's mixtureDefault is service-name-keyed. v0.3's is model-keyed.
    // Translate by emitting both tiers' synthetic ids per chosen model.
    const expanded: string[] = [];
    for (const model of v3.mixture_default) {
      const entry = v3.models[model];
      if (!entry) continue;
      if (entry.subscription) expanded.push(syntheticServiceId(model, "subscription"));
      if (entry.metered) expanded.push(syntheticServiceId(model, "metered"));
    }
    if (expanded.length > 0) cfg.mixtureDefault = expanded;
  }
  return cfg;
}

function subscriptionToService(
  model: string,
  route: V3SubscriptionRoute,
): { id: string; svc: ServiceConfig; isDisabled: boolean } {
  const id = syntheticServiceId(model, "subscription");
  const svc: ServiceConfig = {
    name: id,
    enabled: route.enabled !== false,
    type: route.generic_cli ? "generic_cli" : "cli",
    harness: route.harness,
    model,
    tier: "subscription",
  };
  if (route.command) svc.command = route.command;
  if (route.cli_model_override) svc.cliModel = route.cli_model_override;
  if (route.generic_cli) svc.genericCli = route.generic_cli;
  return { id, svc, isDisabled: route.enabled === false };
}

function meteredToService(
  model: string,
  route: V3MeteredRoute,
): { id: string; svc: ServiceConfig; isDisabled: boolean } {
  const id = syntheticServiceId(model, "metered");
  const svc: ServiceConfig = {
    name: id,
    enabled: route.enabled !== false,
    type: "openai_compatible",
    baseUrl: route.base_url,
    model,
    tier: "metered",
  };
  if (route.api_key) svc.apiKey = route.api_key;
  if (route.cli_model_override) svc.cliModel = route.cli_model_override;
  return { id, svc, isDisabled: route.enabled === false };
}

// Re-exports for the v3 module index to surface a single import point.
export type { V3Config, V3ModelEntry, V3SubscriptionRoute, V3MeteredRoute };
