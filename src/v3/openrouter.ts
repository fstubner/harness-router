/**
 * OpenRouter catalog client.
 *
 * Fetches the unauthenticated `/api/v1/models` endpoint and produces a flat
 * list of (canonical_name, provider, context_window) tuples for the wizard.
 *
 * OpenRouter prefixes model ids with the provider slug
 * (e.g. `anthropic/claude-opus-4.7`, `openai/gpt-5.4`, `google/gemini-2.5-pro`).
 * For our purposes the canonical name is the part *after* the slash —
 * matching what the CLIs accept via `--model` and what each provider's
 * own API expects.
 *
 * We filter to the three providers we actually support as metered routes
 * (Anthropic / OpenAI / Google) and ignore the long tail. Free-text input
 * remains available for any model OpenRouter doesn't list (local models,
 * niche providers, brand-new releases that haven't been indexed yet).
 *
 * Failure mode: any network/parse error returns an empty list. Callers
 * fall through to free-text input. The catalog is convenience, not gate.
 */

const OPENROUTER_URL = "https://openrouter.ai/api/v1/models";

export type CatalogProvider = "anthropic" | "openai" | "google";

export interface CatalogModel {
  /** Canonical name without provider prefix (e.g. "claude-opus-4.7"). */
  canonical: string;
  /** OpenRouter's full id, prefix included (e.g. "anthropic/claude-opus-4.7"). */
  openrouter_id: string;
  provider: CatalogProvider;
  /** Context window in tokens, when OpenRouter exposes it. */
  context_window?: number;
  /** Human-readable name from OpenRouter, when present. */
  display_name?: string;
}

export interface FetchOpts {
  /** Override fetch for testing. Defaults to global fetch. */
  fetchFn?: typeof fetch;
  /** Abort after N ms. Defaults to 5000. */
  timeoutMs?: number;
}

const PROVIDER_PREFIXES: Record<string, CatalogProvider> = {
  anthropic: "anthropic",
  openai: "openai",
  google: "google",
};

/**
 * Fetch and filter the OpenRouter catalog.
 *
 * Returns an empty array on any error — caller should fall back to
 * free-text input. Use `fetchOpenRouterCatalogVerbose()` if you need to
 * differentiate "no models" from "fetch failed" (e.g. for a wizard
 * help message).
 */
export async function fetchOpenRouterCatalog(opts: FetchOpts = {}): Promise<CatalogModel[]> {
  const result = await fetchOpenRouterCatalogVerbose(opts);
  return result.models;
}

export interface VerboseResult {
  models: CatalogModel[];
  /** Set when the fetch failed; falsy on success (even if 0 models). */
  error?: string;
}

export async function fetchOpenRouterCatalogVerbose(opts: FetchOpts = {}): Promise<VerboseResult> {
  const fetchFn = opts.fetchFn ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 5000;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetchFn(OPENROUTER_URL, { signal: ctrl.signal });
    if (!r.ok) {
      return { models: [], error: `HTTP ${r.status} from OpenRouter` };
    }
    const data = (await r.json()) as { data?: unknown };
    if (!Array.isArray(data.data)) {
      return { models: [], error: "Unexpected catalog shape" };
    }
    return { models: parseCatalog(data.data) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { models: [], error: msg };
  } finally {
    clearTimeout(timer);
  }
}

function parseCatalog(rows: unknown[]): CatalogModel[] {
  const out: CatalogModel[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const obj = row as Record<string, unknown>;
    const id = typeof obj.id === "string" ? obj.id : null;
    if (!id) continue;
    const slash = id.indexOf("/");
    if (slash <= 0) continue;
    const prefix = id.slice(0, slash);
    const tail = id.slice(slash + 1);
    const provider = PROVIDER_PREFIXES[prefix];
    if (!provider) continue;
    const model: CatalogModel = {
      canonical: tail,
      openrouter_id: id,
      provider,
    };
    if (typeof obj.context_length === "number") {
      model.context_window = obj.context_length;
    }
    if (typeof obj.name === "string") model.display_name = obj.name;
    out.push(model);
  }
  // Sort: provider, then canonical name (alphabetical, but pinned versions
  // bubble after aliases per the catalog convention).
  out.sort(
    (a, b) =>
      a.provider.localeCompare(b.provider) ||
      Number(/\d/.test(a.canonical)) - Number(/\d/.test(b.canonical)) ||
      a.canonical.localeCompare(b.canonical),
  );
  return out;
}
