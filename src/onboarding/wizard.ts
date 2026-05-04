/**
 * Interactive `harness-router-mcp onboard` wizard.
 *
 * Walks the user through:
 *   1. Detecting installed AI CLIs (delegates to `onboard()` with no-verify
 *      for speed — this is a probe, not the full readiness check).
 *   2. Picking the *default model* — what `code` reaches for first.
 *   3. Optional fallback models — the rest of the priority list, in order.
 *   4. Picking which MCP hosts to wire up (Claude Desktop / Code / Cursor / Codex).
 *   5. Writing `~/.harness-router/config.yaml` with the chosen priority +
 *      one service entry per detected harness pointing at the highest-priority
 *      model that harness can serve.
 *   6. Running `install` for the chosen MCP hosts.
 *
 * The wizard is interactive (TTY-only). For non-interactive setups, point
 * `--config` at a hand-written YAML and skip onboarding entirely.
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { checkbox, confirm, select, Separator } from "@inquirer/prompts";
import yaml from "js-yaml";

import { onboard, type HarnessId, type HarnessReport } from "../onboarding.js";
import {
  INSTALL_TARGETS,
  defaultEntry,
  type InstallTarget,
  type McpServerEntry,
} from "../install/targets.js";
import { aggregateCatalog, cliModelFor, MODEL_CATALOG } from "./models.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WizardConfig {
  /** Canonical model IDs in priority order (head = default). */
  modelPriority: string[];
  /** One service per detected harness; key is the service name. */
  services: Record<string, WizardService>;
}

export interface WizardService {
  enabled: true;
  type: "cli";
  harness: HarnessId;
  command: string;
  /** Canonical name (matches modelPriority entry). */
  model: string;
  /** What the CLI accepts via `--model`. */
  cli_model: string;
  tier: "subscription";
}

// ---------------------------------------------------------------------------
// Pure logic — buildable without I/O so it's testable
// ---------------------------------------------------------------------------

/**
 * Build a WizardConfig from the wizard's collected state.
 *
 * For each detected harness, generate one service whose `model` is the
 * highest-priority canonical model the harness can serve. Harnesses that
 * can't serve any of the user's chosen priorities are dropped — including
 * them with a non-matching model would never route.
 */
export function buildWizardConfig(input: {
  modelPriority: readonly string[];
  detectedHarnesses: readonly { id: HarnessId; command: string }[];
}): WizardConfig {
  const services: Record<string, WizardService> = {};
  for (const h of input.detectedHarnesses) {
    const catalog = MODEL_CATALOG[h.id] ?? [];
    if (catalog.length === 0) continue;
    // Find the first priority entry this harness can serve.
    const match = input.modelPriority.find(
      (canonical) => cliModelFor(h.id, canonical) !== undefined,
    );
    if (!match) continue;
    services[h.id] = {
      enabled: true,
      type: "cli",
      harness: h.id,
      command: h.command,
      model: match,
      cli_model: cliModelFor(h.id, match) ?? match,
      tier: "subscription",
    };
  }
  return {
    modelPriority: input.modelPriority.slice(),
    services,
  };
}

