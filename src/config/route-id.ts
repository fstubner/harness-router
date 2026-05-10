/**
 * Synthetic service-id derivation, shared between Router and the
 * dispatcher factory.
 *
 * IDs follow `${model}::${routeKey}`:
 *   opus::claude_code               — opus served by claude_code subscription
 *   opus::cursor                    — opus served by cursor subscription
 *   opus::api.anthropic.com         — opus served by Anthropic API metered
 *   opus::localhost:11434           — opus served by local Ollama metered
 *
 * The format is deliberately debuggable rather than positional — log lines,
 * dashboard rows, breaker error messages, and OTel span attributes all
 * carry these strings, so "what tripped" is human-readable without an extra
 * lookup.
 *
 * Quota cache and circuit breakers key by these strings opaquely.
 */

import type { MeteredRoute } from "./types.js";

const SEPARATOR = "::";

export function syntheticServiceId(model: string, routeKey: string): string {
  return `${model}${SEPARATOR}${routeKey}`;
}

/**
 * Disambiguator for a metered route — the URL hostname (with port if
 * present). Falls back to a generic "metered" tag when the URL doesn't
 * parse (parser validation should prevent that, but we'd rather emit
 * something usable than throw mid-derivation).
 */
export function meteredRouteKey(route: MeteredRoute): string {
  try {
    return new URL(route.base_url).host;
  } catch {
    return "metered";
  }
}

/**
 * Resolve collisions when two routes for the same model would produce the
 * same disambiguator. Rare — typically only when a user lists the same
 * harness twice for one model, or two metered routes share a hostname.
 * Caller passes a `seen` Set; this function appends `#1`, `#2`, … on
 * collision.
 */
export function ensureUniqueRouteId(seen: Set<string>, candidate: string): string {
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
