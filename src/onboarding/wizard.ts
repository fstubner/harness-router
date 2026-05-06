/**
 * Interactive `harness-router onboard` wizard (v0.3).
 *
 * Catalog-free. The wizard is structured around what the user types and
 * what's installed on their machine — never a hardcoded list of models.
 *
 * Walks the user through:
 *   1. Detect installed AI CLIs (probe, no-verify).
 *   2. Type the model keys they want to route. Optionally pre-loaded with
 *      OpenRouter's public catalog as a multi-select; falls through to
 *      free-text on any failure (network, 4xx, malformed).
 *   3. For each model, pick which detected harness serves it (or none).
 *   4. For each model, when the matching API-key env var is set
 *      (ANTHROPIC_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY), offer a
 *      metered fallback service.
 *   5. Pick the default `code mode:fanout` set (mixture_default).
 *   6. Pick which MCP hosts to wire up.
 *   7. Write `~/.harness-router/config.yaml` in v0.3 shape and run install
 *      for each chosen host.
 *
 * The pure parts (`buildV3WizardConfig` + `renderV3WizardYaml`) are
 * exported and tested without the inquirer prompt layer.
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { checkbox, confirm, input, select, Separator } from "@inquirer/prompts";

import { onboard, type HarnessId, type HarnessReport } from "../onboarding.js";
import {
  INSTALL_TARGETS,
  defaultEntry,
  type InstallTarget,
  type McpServerEntry,
} from "../install/targets.js";
import { renderV3Yaml } from "../v3/render.js";
import {
  fetchOpenRouterCatalogVerbose,
  type CatalogModel,
  type CatalogProvider,
} from "../v3/openrouter.js";
import type { V3Config, V3MeteredRoute, V3ModelEntry, V3SubscriptionRoute } from "../v3/types.js";

// ---------------------------------------------------------------------------
// Provider env-var policy
// ---------------------------------------------------------------------------

interface MeteredProviderInfo {
  id: CatalogProvider;
  displayName: string;
  envVar: string;
  baseUrl: string;
  /** Predicate: does this provider serve a given canonical model name? */
  matchesCanonical: (canonical: string) => boolean;
}

const METERED_PROVIDERS: readonly MeteredProviderInfo[] = [
  {
    id: "anthropic",
    displayName: "Anthropic API",
    envVar: "ANTHROPIC_API_KEY",
    baseUrl: "https://api.anthropic.com/v1",
    matchesCanonical: (c) => c.toLowerCase().includes("claude"),
  },
  {
    id: "openai",
    displayName: "OpenAI API",
    envVar: "OPENAI_API_KEY",
    baseUrl: "https://api.openai.com/v1",
    matchesCanonical: (c) => /^(gpt-|o\d|chatgpt-)/i.test(c),
  },
  {
    id: "google",
    displayName: "Google AI API",
    envVar: "GEMINI_API_KEY",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    matchesCanonical: (c) => /^(gemini|imagen|text-bison)/i.test(c),
  },
];

