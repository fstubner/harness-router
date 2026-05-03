/**
 * Core types for harness-router-mcp.
 *
 * Cross-cutting types used by dispatchers, the router, the quota tracker,
 * and the MCP surface.
 */

export type ThinkingLevel = "low" | "medium" | "high";

export interface DispatchResult {
  output: string;
  service: string;
  success: boolean;
  error?: string;
  rateLimited?: boolean;
  retryAfter?: number;
  rateLimitHeaders?: Record<string, string>;
  durationMs?: number;
  tokensUsed?: { input: number; output: number };
}

export interface QuotaInfo {
  service: string;
  used?: number;
  limit?: number;
  remaining?: number;
  resetAt?: string;
  source: "headers" | "api" | "unknown";
}

/**
 * Recipe for a YAML-defined CLI dispatcher (`type: generic_cli`).
 *
 * Lets users add new AI tools without writing a TypeScript dispatcher: the
 * router treats the CLI as a black box that takes a prompt and writes the
 * agent's response to stdout. The recipe describes how to assemble the
 * argv and (optionally) how to extract structured output.
 */
export type PromptDelivery = "positional" | "flag" | "stdin";

export interface GenericCliRecipe {
  argsBeforePrompt?: string[];
  argsAfterPrompt?: string[];
  modelFlag?: string;
  cwdFlag?: string;
  promptDelivery?: PromptDelivery;
  promptFlag?: string;
  argsPerFile?: string[];
  forwardEnv?: string[];
  outputJsonPath?: string;
  tokensJsonPath?: string;
  outputJsonl?: {
    textDeltaPath: string;
    toolNamePath?: string;
    toolInputPath?: string;
    thinkingPath?: string;
    tokensPath?: string;
  };
  authCommand?: string;
}

/**
 * Cost tier for a route. Subscription = zero marginal cost (you've already
 * paid the flat fee, e.g. Claude Pro). Metered = per-token cost (e.g. raw
 * Anthropic API). The router walks subscription before metered for each
 * model in the priority list.
 */
export type RouteTier = "subscription" | "metered";

export interface ServiceConfig {
  name: string;
  enabled: boolean;
  type: "cli" | "openai_compatible" | "generic_cli";
  harness?: string;
  command?: string;
  apiKey?: string;
  baseUrl?: string;
  /**
   * Canonical model ID this service serves. Used by the router to match
   * services against the user's `modelPriority` list — the strings here
   * and in `modelPriority` must agree literally for routing to work.
   *
   * Pick whatever convention you want (semantic versions, dates, aliases),
   * just keep it consistent.
   */
  model?: string;
  /**
   * What to actually pass to the underlying CLI's `--model` flag at dispatch
   * time. Defaults to `model` when absent. Use this when the canonical name
   * you want for routing differs from what the CLI accepts.
   *
   * Example: route under "claude-opus-4-7" canonically, but Claude Code's
   * CLI expects the alias "opus":
   *
   *   model:     claude-opus-4-7
   *   cli_model: opus
   *
   * Different services can serve the same canonical model with different
   * CLI names (e.g. claude_code wants "opus", cursor wants
   * "claude-3-opus-thinking-max"). This field is the join.
   */
  cliModel?: string;
  /**
   * Cost tier. Defaults to "subscription" when omitted (the common case
   * for CLI services backed by paid subscriptions).
   */
  tier?: RouteTier;
  thinkingLevel?: ThinkingLevel;
  /** Recipe for `type: generic_cli` services. */
  genericCli?: GenericCliRecipe;
  /** Maximum output tokens the model can produce in a single dispatch. */
  maxOutputTokens?: number;
  /** Context window in tokens (input + output). */
  maxInputTokens?: number;
}

export interface RouterConfig {
  services: Record<string, ServiceConfig>;
  /**
   * Ordered list of model IDs, highest priority first. The router walks
   * this list to find a usable route per dispatch. When omitted, every
   * service's `model` is treated as priority-1 in declaration order.
   */
  modelPriority?: readonly string[];
  geminiApiKey?: string;
  disabled?: readonly string[];
}

export interface RoutingDecision {
  /** The picked model ID (e.g. "claude-opus-4.7"). */
  model: string;
  /** The dispatcher service name that will deliver it. */
  service: string;
  /** Cost tier of the picked route. */
  tier: RouteTier;
  /** 0..1 — higher means more headroom on this CLI. */
  quotaScore: number;
  /** Human-readable trace ("model=X tier=subscription svc=Y quota=0.83 / 3 candidates"). */
  reason: string;
}

export interface RouteHints {
  /** Force a specific service (bypasses priority walk). */
  service?: string;
  /** Bump a specific model to the front of the priority list. */
  model?: string;
}

export type DispatcherEvent =
  | { type: "stdout"; chunk: string }
  | { type: "stderr"; chunk: string }
  | { type: "tool_use"; name: string; input: unknown }
  | { type: "thinking"; chunk: string }
  | { type: "completion"; result: DispatchResult }
  | { type: "error"; error: string };
