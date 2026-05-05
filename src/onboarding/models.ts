/**
 * Per-CLI model catalog used by the onboard wizard.
 *
 * Most agentic CLIs (Claude, Codex, Gemini, opencode, Copilot) expose model
 * selection only through *interactive* pickers (`/model` slash commands),
 * with no "list models" subcommand we can shell out to. So we ship a
 * hardcoded catalog keyed by harness id, sourced from each provider's
 * official 2026 docs (the same research that backs the per-CLI table in
 * the README).
 *
 * Each entry pairs a *canonical* name (used by the router for matching
 * against `model_priority`) with the *cli_model* string the CLI actually
 * accepts as `--model`. Aliases ("opus", "pro", "auto") roll forward to
 * the latest version from the provider's side; full IDs ("claude-opus-4-7",
 * "gpt-5.4") pin to a specific release.
 *
 * The wizard treats this catalog as a starting point — users can also type
 * a free-form name when their CLI accepts something we haven't catalogued.
 */

export interface ModelCatalogEntry {
  /** Canonical name for routing (matches `modelPriority` entries). */
  canonical: string;
  /** What the CLI accepts via `--model`. Defaults to canonical when same. */
  cliModel: string;
  /** Short user-facing description shown in the picker. */
  description: string;
  /** True when this is an alias that auto-rolls vs a pinned full ID. */
  alias: boolean;
}

export const MODEL_CATALOG: Record<string, ModelCatalogEntry[]> = {
  claude_code: [
    { canonical: "opus", cliModel: "opus", description: "Latest Opus (alias)", alias: true },
    { canonical: "sonnet", cliModel: "sonnet", description: "Latest Sonnet (alias)", alias: true },
    { canonical: "haiku", cliModel: "haiku", description: "Latest Haiku (alias)", alias: true },
    {
      canonical: "claude-opus-4-7",
      cliModel: "claude-opus-4-7",
      description: "Opus 4.7 (pinned)",
      alias: false,
    },
    {
      canonical: "claude-sonnet-4-6",
      cliModel: "claude-sonnet-4-6",
      description: "Sonnet 4.6 (pinned)",
      alias: false,
    },
    {
      canonical: "claude-haiku-4-5",
      cliModel: "claude-haiku-4-5",
      description: "Haiku 4.5 (pinned)",
      alias: false,
    },
    {
      canonical: "opusplan",
      cliModel: "opusplan",
      description: "Opus for plan, Sonnet for execution (alias)",
      alias: true,
    },
  ],
  codex: [
    {
      canonical: "gpt-5.5",
      cliModel: "gpt-5.5",
      description: "GPT-5.5 (frontier; ChatGPT auth only)",
      alias: false,
    },
    {
      canonical: "gpt-5.4",
      cliModel: "gpt-5.4",
      description: "GPT-5.4 (flagship)",
      alias: false,
    },
    {
      canonical: "gpt-5.4-mini",
      cliModel: "gpt-5.4-mini",
      description: "GPT-5.4 mini (fast)",
      alias: false,
    },
    {
      canonical: "gpt-5.3-codex",
      cliModel: "gpt-5.3-codex",
      description: "GPT-5.3 codex (coding-specialised)",
      alias: false,
    },
    {
      canonical: "gpt-5.3-codex-spark",
      cliModel: "gpt-5.3-codex-spark",
      description: "GPT-5.3 codex spark (real-time iter)",
      alias: false,
    },
  ],
  cursor: [
    { canonical: "Auto", cliModel: "Auto", description: "Cursor's auto-selector", alias: true },
    { canonical: "Composer 2", cliModel: "Composer 2", description: "Composer 2", alias: false },
    { canonical: "Opus 4.6", cliModel: "Opus 4.6", description: "Opus 4.6", alias: false },
    {
      canonical: "Codex 5.3 High Fast",
      cliModel: "Codex 5.3 High Fast",
      description: "Codex 5.3 High Fast",
      alias: false,
    },
    {
      canonical: "Gemini 3 Pro",
      cliModel: "Gemini 3 Pro",
      description: "Gemini 3 Pro",
      alias: false,
    },
    { canonical: "Grok", cliModel: "Grok", description: "Grok", alias: false },
  ],
  gemini_cli: [
    { canonical: "auto", cliModel: "auto", description: "Auto-selector (alias)", alias: true },
    { canonical: "pro", cliModel: "pro", description: "Latest Pro (alias)", alias: true },
    { canonical: "flash", cliModel: "flash", description: "Latest Flash (alias)", alias: true },
    {
      canonical: "flash-lite",
      cliModel: "flash-lite",
      description: "Flash Lite (alias)",
      alias: true,
    },
    {
      canonical: "gemini-2.5-pro",
      cliModel: "gemini-2.5-pro",
      description: "Gemini 2.5 Pro (pinned)",
      alias: false,
    },
    {
      canonical: "gemini-3-pro-preview",
      cliModel: "gemini-3-pro-preview",
      description: "Gemini 3 Pro Preview",
      alias: false,
    },
    {
      canonical: "gemini-2.5-flash",
      cliModel: "gemini-2.5-flash",
      description: "Gemini 2.5 Flash (pinned)",
      alias: false,
    },
  ],
  opencode: [
    {
      canonical: "anthropic/claude-sonnet-4-20250514",
      cliModel: "anthropic/claude-sonnet-4-20250514",
      description: "Anthropic Sonnet via opencode",
      alias: false,
    },
    {
      canonical: "openai/gpt-5",
      cliModel: "openai/gpt-5",
      description: "OpenAI GPT-5 via opencode",
      alias: false,
    },
    {
      canonical: "opencode/gpt-5.1-codex",
      cliModel: "opencode/gpt-5.1-codex",
      description: "OpenCode-Zen GPT-5.1 codex",
      alias: false,
    },
    // OpenCode supports many more via `provider/model` form — user can free-type.
  ],
  copilot: [
    {
      canonical: "auto",
      cliModel: "auto",
      description: "Copilot auto-selector (subscription policy decides)",
      alias: true,
    },
    {
      canonical: "claude-sonnet-4.5",
      cliModel: "claude-sonnet-4.5",
      description: "Claude Sonnet 4.5",
      alias: false,
    },
    { canonical: "gpt-5.4", cliModel: "gpt-5.4", description: "GPT-5.4", alias: false },
    {
      canonical: "gpt-5.3-codex",
      cliModel: "gpt-5.3-codex",
      description: "GPT-5.3 Codex",
      alias: false,
    },
  ],
};