/** Render a WizardConfig as a YAML string. */
export function renderWizardYaml(config: WizardConfig): string {
  return yaml.dump(
    {
      model_priority: config.modelPriority,
      services: Object.fromEntries(
        Object.entries(config.services).map(([name, svc]) => [
          name,
          {
            enabled: svc.enabled,
            type: svc.type,
            harness: svc.harness,
            command: svc.command,
            model: svc.model,
            cli_model: svc.cli_model,
            tier: svc.tier,
          },
        ]),
      ),
    },
    { lineWidth: 100, noRefs: true },
  );
}

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

  // ---- 1. Detect installed harnesses (no-verify for speed) -----------------
  out.write("\n▌ harness-router-mcp onboard\n\n");
  out.write("  Detecting installed AI CLIs…\n\n");

  const reports = await onboard({ noVerify: true });
  const detected = reports.filter((r) => r.installed);
  if (detected.length === 0) {
    out.write(
      "  No supported CLIs found on PATH. Install at least one of:\n" +
        "    claude, codex, cursor's `agent`, gemini, opencode, copilot\n" +
        "  Then re-run `harness-router-mcp onboard`. (Or run `harness-router-mcp doctor`\n" +
        "  for a per-CLI install/upgrade checklist.)\n",
    );
    return 1;
  }
  for (const r of detected) {
    const v = r.installedVersion ? `v${r.installedVersion}` : "";
    out.write(`  ✓ ${r.harness.padEnd(14)} ${v}\n`);
  }
  out.write(`\n  Detected ${detected.length} of ${reports.length} CLIs.\n\n`);

  // ---- 2. Pick the default model ------------------------------------------
  const detectedIds = detected.map((r) => r.harness);
  const aggregated = aggregateCatalog(detectedIds);
  if (aggregated.length === 0) {
    out.write(
      "  No catalogued models for any detected CLI. (Catalog is built from\n" +
        "  each provider's docs — if your CLI is newer than ours, the wizard\n" +
        "  can't help here. Fall back to writing config.yaml by hand.)\n",
    );
    return 1;
  }

  const defaultChoice = await select<string>({
    message: "Default model — what `code` reaches for first when no override is passed",
    choices: aggregated
      .sort((a, b) => Number(b.alias) - Number(a.alias)) // aliases first
      .map((m) => ({
        name: `${m.canonical}  (${m.servedBy.join(", ")})`,
        value: m.canonical,
        description: m.description,
      })),
  });

  // ---- 3. Optional fallback models (in priority order) --------------------
  const remaining = aggregated.filter((m) => m.canonical !== defaultChoice);
  let fallbacks: string[] = [];
  if (remaining.length > 0) {
    fallbacks = await checkbox<string>({
      message: "Fallback models — used when the default's routes are exhausted (in shown order)",
      choices: [
        new Separator("— Aliases (auto-roll forward) —"),
        ...remaining
          .filter((m) => m.alias)
          .map((m) => ({
            name: `${m.canonical}  (${m.servedBy.join(", ")})`,
            value: m.canonical,
            description: m.description,
            checked: false,
          })),
        new Separator("— Pinned versions —"),
        ...remaining
          .filter((m) => !m.alias)
          .map((m) => ({
            name: `${m.canonical}  (${m.servedBy.join(", ")})`,
            value: m.canonical,
            description: m.description,
            checked: false,
          })),
      ],
    });
  }

  const modelPriority = [defaultChoice, ...fallbacks];

  // ---- 4. Pick which MCP hosts to wire up ---------------------------------
  let chosenTargets: InstallTarget[] = [];
  if (!opts.skipInstall) {
    const presentTargets = INSTALL_TARGETS.filter((t) => t.configPath() !== null);
    if (presentTargets.length === 0) {
      out.write(
        "\n  No MCP hosts detected for auto-install. You can still run the\n" +
          "  router via `harness-router-mcp mcp` directly. Skipping install step.\n",
      );
    } else {
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

  // ---- 5. Confirm + write config ------------------------------------------
  const detectedForConfig = detected.map((r) => {
    const spec = reports.find((x) => x.harness === r.harness);
    return { id: r.harness, command: spec?.installCommand?.split(" ")[0] ?? r.harness };
  });
  const config = buildWizardConfig({
    modelPriority,
    detectedHarnesses: detectedForConfig.map((d) => ({
      id: d.id,
      command: harnessCommand(d.id),
    })),
  });
  const cfgPath = opts.configPath ?? defaultConfigPath();
  const yamlText = renderWizardYaml(config);

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

  // ---- 6. Install into chosen hosts ---------------------------------------
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
        "  Run `harness-router-mcp doctor` to verify the underlying CLIs are authed and dispatching.\n",
    );
  }

  return 0;
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
