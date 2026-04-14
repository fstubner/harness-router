#!/usr/bin/env node
/**
 * coding-agent-mcp — minimal R1 CLI demo.
 *
 * Usage:
 *   tsx src/bin.ts route "<prompt>"     Pick a service and dispatch.
 *   tsx src/bin.ts list-services        Show enabled services.
 *   tsx src/bin.ts dashboard            Show quota + breaker status.
 *
 * The full MCP server lives in R2. This is a single-command demo.
 */

import { parseArgs } from "node:util";
import { Router } from "./router.js";
import { loadConfig } from "./config.js";
import { QuotaCache } from "./quota.js";
import { LeaderboardCache } from "./leaderboard.js";
import type { Dispatcher } from "./dispatchers/base.js";
import type { RouterConfig, ServiceConfig } from "./types.js";

/**
 * Build a dispatcher map for every enabled service in the config.
 *
 * R1 scope is minimal — this imports dispatcher factories lazily so that
 * adding a new dispatcher type doesn't break the CLI when the module isn't
 * present. The factory returns `undefined` if the dispatcher can't be built
 * in the current environment.
 */
async function buildDispatchers(
  config: RouterConfig,
): Promise<Record<string, Dispatcher>> {
  const out: Record<string, Dispatcher> = {};
  for (const [name, svc] of Object.entries(config.services)) {
    if (!svc.enabled) continue;
    const d = await makeDispatcher(name, svc);
    if (d) out[name] = d;
  }
  return out;
}

/**
 * Lazily import a dispatcher module by relative path.
 *
 * Uses a variable specifier + `@ts-ignore` for the missing type declarations
 * because these modules are owned by other agents and may not exist yet.
 */
async function loadDispatcherModule(
  relPath: string,
): Promise<Record<string, new (svc: ServiceConfig) => Dispatcher> | undefined> {
  try {
    // @ts-ignore - dynamic specifier; modules land at merge time.
    const mod = (await import(relPath)) as Record<
      string,
      new (svc: ServiceConfig) => Dispatcher
    >;
    return mod;
  } catch {
    return undefined;
  }
}

