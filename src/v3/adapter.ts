/**
 * V3Config → RouterConfig adapter.
 *
 * The existing router / dispatchers / quota layer is built around the v0.2
 * `RouterConfig` shape (services keyed by name, tier as a field). v0.3
 * configs are model-keyed with arrays of routes per (model, tier). This
 * adapter generates a v0.2-shaped view from a V3Config so the existing
 * runtime can keep working unchanged while the config schema is the new
 * shape on disk.
 *
 * Synthetic service ids follow `${model}::${routeKey}`:
 *
 *   opus::claude_code               — opus served by claude_code subscription
 *   opus::cursor                    — opus served by cursor subscription
 *   opus::api.anthropic.com         — opus served by Anthropic API metered
 *   opus::api.openai.com            — opus served by OpenAI metered
 *
 * They never appear in user-facing config — they're internal handles the
 * dispatcher factory and circuit breakers key on. Choosing a debuggable
 * format (rather than positional indices like `opus::sub::0`) means logs,
 * dashboards, and breaker error messages tell you which underlying CLI or
 * provider tripped without an extra lookup.
 *
 * Pure function. No I/O.
 */

import type { RouterConfig, ServiceConfig } from "../types.js";
import type { V3Config, V3MeteredRoute, V3ModelEntry, V3SubscriptionRoute } from "./types.js";

const SEPARATOR = "::";

/** Build the synthetic service id used internally by the router. */
export function syntheticServiceId(model: string, routeKey: string): string {
  return `${model}${SEPARATOR}${routeKey}`;
}

/**
 * Disambiguator for a metered route — extract the hostname from the
 * `base_url`. Falls back to a generic "metered" tag when the URL doesn't
 * parse (loader's validation should prevent that, but we'd rather emit
 * something usable than throw mid-adapter).
 */
function meteredRouteKey(route: V3MeteredRoute): string {
  try {
    return new URL(route.base_url).host;
  } catch {
    return "metered";
  }
}

/**
 * Resolve collisions when two routes for the same (model, tier) would
 * produce the same disambiguator. Rare — typically only happens when a
 * user lists the same harness twice for one model, or two metered routes
 * with the same hostname. We append `#${index}` to break the tie.
 */
function ensureUnique(seen: Set<string>, candidate: string): string {
  if (!seen.has(candidate)) {
    seen.add(candidate);
    return candidate;
  }
  let i = 1;
  while (seen.has(`${candidate}#${i}`)) i++;
  const out = `${candidate}#${i}`;
  seen.add(out);
  return out;
}

export function v3ToRouterConfig(v3: V3Config): RouterConfig {
  const services: Record<string, ServiceConfig> = {};
  const disabled: string[] = [];
  // Keep per-model service ids so mixture_default expansion below can
  // reference exactly the ones we emitted.
  const idsByModel: Map<string, string[]> = new Map();

  for (const [model, entry] of Object.entries(v3.models)) {
    const seen = new Set<string>();
    const ids: string[] = [];
    for (const route of entry.subscription ?? []) {
      const id = ensureUnique(seen, syntheticServiceId(model, route.harness));
      services[id] = subscriptionToService(id, model, route);
      if (route.enabled === false) disabled.push(id);
      ids.push(id);
    }
    for (const route of entry.metered ?? []) {
      const id = ensureUnique(seen, syntheticServiceId(model, meteredRouteKey(route)));
      services[id] = meteredToService(id, model, route);
      if (route.enabled === false) disabled.push(id);
      ids.push(id);
    }
    if (ids.length > 0) idsByModel.set(model, ids);
  }

  const cfg: RouterConfig = {
    services,
    modelPriority: v3.priority,
  };
  if (disabled.length > 0) cfg.disabled = disabled;
  if (v3.mixture_default && v3.mixture_default.length > 0) {
    // Each model key in mixture_default expands to ALL of its synthetic
    // service ids — both subscription and metered tiers, all routes per
    // tier. The router then filters to whichever are usable at dispatch
    // time.
    const expanded: string[] = [];
    for (const model of v3.mixture_default) {
      for (const id of idsByModel.get(model) ?? []) expanded.push(id);
    }
    if (expanded.length > 0) cfg.mixtureDefault = expanded;
  }
  return cfg;
}

function subscriptionToService(
  id: string,
  model: string,
  route: V3SubscriptionRoute,
): ServiceConfig {
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
  return svc;
}

function meteredToService(id: string, model: string, route: V3MeteredRoute): ServiceConfig {
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
  return svc;
}

// Re-exports for the v3 module index to surface a single import point.
export type { V3Config, V3ModelEntry, V3SubscriptionRoute, V3MeteredRoute };
