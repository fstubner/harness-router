/**
 * Config → RouterConfig adapter.
 *
 * The router / dispatchers / quota layer consumes a flat `RouterConfig`
 * (services-keyed, in `src/types.ts`). The on-disk schema (`./types.ts`)
 * is model-keyed with arrays of routes per (model, tier). This adapter
 * generates the runtime view from a Config.
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
 * format (rather than positional indices) means logs, dashboards, and
 * breaker error messages tell you which underlying CLI or provider tripped
 * without an extra lookup.
 *
 * Pure function. No I/O.
 */

import type { RouterConfig, ServiceConfig } from "../types.js";
import type { Config, MeteredRoute, SubscriptionRoute } from "./types.js";
import { ensureUniqueRouteId, meteredRouteKey, syntheticServiceId } from "./route-id.js";

// Re-export so callers that imported from adapter.ts continue to work.
export { syntheticServiceId };

export function toRouterConfig(cfg: Config): RouterConfig {
  const services: Record<string, ServiceConfig> = {};
  const disabled: string[] = [];
  // Keep per-model service ids so mixture_default expansion below can
  // reference exactly the ones we emitted.
  const idsByModel: Map<string, string[]> = new Map();

  for (const [model, entry] of Object.entries(cfg.models)) {
    const seen = new Set<string>();
    const ids: string[] = [];
    for (const route of entry.subscription ?? []) {
      const id = ensureUniqueRouteId(seen, syntheticServiceId(model, route.harness));
      services[id] = subscriptionToService(id, model, route);
      if (route.enabled === false) disabled.push(id);
      ids.push(id);
    }
    for (const route of entry.metered ?? []) {
      const id = ensureUniqueRouteId(seen, syntheticServiceId(model, meteredRouteKey(route)));
      services[id] = meteredToService(id, model, route);
      if (route.enabled === false) disabled.push(id);
      ids.push(id);
    }
    if (ids.length > 0) idsByModel.set(model, ids);
  }

  const routerCfg: RouterConfig = {
    services,
    modelPriority: cfg.priority,
  };
  if (disabled.length > 0) routerCfg.disabled = disabled;
  if (cfg.mixture_default && cfg.mixture_default.length > 0) {
    // Each model key in mixture_default expands to ALL of its synthetic
    // service ids — both subscription and metered tiers, all routes per
    // tier. The router then filters to whichever are usable at dispatch
    // time.
    const expanded: string[] = [];
    for (const model of cfg.mixture_default) {
      for (const id of idsByModel.get(model) ?? []) expanded.push(id);
    }
    if (expanded.length > 0) routerCfg.mixtureDefault = expanded;
  }
  return routerCfg;
}

function subscriptionToService(id: string, model: string, route: SubscriptionRoute): ServiceConfig {
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

function meteredToService(id: string, model: string, route: MeteredRoute): ServiceConfig {
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