async function makeDispatcher(
  name: string,
  svc: ServiceConfig,
): Promise<Dispatcher | undefined> {
  const harness = svc.harness ?? name;
  const table: Record<string, { path: string; exportName: string }> = {
    claude_code: { path: "./dispatchers/claude_code.js", exportName: "ClaudeCodeDispatcher" },
    cursor: { path: "./dispatchers/cursor.js", exportName: "CursorDispatcher" },
    codex: { path: "./dispatchers/codex.js", exportName: "CodexDispatcher" },
    gemini_cli: { path: "./dispatchers/gemini_cli.js", exportName: "GeminiCliDispatcher" },
    gemini: { path: "./dispatchers/gemini_cli.js", exportName: "GeminiCliDispatcher" },
  };
  const entry = table[harness];
  if (entry) {
    const mod = await loadDispatcherModule(entry.path);
    const Ctor = mod?.[entry.exportName];
    if (Ctor) return new Ctor(svc);
    return undefined;
  }
  if (svc.type === "openai_compatible") {
    const mod = await loadDispatcherModule("./dispatchers/openai_compatible.js");
    const Ctor = mod?.OpenAiCompatibleDispatcher;
    if (Ctor) return new Ctor(svc);
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdRoute(prompt: string, configPath: string | undefined): Promise<number> {
  const config = await loadConfig(configPath);
  const quota = new QuotaCache();
  const leaderboard = new LeaderboardCache();
  const dispatchers = await buildDispatchers(config);
  if (Object.keys(dispatchers).length === 0) {
    process.stderr.write(
      "No dispatchers available. Install at least one CLI (claude, agent, codex, gemini) " +
        "and try again, or point --config at a YAML with an explicit services block.\n",
    );
    return 1;
  }
  const router = new Router(config, quota, dispatchers, leaderboard);

  const { result, decision } = await router.route(prompt, [], process.cwd());
  if (decision) {
    process.stdout.write(
      `-> service: ${decision.service}  tier: ${decision.tier}  score: ${decision.finalScore.toFixed(4)}\n`,
    );
    process.stdout.write(`   reason: ${decision.reason}\n`);
    if (decision.model) process.stdout.write(`   model: ${decision.model}\n`);
  } else {
    process.stderr.write("No routing decision could be made.\n");
  }
  process.stdout.write("--- output ---\n");
  process.stdout.write(result.output);
  if (!result.output.endsWith("\n")) process.stdout.write("\n");
  if (!result.success) {
    process.stderr.write(`[error] ${result.error ?? "(no error message)"}\n`);
    return 1;
  }
  return 0;
}

async function cmdListServices(configPath: string | undefined): Promise<number> {
  const config = await loadConfig(configPath);
  const rows: string[] = [];
  for (const [name, svc] of Object.entries(config.services)) {
    if (!svc.enabled) continue;
    const harness = svc.harness ?? name;
    const parts = [
      name,
      `harness=${harness}`,
      `tier=${svc.tier}`,
      `weight=${svc.weight}`,
      svc.leaderboardModel ? `lb=${svc.leaderboardModel}` : "",
    ].filter(Boolean);
    rows.push(parts.join("  "));
  }
  if (rows.length === 0) {
    process.stdout.write("(no enabled services)\n");
  } else {
    for (const r of rows) process.stdout.write(`${r}\n`);
  }
  return 0;
}

async function cmdDashboard(configPath: string | undefined): Promise<number> {
  const config = await loadConfig(configPath);
  const quota = new QuotaCache();
  const leaderboard = new LeaderboardCache();
  const dispatchers = await buildDispatchers(config);
  const router = new Router(config, quota, dispatchers, leaderboard);

  const bstatus = router.circuitBreakerStatus();
  process.stdout.write("--- circuit breakers ---\n");
  for (const [name, s] of Object.entries(bstatus)) {
    process.stdout.write(`${name}: ${JSON.stringify(s)}\n`);
  }

  process.stdout.write("--- quota ---\n");
  for (const name of Object.keys(config.services)) {
    const score = await quota.getQuotaScore(name);
    process.stdout.write(`${name}: score=${score.toFixed(3)}\n`);
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function printUsage(): void {
  process.stdout.write(
    [
      "coding-agent-mcp CLI",
      "",
      "Usage:",
      '  coding-agent-mcp route "<prompt>"   Pick a service and dispatch.',
      "  coding-agent-mcp list-services      Show enabled services.",
      "  coding-agent-mcp dashboard          Show quota + breaker status.",
      "",
      "Options:",
      "  --config <path>   Path to config.yaml (default: auto-detect)",
      "",
    ].join("\n"),
  );
}

export async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      config: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: true,
    strict: false,
  });

  if (values.help || positionals.length === 0) {
    printUsage();
    return values.help ? 0 : 1;
  }

  const [command, ...rest] = positionals;
  const configPath = values.config as string | undefined;

  switch (command) {
    case "route": {
      const prompt = rest.join(" ").trim();
      if (!prompt) {
        process.stderr.write('route: missing prompt. Usage: route "<prompt>"\n');
        return 1;
      }
      return cmdRoute(prompt, configPath);
    }
    case "list-services":
      return cmdListServices(configPath);
    case "dashboard":
      return cmdDashboard(configPath);
    default:
      process.stderr.write(`unknown command: ${command}\n`);
      printUsage();
      return 1;
  }
}

// When invoked directly (not imported), run and set exit code.
// Use a runtime check that tsx/node recognizes.
const entrypoint =
  typeof process !== "undefined" && Array.isArray(process.argv) ? process.argv[1] : "";
// import.meta.url check would be preferred but keep it simple: run if we're the main module.
if (entrypoint && (entrypoint.endsWith("bin.ts") || entrypoint.endsWith("bin.js"))) {
  void main(process.argv.slice(2)).then((code) => {
    process.exit(code);
  });
}
