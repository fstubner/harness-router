/**
 * Core types for harness-router-mcp.
 *
 * These are the cross-cutting types used by dispatchers, the router, the
 * quota tracker, and the MCP surface. Downstream modules (R2/R3/R4) import
 * from here.
 */

export type TaskType = "execute" | "plan" | "review" | "local" | "";

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
 *
 * Mandatory: `command` (which the router resolves via `which`).
 *
 * Argv assembly (in order, each step skipped when its prerequisite is empty):
 *   1. `argsBeforePrompt`
 *   2. `[modelFlag, <model>]`            — if both are set
 *   3. `[cwdFlag, <workingDir>]`         — if both are set
 *   4. PROMPT — see `promptDelivery` below
 *   5. `argsAfterPrompt`
 *
 * Prompt delivery modes:
 *   - "positional" (default): prompt becomes one positional argv entry
 *   - "flag":                 prompt becomes `[promptFlag, <text>]`
 *   - "stdin":                prompt is written to the child's stdin (no
 *                             argv entry; child reads until EOF)
 */
export type PromptDelivery = "positional" | "flag" | "stdin";

export interface GenericCliRecipe {
  /** Args that come BEFORE the prompt slot. Default: []. */
  argsBeforePrompt?: string[];
  /** Args that come AFTER the prompt slot. Default: []. */
  argsAfterPrompt?: string[];
  /** When set, append `[modelFlag, <model>]` if a model is configured/overridden. */
  modelFlag?: string;
  /** When set, append `[cwdFlag, <workingDir>]`. The subprocess's `cwd` is set regardless. */
  cwdFlag?: string;
  /**
   * How the prompt is delivered to the child. Default: `"positional"`.
   * Set to `"flag"` and provide `promptFlag` for `[--prompt, "text"]`.
   * Set to `"stdin"` to feed the prompt on stdin.
   */
  promptDelivery?: PromptDelivery;
  /** Required when `promptDelivery === "flag"`. Ignored otherwise. */
  promptFlag?: string;
  /**
   * Per-file flag template. When set AND `files.length > 0`, this template
   * is expanded once per input file and emitted between argsBeforePrompt
   * and the model/cwd flags. The literal `{path}` token in any entry is
   * replaced with the file's path; entries without `{path}` are emitted
   * verbatim (useful for paired-flag idioms like `[--file, {path}]`).
   *
   * When set, the dispatcher does NOT append the "Files to work with: …"
   * block to the prompt — files travel via argv instead of prompt text.
   *
   * Examples:
   *   `argsPerFile: ["--file", "{path}"]` → `--file a.ts --file b.ts`
   *   `argsPerFile: ["{path}"]`            → `a.ts b.ts` (positional list)
   *   `argsPerFile: ["--input={path}"]`    → `--input=a.ts --input=b.ts`
   */
  argsPerFile?: string[];
  /** Env vars to forward from the host process to the subprocess if set. */
  forwardEnv?: string[];
  /**
   * Optional dotted JSON path to extract response text from stdout. When
   * absent, stdout is treated as plain text. Example: `"result"` or
   * `"choices.0.message.content"`.
   *
   * Mutually exclusive with `outputJsonl` — set one or the other (or
   * neither, for plain-text CLIs).
   */
  outputJsonPath?: string;
  /**
   * Optional dotted JSON path to a token-usage object. Recognised shapes:
   *   `{ input, output }`, `{ input_tokens, output_tokens }`,
   *   `{ prompt_tokens, completion_tokens }`. Only used when `outputJsonPath`
   *   is set (the dispatcher only parses JSON when explicitly told to).
   */
  tokensJsonPath?: string;
  /**
   * Newline-delimited JSON streaming output mode. When set, stdout is
   * expected to be a JSONL stream — one JSON object per line, emitted as
   * the agent works. Each parsed event is interpreted via the dotted-path
   * fields below; the final completion's `output` is the concatenation of
   * every text delta seen during the stream.
   *
   * This is the path codex/cursor use natively — generic_cli services with
   * a similar protocol can opt in here without writing a dispatcher.
   *
   * Mutually exclusive with `outputJsonPath`.
   */
  outputJsonl?: {
    /**
     * Dotted path that, when non-empty on a parsed event, contributes a
     * text delta to the final response. Example: `"delta.content"`,
     * `"item.text"`. Each non-empty hit is also emitted as a `stdout`
     * dispatcher event so callers see the response stream live.
     */
    textDeltaPath: string;
    /**
     * Optional dotted path whose presence (any truthy value) marks the
     * event as a `tool_use` to be emitted live. The path's value becomes
     * the tool name. Example: `"tool_call.name"`.
     */
    toolNamePath?: string;
    /** Companion to `toolNamePath` — input object for the tool_use event. */
    toolInputPath?: string;
    /**
     * Optional dotted path whose presence marks the event as a `thinking`
     * chunk to be emitted live. Example: `"thinking.text"`.
     */
    thinkingPath?: string;
    /**
     * Optional dotted path to a usage/tokens object on the final or any
     * event. Recognised shapes mirror `tokensJsonPath`.
     */
    tokensPath?: string;
  };
  /**
   * Suggested re-auth command for failed verifies (`<command> auth login` etc.).
   * Surfaced by `harness-router-mcp init` as the `→ auth: …` CTA when the
   * verify error is classified as auth-related. Generic_cli services now
   * appear in the per-harness checklist alongside the 6 built-in harnesses
   * (via `loadGenericCliSpecs()` in onboarding.ts).
   */
  authCommand?: string;
}

