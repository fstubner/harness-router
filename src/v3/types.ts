/**
 * v0.3 config schema — model-keyed.
 *
 * The big shift from v0.2: services are no longer the primary key. Models are.
 * A model entry has up to two routes (subscription tier and metered tier);
 * the router walks `priority`, asks each entry which routes are usable, and
 * picks the best one.
 *
 * Why this matters:
 *   - The user thinks "I want opus, falling back to gpt-5.4" — model names,
 *     not service names.
 *   - `mixture_default` becomes `[opus, gpt-5.4]` instead of
 *     `[claude_code, anthropic_api_opus]`.
 *   - The `tier` field disappears — it's structural now (which key the route
 *     lives under).
 *   - There are no auto-generated service names like `anthropic_api_opus`.
 *
 * The internal `RouterConfig` (v0.2 shape) is still produced by an adapter so
 * the router/dispatchers/quota layer can keep working unchanged. The adapter
 * derives synthetic service ids of the form `${model}::${tier}` only as
 * internal handles — they never appear in user-facing YAML.
 */

import type { GenericCliRecipe } from "../types.js";

// ---------------------------------------------------------------------------
// Public schema
// ---------------------------------------------------------------------------

/**
 * Subscription route: a CLI on PATH that the user has already paid for via
 * a flat-rate subscription. The router prefers these — zero marginal cost.
 *
 * `harness` matches one of the supported harness ids (claude_code, codex,
 * cursor, gemini_cli, opencode, copilot) OR is a free-form string when paired
 * with a `generic_cli` recipe (extension point for third-party CLIs).
 *
 * `cli_model_override` is rare — only set when the canonical model name in
 * the parent entry's key differs from what the CLI accepts via `--model`.
 * In v0.3 we strongly recommend using pinned IDs everywhere (e.g.
 * `claude-opus-4-7` not `opus`) so this stays unset in the common case.
 */
export interface V3SubscriptionRoute {
  harness: string;
  /** Override what's passed to `--model`. Defaults to the parent model key. */
  cli_model_override?: string;
  /** Recipe for `generic_cli`-typed harnesses. Optional otherwise. */
  generic_cli?: GenericCliRecipe;
  /** Path to the CLI binary. Auto-resolved via PATH when absent. */
  command?: string;
  /** Per-route disable. Defaults to true. */
  enabled?: boolean;
}

/**
 * Metered route: a paid-per-token API endpoint speaking the OpenAI
 * Chat-Completions protocol. Anthropic, OpenAI, Google AI, plus any
 * local OpenAI-compatible server (Ollama, vLLM, llama.cpp, LM Studio).
 *
 * `api_key` is typically `${ENV_VAR}` — the loader resolves it at startup.
 * Never write a literal key into config.yaml; the wizard never does.
 */
export interface V3MeteredRoute {
  base_url: string;
  api_key?: string;
  /** Override the model id sent to the endpoint. Defaults to parent key. */
  cli_model_override?: string;
  enabled?: boolean;
}

/**
 * One canonical model and its routes. Either subscription, metered, or
 * both. A model with neither route is invalid — the loader rejects it.
 */
export interface V3ModelEntry {
  subscription?: V3SubscriptionRoute;
  metered?: V3MeteredRoute;
}

/**
 * Top-level config shape.
 *
 * `priority` lists model keys in routing order. Every entry must exist in
 * `models`; the loader rejects priority-with-no-matching-model entries.
 *
 * `mixture_default` is the default candidate set for fan-out comparisons.
 * Same constraint: every entry must exist in `models`. Empty/absent means
 * "every available model" (the historical fan-out default).
 *
 * `http` is the optional HTTP transport config. When absent, only stdio
 * is exposed. When `http.bind` is non-loopback, `http.auth.required` is
 * forced true regardless of the user's setting.
 */
export interface V3Config {
  priority: readonly string[];
  models: Readonly<Record<string, V3ModelEntry>>;
  mixture_default?: readonly string[];
  http?: V3HttpConfig;
}

export interface V3HttpConfig {
  /** Address to bind. Defaults to "127.0.0.1". */
  bind?: string;
  /** Port. Defaults to 8765. */
  port?: number;
  auth?: {
    /** When true, require Authorization: Bearer <token>. Loopback always exempt. */
    required?: boolean;
    /** Path to the token file. Defaults to ~/.harness-router/auth.token. */
    token_file?: string;
  };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Errors collected during config validation. The loader collects all errors
 * before throwing so the user sees every problem in one shot, not one at a
 * time as they fix and re-run.
 */
export class V3ConfigError extends Error {
  constructor(
    message: string,
    public readonly issues: readonly V3Issue[],
  ) {
    super(message);
    this.name = "V3ConfigError";
  }
}

export interface V3Issue {
  /** Dotted path into the config: `models.opus.subscription.harness`. */
  path: string;
  message: string;
}