/**
 * Aggregated catalog: returns one (canonical-model, served-by-harnesses) row
 * per unique canonical model across the wizard's selected harnesses. Used to
 * power the "select your priority" picker, where the user picks ONE row per
 * service and orders them. Multiple harnesses serving the same canonical
 * name are merged so the user sees "claude-sonnet-4-6 (claude_code, cursor)"
 * once instead of twice.
 */
export interface AggregatedModel {
  canonical: string;
  /** Harness ids that can serve this canonical model. */
  servedBy: string[];
  /** Any one description from the contributing harnesses. */
  description: string;
  /** True iff every contributing harness treats this as an alias. */
  alias: boolean;
}

export function aggregateCatalog(harnessIds: readonly string[]): AggregatedModel[] {
  const byCanonical = new Map<string, AggregatedModel>();
  for (const harness of harnessIds) {
    const entries = MODEL_CATALOG[harness] ?? [];
    for (const e of entries) {
      const existing = byCanonical.get(e.canonical);
      if (!existing) {
        byCanonical.set(e.canonical, {
          canonical: e.canonical,
          servedBy: [harness],
          description: e.description,
          alias: e.alias,
        });
      } else if (!existing.servedBy.includes(harness)) {
        existing.servedBy.push(harness);
        // Keep alias=true only when *every* contributor agrees it's an alias.
        existing.alias = existing.alias && e.alias;
      }
    }
  }
  return Array.from(byCanonical.values());
}

/**
 * Return the cli-specific name for a canonical model on a given harness, or
 * `undefined` when this harness can't serve that canonical. Used when the
 * wizard generates per-service `cli_model` entries.
 */
export function cliModelFor(harness: string, canonical: string): string | undefined {
  const entries = MODEL_CATALOG[harness] ?? [];
  return entries.find((e) => e.canonical === canonical)?.cliModel;
}