export interface ServiceConfig {
  name: string;
  enabled: boolean;
  type: "cli" | "openai_compatible" | "generic_cli";
  harness?: string;
  command?: string;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  tier: number;
  weight: number;
  cliCapability: number;
  leaderboardModel?: string;
  thinkingLevel?: ThinkingLevel;
  escalateModel?: string;
  escalateOn: TaskType[];
  capabilities: Partial<Record<"execute" | "plan" | "review", number>>;
  /**
   * Recipe for `type: generic_cli` services. Ignored for built-in `cli`
   * harnesses (which have hand-tuned dispatchers) and `openai_compatible`
   * (HTTP transport).
   */
  genericCli?: GenericCliRecipe;
  /**
   * Maximum output tokens the model can produce in a single dispatch.
   * Callers (Planners, Workers, Reconcilers) use this to size work so it fits
   * without mid-call truncation. A value of `undefined` means "unknown /
   * assume the provider default" — callers that need to chunk conservatively
   * should treat absence as a low bound.
   */
  maxOutputTokens?: number;
  /**
   * Context window (input + output) in tokens. Used by the
   * `preferLargeContext` route hint and by planners sizing up prompt payloads.
   * Advertised by the provider; may be model-specific when `escalateModel` is
   * in effect — consult the resolved model at dispatch time.
   */
  maxInputTokens?: number;
}

export interface RouterConfig {
  services: Record<string, ServiceConfig>;
  geminiApiKey?: string;
  disabled?: readonly string[];
}

export interface RoutingDecision {
  service: string;
  tier: number;
  quotaScore: number;
  qualityScore: number;
  cliCapability: number;
  capabilityScore: number;
  taskType: TaskType;
  model: string | undefined;
  elo: number | undefined;
  finalScore: number;
  reason: string;
}

export interface RouteHints {
  service?: string;
  preferLargeContext?: boolean;
  taskType?: TaskType;
  harness?: string;
}

export type DispatcherEvent =
  | { type: "stdout"; chunk: string }
  | { type: "stderr"; chunk: string }
  | { type: "tool_use"; name: string; input: unknown }
  | { type: "thinking"; chunk: string }
  | { type: "completion"; result: DispatchResult }
  | { type: "error"; error: string };