function findProviderForModel(
  model: string,
  envFn: (n: string) => string | undefined,
): MeteredProviderInfo | undefined {
  for (const p of METERED_PROVIDERS) {
    if (!envFn(p.envVar)) continue;
    if (p.matchesCanonical(model)) return p;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Pure logic — exported and tested without inquirer
// ---------------------------------------------------------------------------

export interface ModelChoice {
  /** Canonical model key (becomes `models.<key>` in YAML). */
  key: string;
  /**
   * Detected harness ids that should serve this model on subscription tier.
   * Multiple harnesses serving the same model is the common case — Claude
   * Code, Cursor, opencode and Copilot CLI all accept `claude-opus-4-7`,
   * for example. The wizard collects them via a checkbox and the router
   * picks the highest-quota usable one per dispatch.
   */
  subscriptionHarnesses?: readonly HarnessId[];
  /** When true, generate an openai_compatible metered route. */
  addMetered?: boolean;
}

export interface BuildOpts {
  /** Final priority order. Each entry matches a `ModelChoice.key`. */
  priority: readonly string[];
  choices: readonly ModelChoice[];
  /** Models that `code mode:fanout` should fan out to by default. */
  mixtureDefault?: readonly string[];
  /** Maps a HarnessId to the resolved CLI command (for the route's `command`). */
  harnessCommand: (id: HarnessId) => string;
  /** Env-var resolver. Defaults to `process.env`. */
  envFn?: (n: string) => string | undefined;
}

/**
 * Build a {@link V3Config} from the wizard's collected state.
 *
 * Skips choices that have no subscription harness AND no metered fallback —
 * an entry with neither route is invalid V3 and the loader would reject it.
 */
export function buildV3WizardConfig(opts: BuildOpts): V3Config {
  const envFn = opts.envFn ?? ((n) => process.env[n]);
  const models: Record<string, V3ModelEntry> = {};
  const priority: string[] = [];

  for (const choice of opts.choices) {
    const entry: V3ModelEntry = {};
    const subs: V3SubscriptionRoute[] = [];
    for (const harness of choice.subscriptionHarnesses ?? []) {
      subs.push({
        harness,
        command: opts.harnessCommand(harness),
      });
    }
    if (subs.length > 0) entry.subscription = subs;

    if (choice.addMetered) {
      const provider = findProviderForModel(choice.key, envFn);
      if (provider) {
        const metered: V3MeteredRoute = {
          base_url: provider.baseUrl,
          api_key: `\${${provider.envVar}}`,
        };
        entry.metered = [metered];
      }
    }
    if (!entry.subscription && !entry.metered) continue; // skip invalid
    models[choice.key] = entry;
  }

  // Filter priority to keys that survived (no orphan references).
  for (const key of opts.priority) {
    if (models[key]) priority.push(key);
  }

  const cfg: V3Config = { priority, models };
  if (opts.mixtureDefault && opts.mixtureDefault.length > 0) {
    const mix: string[] = [];
    for (const k of opts.mixtureDefault) if (models[k] && !mix.includes(k)) mix.push(k);
    if (mix.length > 0) (cfg as { mixture_default?: readonly string[] }).mixture_default = mix;
  }
  return cfg;
}

/** Convenience re-export so callers don't need to import from v3/. */
export const renderV3WizardYaml = renderV3Yaml;

/** Default location for the wizard's output. */
export function defaultConfigPath(): string {
  return path.join(os.homedir(), ".harness-router", "config.yaml");
}

// ---------------------------------------------------------------------------
// Interactive wizard
// ---------------------------------------------------------------------------

export interface RunWizardOpts {
  /** Path to write the config to. Defaults to ~/.harness-router/config.yaml. */
  configPath?: string;
  /** When true, skip the install step. The user already wired hosts manually. */
  skipInstall?: boolean;
}

export async function runWizard(opts: RunWizardOpts = {}): Promise<number> {
  const out = process.stdout;
  out.write("\n▌ harness-router onboard\n\n");
  out.write("  Detecting installed AI CLIs…\n\n");

  const reports = await onboard({ noVerify: true });
  const detected = reports.filter((r) => r.installed);
  if (detected.length === 0) {
    out.write(
      "  No supported CLIs found on PATH. Install at least one of:\n" +
        "    claude, codex, cursor's `agent`, gemini, opencode, copilot\n" +
        "  Then re-run `harness-router onboard`.\n",
    );
    return 1;
  }
  for (const r of detected) {
    const v = r.installedVersion ? `v${r.installedVersion}` : "";
    out.write(`  ✓ ${r.harness.padEnd(14)} ${v}\n`);
  }
  out.write(`\n  Detected ${detected.length} of ${reports.length} CLIs.\n\n`);

  // ---- Step 2: pick model keys to route -----------------------------------
  out.write(
    "  Fetching OpenRouter catalog (used for the picker; free-text fallback always works)…\n",
  );
  const catalog = await fetchOpenRouterCatalogVerbose({ timeoutMs: 5000 });

  let typedKeys: string[] = [];
  if (catalog.models.length > 0) {
    typedKeys = await pickFromCatalog(catalog.models);
  }
  // Always offer free-text input — for local models, niche providers, or
  // anything OpenRouter missed.
  const extra = await input({
    message:
      "Additional model keys (comma-separated, optional). " +
      "Use whatever your CLI accepts via --model. Leave empty to skip.",
    default: "",
  });
  for (const raw of extra.split(",")) {
    const k = raw.trim();
    if (k && !typedKeys.includes(k)) typedKeys.push(k);
  }

  if (typedKeys.length === 0) {
    out.write("\n  No models selected. Run `harness-router onboard` again to retry.\n");
    return 1;
  }

  // ---- Step 3: priority order ---------------------------------------------
  // checkbox-with-order isn't a stock inquirer feature; use a dedicated
  // ordered re-pick via the rendered list.
  const priority = await orderModels(typedKeys);

  // ---- Step 4: subscription harnesses per model ----------------------------
  // Multi-select: a model can be served by N harnesses on subscription
  // (e.g. claude-opus-4-7 is accepted by claude_code, cursor, opencode,
  // copilot). The router picks the highest-quota usable one per dispatch
  // and uses the rest as automatic fallbacks. Skip the prompt entirely
  // when only one harness was detected (auto-include it).
  const detectedIds = detected.map((r) => r.harness);
  const choices: ModelChoice[] = [];
  for (const key of priority) {
    let harnesses: HarnessId[] = [];
    if (detectedIds.length === 1) {
      harnesses = [...detectedIds];
    } else if (detectedIds.length > 1) {
      harnesses = await checkbox<HarnessId>({
        message: `Which harnesses serve "${key}" on subscription tier? (skip = metered only)`,
        choices: detectedIds.map((id) => ({ name: id, value: id, checked: false })),
      });
    }
    const choice: ModelChoice = { key };
    if (harnesses.length > 0) choice.subscriptionHarnesses = harnesses;
    choices.push(choice);
  }

  // ---- Step 5: metered fallback per matching env var ----------------------
  for (const choice of choices) {
    const provider = findProviderForModel(choice.key, (n) => process.env[n]);
    if (!provider) continue;
    const add = await confirm({
      message: `Add ${provider.displayName} metered fallback for "${choice.key}"? (uses ${provider.envVar})`,
      default: true,
    });
    if (add) choice.addMetered = true;
  }

  // ---- Step 6: mixture default --------------------------------------------
  const validForMixture = choices
    .filter((c) => (c.subscriptionHarnesses && c.subscriptionHarnesses.length > 0) || c.addMetered)
    .map((c) => c.key);
  let mixtureDefault: string[] = [];
  if (validForMixture.length > 1) {
    mixtureDefault = await checkbox<string>({
      message:
        "For `code mode:fanout` (parallel comparison), which models by default? (skip = all available)",
      choices: validForMixture.map((k) => ({ name: k, value: k, checked: false })),
    });
  }

  // ---- Step 7: MCP host install ------------------------------------------
  let chosenTargets: InstallTarget[] = [];
  if (!opts.skipInstall) {
    const presentTargets = INSTALL_TARGETS.filter((t) => t.configPath() !== null);
    if (presentTargets.length > 0) {
      const chosenIds = await checkbox<string>({
        message: "Wire harness-router into which MCP hosts?",
        choices: presentTargets.map((t) => ({
          name: t.displayName,
          value: t.id,
          checked: true,
        })),
      });
      chosenTargets = presentTargets.filter((t) => chosenIds.includes(t.id));
    }
  }

  // ---- Build, preview, confirm, write -------------------------------------
  const buildOpts: BuildOpts = {
    priority,
    choices,
    harnessCommand,
  };
  if (mixtureDefault.length > 0) buildOpts.mixtureDefault = mixtureDefault;
  const config = buildV3WizardConfig(buildOpts);
  const cfgPath = opts.configPath ?? defaultConfigPath();
  const yamlText = renderV3Yaml(config);

  out.write("\n  Config preview:\n");
  out.write(yamlText.replace(/^/gm, "    "));
  out.write("\n");

  const ok = await confirm({
    message: `Write to ${cfgPath} and install harness-router into ${chosenTargets.length} host(s)?`,
    default: true,
  });
  if (!ok) {
    out.write("  Aborted. No changes written.\n");
    return 1;
  }

  await fs.mkdir(path.dirname(cfgPath), { recursive: true });
  await fs.writeFile(cfgPath, yamlText, "utf-8");
  out.write(`  ✓ wrote ${cfgPath}\n`);

  const entry: McpServerEntry = defaultEntry();
  if (chosenTargets.length > 0) {
    out.write(`\n  Installing harness-router into ${chosenTargets.length} host(s)…\n`);
    for (const t of chosenTargets) {
      const result = await t.install(entry);
      const tag = result.ok
        ? result.alreadyPresent
          ? "─ already up to date"
          : result.replaced
            ? "✓ updated"
            : "✓ added"
        : "✗ failed";
      out.write(`    ${tag} ${t.displayName}${result.error ? `: ${result.error}` : ""}\n`);
    }
    out.write(
      "\n  Restart any host you just wired so it picks up harness-router.\n" +
        "  Run `harness-router doctor` to verify the underlying CLIs are authed and dispatching.\n",
    );
  }

  return 0;
}

// ---------------------------------------------------------------------------
// Inquirer helpers — kept thin so they're easy to retest by stubbing inquirer
// ---------------------------------------------------------------------------

async function pickFromCatalog(models: readonly CatalogModel[]): Promise<string[]> {
  // Group by provider for a cleaner picker.
  const byProvider = new Map<CatalogProvider, CatalogModel[]>();
  for (const m of models) {
    const arr = byProvider.get(m.provider) ?? [];
    arr.push(m);
    byProvider.set(m.provider, arr);
  }
  const choices: Array<{ name: string; value: string; checked: false } | Separator> = [];
  for (const [provider, list] of byProvider) {
    choices.push(new Separator(`— ${provider} —`));
    for (const m of list) {
      choices.push({
        name: m.context_window
          ? `${m.canonical}  (${(m.context_window / 1000).toFixed(0)}k ctx)`
          : m.canonical,
        value: m.canonical,
        checked: false,
      });
    }
  }
  return checkbox<string>({
    message:
      "Pick models to route (use space to select, enter to confirm; skip with no selections):",
    choices,
  });
}

async function orderModels(unordered: readonly string[]): Promise<string[]> {
  if (unordered.length <= 1) return [...unordered];
  // Inquirer doesn't have a native reorder prompt — use a sequence of
  // selects, removing each pick from the remaining list. Keeps the wizard
  // dependency-free and works in any TTY.
  const remaining: string[] = [...unordered];
  const order: string[] = [];
  while (remaining.length > 1) {
    const next = await select<string>({
      message: `Pick the next-priority model (${order.length + 1}/${unordered.length}):`,
      choices: remaining.map((k) => ({ name: k, value: k })),
    });
    order.push(next);
    remaining.splice(remaining.indexOf(next), 1);
  }
  if (remaining.length === 1) order.push(remaining[0]!);
  return order;
}

// ---------------------------------------------------------------------------
// Per-harness binary lookup (matches what `init` and the dispatcher factory use)
// ---------------------------------------------------------------------------

function harnessCommand(id: HarnessId): string {
  switch (id) {
    case "claude_code":
      return "claude";
    case "codex":
      return "codex";
    case "cursor":
      return "agent";
    case "gemini_cli":
      return "gemini";
    case "opencode":
      return "opencode";
    case "copilot":
      return "copilot";
    default:
      return id;
  }
}

// Re-export the report type so bin.ts can depend on us without importing
// onboarding.ts directly (keeps the wizard self-contained).
export type { HarnessReport };