// ---------------------------------------------------------------------------
// Metered API providers — used by the wizard's metered-fallback step
// ---------------------------------------------------------------------------

/**
 * A metered API provider — typically billed per-token. The wizard offers to
 * add one `type: openai_compatible` service per (provider × matching
 * priority model) when the user has the corresponding env var set.
 *
 * `matchesCanonical` decides which canonical model names this provider can
 * serve. The match is intentionally generous — Anthropic's API can serve
 * any "claude-opus-X-Y" or "claude-sonnet-X-Y" name, plus the bare aliases
 * "opus" / "sonnet" / "haiku" — the API itself rejects unknown specifics.
 *
 * `cliModelFor` returns the API-specific name for a canonical. When absent,
 * we fall back to passing the canonical verbatim — the API will tell the
 * user if it doesn't recognise it.
 */
export interface MeteredProvider {
  id: string;
  displayName: string;
  envVar: string;
  baseUrl: string;
  /** Predicate: does this provider serve `canonical` model names? */
  matchesCanonical: (canonical: string) => boolean;
  /** Optional override map: canonical → API-specific model id. */
  cliModelFor: (canonical: string) => string | undefined;
}

const ANTHROPIC_PROVIDER: MeteredProvider = {
  id: "anthropic_api",
  displayName: "Anthropic API (Claude models)",
  envVar: "ANTHROPIC_API_KEY",
  baseUrl: "https://api.anthropic.com/v1",
  matchesCanonical: (c) =>
    c.toLowerCase().includes("claude") ||
    c === "opus" ||
    c === "sonnet" ||
    c === "haiku" ||
    c === "opusplan" ||
    c.startsWith("claude-"),
  cliModelFor: (c) => {
    // Anthropic's API expects full versioned IDs. Map known aliases.
    const map: Record<string, string> = {
      opus: "claude-opus-4-7",
      sonnet: "claude-sonnet-4-6",
      haiku: "claude-haiku-4-5",
      opusplan: "claude-opus-4-7", // Anthropic API has no "plan" alias; closest is opus
    };
    return map[c];
  },
};

const OPENAI_PROVIDER: MeteredProvider = {
  id: "openai_api",
  displayName: "OpenAI API (GPT models)",
  envVar: "OPENAI_API_KEY",
  baseUrl: "https://api.openai.com/v1",
  matchesCanonical: (c) =>
    c.toLowerCase().startsWith("gpt-") || c.toLowerCase().startsWith("o1-") || c === "gpt-auto",
  cliModelFor: (_c) => undefined, // Pass canonical verbatim — OpenAI's API names track the canonical
};

const GOOGLE_PROVIDER: MeteredProvider = {
  id: "google_api",
  displayName: "Google AI API (Gemini models)",
  envVar: "GEMINI_API_KEY",
  baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
  matchesCanonical: (c) =>
    c.toLowerCase().startsWith("gemini") ||
    c === "pro" ||
    c === "flash" ||
    c === "flash-lite" ||
    c === "auto",
  cliModelFor: (c) => {
    const map: Record<string, string> = {
      pro: "gemini-2.5-pro",
      flash: "gemini-2.5-flash",
      "flash-lite": "gemini-2.5-flash-lite",
      auto: "gemini-2.5-pro",
    };
    return map[c];
  },
};

export const METERED_PROVIDERS: readonly MeteredProvider[] = [
  ANTHROPIC_PROVIDER,
  OPENAI_PROVIDER,
  GOOGLE_PROVIDER,
];

/**
 * For a list of canonical model names, return per-provider matches: which
 * priority models each detected provider can serve. Empty providers are
 * dropped; the wizard only prompts about ones with at least one match.
 */
export interface ProviderMatches {
  provider: MeteredProvider;
  /** Canonical models from priority that this provider can serve. */
  models: readonly string[];
}

export function findProviderMatches(
  modelPriority: readonly string[],
  envFn: (name: string) => string | undefined = (n) => process.env[n],
): readonly ProviderMatches[] {
  const out: ProviderMatches[] = [];
  for (const provider of METERED_PROVIDERS) {
    if (!envFn(provider.envVar)) continue;
    const models = modelPriority.filter((m) => provider.matchesCanonical(m));
    if (models.length === 0) continue;
    out.push({ provider, models });
  }
  return out;
}
