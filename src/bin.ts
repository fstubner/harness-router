#!/usr/bin/env node
/**
 * harness-router — CLI entrypoint.
 *
 * Bare invocation (`npx harness-router`) starts the stdio MCP server —
 * what hosts launch as a subprocess. Subcommands cover every other
 * operator action; see `printUsage` for the full list.
 */

import { parseArgs } from "node:util";
import { Router } from "./router.js";
import { VERSION } from "./version.js";
import { loadConfig } from "./config.js";
import { QuotaCache } from "./quota.js";
import { buildDispatchers } from "./mcp/dispatcher-factory.js";
import { startMcpHttpServer, startMcpServer } from "./mcp/server.js";
import { initObservability } from "./observability/index.js";
import { renderDashboard, type DashboardState, type RecentEvent } from "./dashboard/live.js";
import {
  HARNESS_SPECS,
  onboard,
  renderReport,
  type HarnessId,
  type OnboardOptions,
} from "./onboarding.js";
import {
  INSTALL_TARGETS,
  defaultEntry,
  type InstallTarget,
  type McpServerEntry,
} from "./install/targets.js";
import { runWizard } from "./onboarding/wizard.js";
import { cmdAuth } from "./cli/auth.js";

// ---------------------------------------------------------------------------
// Commands (R1 + R3 streaming)
// ---------------------------------------------------------------------------

async function cmdRoute(prompt: string, configPath: string | undefined): Promise<number> {
  const config = await loadConfig(configPath);
  const dispatchers = await buildDispatchers(config);
  if (Object.keys(dispatchers).length === 0) {
    process.stderr.write(
      "No dispatchers available. Install at least one CLI (claude, codex, gemini, agent, opencode) " +
        "and try again, or point --config at a YAML with an explicit services block.\n",
    );
    return 1;
  }
  const quota = new QuotaCache(dispatchers);
  const router = new Router(config, quota, dispatchers);

  let seenDecision = false;
  let finalSuccess = false;
  let finalError: string | undefined;
  let finalService = "unknown";

  for await (const { event, decision } of router.stream(prompt, [], process.cwd())) {
    if (decision && !seenDecision) {
      process.stdout.write(
        `-> service: ${decision.service}  model: ${decision.model}  tier: ${decision.tier}  quota: ${decision.quotaScore.toFixed(2)}\n`,
      );
      process.stdout.write(`   reason: ${decision.reason}\n`);
      process.stdout.write("--- output ---\n");
      seenDecision = true;
    }
    switch (event.type) {
      case "stdout":
        process.stdout.write(event.chunk);
        break;
      case "stderr":
        process.stderr.write(event.chunk);
        break;
      case "tool_use":
        process.stderr.write(`[tool_use ${event.name}]\n`);
        break;
      case "thinking":
        // Dim/compact thinking trace to stderr so it doesn't contaminate stdout.
        process.stderr.write(`[thinking] ${event.chunk}\n`);
        break;
      case "completion":
        finalSuccess = event.result.success;
        finalService = event.result.service;
        if (!finalSuccess) finalError = event.result.error;
        if (!event.result.output.endsWith("\n")) process.stdout.write("\n");
        break;
      case "error":
        finalError = event.error;
        break;
    }
  }

  if (!seenDecision) {
    process.stderr.write("No routing decision could be made.\n");
    return 1;
  }
  if (!finalSuccess) {
    process.stderr.write(
      `[error] ${finalError ?? "(no error message)"} (service=${finalService})\n`,
    );
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
      `tier=${svc.tier ?? "subscription"}`,
      svc.model ? `model=${svc.model}` : "",
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

async function buildDashboardState(
  config: Awaited<ReturnType<typeof loadConfig>>,
  dispatchers: Awaited<ReturnType<typeof buildDispatchers>>,
  quota: QuotaCache,
  router: Router,
  ansi: boolean,
  recent: RecentEvent[] = [],
): Promise<DashboardState> {
  const breakers = router.circuitBreakerStatus();
  const fullQuota = await quota.fullStatus();
  const services: DashboardState["services"] = [];
  const quotas: DashboardState["quotas"] = {};
  const brks: DashboardState["breakers"] = {};

  for (const [name, svc] of Object.entries(config.services)) {
    const dispatcher = dispatchers[name];
    const reachable = dispatcher?.isAvailable() ?? false;
    services.push({ name, config: svc, reachable });
    const q = fullQuota[name];
    if (q) {
      quotas[name] = {
        score: q.score,
        remaining: q.remaining ?? null,
        limit: q.limit ?? null,
        localCallCount: q.localCallCount,
        ...(q.resetAt ? { resetAt: q.resetAt } : {}),
      };
    } else {
      const score = await quota.getQuotaScore(name);
      quotas[name] = { score };
    }
    const b = breakers[name];
    if (b) brks[name] = b;
  }
  return {
    services,
    quotas,
    breakers: brks,
    recentEvents: recent,
    generatedAt: Date.now(),
    ansi,
  };
}

async function cmdDashboard(
  configPath: string | undefined,
  watch: boolean,
  intervalMs: number,
): Promise<number> {
  const config = await loadConfig(configPath);
  const dispatchers = await buildDispatchers(config);
  const quota = new QuotaCache(dispatchers);
  const router = new Router(config, quota, dispatchers);

  const isTty = Boolean(process.stdout.isTTY);

  if (!watch) {
    const state = await buildDashboardState(config, dispatchers, quota, router, isTty);
    process.stdout.write(renderDashboard(state) + "\n");
    return 0;
  }

  // Live-redraw loop. Ctrl-C exits.
  let running = true;
  const onSigint = () => {
    running = false;
  };
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigint);

  try {
    while (running) {
      const state = await buildDashboardState(config, dispatchers, quota, router, isTty);
      process.stdout.write(renderDashboard(state) + "\n");
      await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
    }
  } finally {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigint);
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Command — doctor (health check across installed AI CLIs)
// ---------------------------------------------------------------------------

async function cmdDoctor(
  configPath: string | undefined,
  installFlag: boolean,
  noVerify: boolean,
  harnessFilter: HarnessId | undefined,
): Promise<number> {
  const opts: OnboardOptions = {
    install: installFlag,
    noVerify,
  };
  if (configPath !== undefined) opts.configPath = configPath;
  if (harnessFilter !== undefined) opts.harnesses = [harnessFilter];

  const reports = await onboard(opts);
  const colors = Boolean(process.stdout.isTTY);
  process.stdout.write(renderReport(reports, colors) + "\n");

  // Exit 0 if every targeted harness is ready, 1 otherwise — useful for
  // shell scripts ("&& open editor", etc.).
  return reports.every((r) => r.ready) ? 0 : 1;
}

// ---------------------------------------------------------------------------
// Commands (R2 — MCP server)
// ---------------------------------------------------------------------------

/**
 * Run the MCP server on stdio (the default when invoked with no subcommand).
 * Hosts launch us as a subprocess and speak JSON-RPC over stdin/stdout.
 */
async function cmdStdio(configPath: string | undefined): Promise<number> {
  const buildOpts: { configPath?: string } = {};
  if (configPath !== undefined) buildOpts.configPath = configPath;
  const handle = await startMcpServer(buildOpts);
  return waitForShutdown(handle.close);
}

/**
 * Run the MCP server over Streamable HTTP. Default bind is 127.0.0.1:8765;
 * set --bind to expose to the network (auto-creates a bearer token).
 */
async function cmdServe(
  configPath: string | undefined,
  opts: { port?: number; bind?: string; requireAuth?: boolean },
): Promise<number> {
  const startOpts: {
    configPath?: string;
    port?: number;
    bind?: string;
    requireAuth?: boolean;
  } = {};
  if (configPath !== undefined) startOpts.configPath = configPath;
  if (opts.port !== undefined) startOpts.port = opts.port;
  if (opts.bind !== undefined) startOpts.bind = opts.bind;
  if (opts.requireAuth !== undefined) startOpts.requireAuth = opts.requireAuth;
  const handle = await startMcpHttpServer(startOpts);
  process.stderr.write(
    `harness-router listening on http://${opts.bind ?? "127.0.0.1"}:${handle.port}/mcp\n`,
  );
  return waitForShutdown(handle.close);
}

async function waitForShutdown(close: () => Promise<void>): Promise<number> {
  const shutdown = async (): Promise<void> => {
    try {
      await close();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
  await new Promise<void>(() => {
    /* never resolves */
  });
  return 0;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function printVersion(): void {
  process.stdout.write(`harness-router ${VERSION}\n`);
}

// ---------------------------------------------------------------------------
// Command — install (write MCP-host configs)
// ---------------------------------------------------------------------------

interface InstallCmdOpts {
  /** Restrict to one host id (`claude-desktop` | `cursor` | `codex`). */
  target?: string;
  /** Print the snippet instead of writing. Implies dry-run. */
  print?: boolean;
  /** Remove our entry from each host instead of installing. */
  uninstall?: boolean;
  /** Override the entry name (default: `harness-router`). */
  name?: string;
}

function selectTargets(targetId: string | undefined): InstallTarget[] {
  if (!targetId) return INSTALL_TARGETS.slice();
  const found = INSTALL_TARGETS.find((t) => t.id === targetId);
  if (!found) {
    process.stderr.write(
      `install --target: unknown host "${targetId}". Expected one of: ` +
        `${INSTALL_TARGETS.map((t) => t.id).join(", ")}\n`,
    );
    return [];
  }
  return [found];
}

async function cmdInstall(opts: InstallCmdOpts): Promise<number> {
  const targets = selectTargets(opts.target);
  if (targets.length === 0) return 1;

  const entry: McpServerEntry = {
    ...defaultEntry(),
    ...(opts.name ? { name: opts.name } : {}),
  };

  if (opts.print) {
    for (const t of targets) {
      process.stdout.write(`# ${t.displayName}\n${t.printSnippet(entry)}\n\n`);
    }
    return 0;
  }

  // Detect which hosts are present on this system. Skip + log when a host
  // isn't installed rather than failing the whole batch.
  const present = targets.filter((t) => t.configPath() !== null);
  const missing = targets.filter((t) => t.configPath() === null);

  if (present.length === 0) {
    process.stderr.write(
      "No supported MCP hosts detected on this machine. Looked for:\n" +
        targets.map((t) => `  - ${t.displayName} (${t.id})`).join("\n") +
        "\nIf one of these is installed in a non-default location, configure it manually using\n" +
        "`harness-router install --target <id> --print` and paste the snippet into the host's config.\n",
    );
    return 1;
  }

  for (const t of missing) {
    process.stdout.write(`  ─ ${t.displayName} not detected, skipping\n`);
  }

  let allOk = true;
  const verb = opts.uninstall ? "Uninstalling" : "Installing";
  process.stdout.write(
    `${verb} ${entry.name} into ${present.length} host${present.length === 1 ? "" : "s"}…\n`,
  );
  for (const t of present) {
    const action = opts.uninstall ? t.uninstall(entry.name) : t.install(entry);
    const result = await action;
    if (!result.ok) {
      allOk = false;
      process.stdout.write(`  ✗ ${t.displayName} → ${result.error ?? "unknown error"}\n`);
      continue;
    }
    const where = result.path ? ` (${result.path})` : "";
    if (opts.uninstall) {
      const tag = result.replaced ? "removed" : "not present";
      process.stdout.write(`  ✓ ${t.displayName}: ${tag}${where}\n`);
    } else if (result.alreadyPresent) {
      process.stdout.write(`  ─ ${t.displayName}: already up to date${where}\n`);
    } else if (result.replaced) {
      process.stdout.write(`  ✓ ${t.displayName}: updated entry${where}\n`);
    } else {
      process.stdout.write(`  ✓ ${t.displayName}: added entry${where}\n`);
    }
  }

  if (allOk && !opts.uninstall) {
    process.stdout.write(
      "\nDone. Restart the host(s) to pick up the new MCP server.\n" +
        "Verify the underlying CLIs with `harness-router doctor`.\n",
    );
  }
  return allOk ? 0 : 1;
}

function printUsage(): void {
  process.stdout.write(
    [
      "harness-router — route coding tasks across AI CLI harnesses",
      "",
      "Usage:",
      "  npx harness-router                      Start the MCP server on stdio (the default; what hosts launch).",
      "  harness-router serve --http <port>      Start the MCP server over HTTP.",
      "  harness-router serve --bind <addr>      Bind HTTP to a specific address (default 127.0.0.1).",
      "  harness-router onboard                  Interactive first-run setup: detect CLIs, pick models",
      "                                            + priority, choose MCP hosts to wire up.",
      "  harness-router onboard --skip-install   Just write the config; don't install into MCP hosts.",
      "  harness-router doctor                   Health check across installed AI CLIs.",
      "  harness-router doctor --install         Try `npm install -g` for any missing/upgradable harness.",
      "  harness-router doctor --harness <id>    Limit to one harness.",
      "  harness-router doctor --no-verify       Skip the live ~5-token dispatch probe.",
      "  harness-router install                  Detect MCP hosts and add `harness-router` entry to each.",
      "  harness-router install --target <id>    Install into one host only.",
      "  harness-router install --print          Print the config snippet for each host (no file writes).",
      "  harness-router uninstall                Remove the entry from each host.",
      "  harness-router auth                     Show the bearer token used for non-loopback HTTP.",
      "  harness-router auth rotate              Replace the existing token with a fresh one.",
      '  harness-router route "<prompt>"         Pick a service and dispatch (live streaming).',
      "  harness-router list-services            Show enabled services.",
      "  harness-router dashboard                Show quota + breaker status (one-shot).",
      "  harness-router dashboard --watch        Re-render every --interval ms.",
      "",
      "Options:",
      "  --config <path>   Path to config.yaml. Falls back to $HARNESS_ROUTER_CONFIG,",
      "                    then ~/.harness-router/config.yaml.",
      "  --interval <ms>   Dashboard refresh interval (default 1000).",
      "",
    ].join("\n"),
  );
}

export async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      config: { type: "string" },
      http: { type: "string" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
      watch: { type: "boolean" },
      interval: { type: "string" },
      install: { type: "boolean" },
      "no-verify": { type: "boolean" },
      harness: { type: "string" },
      target: { type: "string" },
      print: { type: "boolean" },
      uninstall: { type: "boolean" },
      name: { type: "string" },
      "skip-install": { type: "boolean" },
      bind: { type: "string" },
      "require-auth": { type: "boolean" },
    },
    allowPositionals: true,
    strict: false,
  });

  if (values.version) {
    printVersion();
    return 0;
  }
  if (values.help) {
    printUsage();
    return 0;
  }

  // Bare invocation = stdio MCP server. This is what hosts launch when
  // they spawn `npx harness-router` with no args.
  if (positionals.length === 0) {
    await initObservability();
    const configPath =
      (values.config as string | undefined) ?? process.env.HARNESS_ROUTER_CONFIG ?? undefined;
    return cmdStdio(configPath);
  }

  // Initialize observability once per CLI invocation. Idempotent; no-op
  // when OTEL_SDK_DISABLED=true. Spans without a configured backend are
  // emitted to a no-op exporter.
  await initObservability();

  const [command, ...rest] = positionals;
  // Resolve config path: explicit --config wins, else $HARNESS_ROUTER_CONFIG,
  // else loadConfig() auto-detects.
  const configPath =
    (values.config as string | undefined) ?? process.env.HARNESS_ROUTER_CONFIG ?? undefined;

  switch (command) {
    case "route": {
      const prompt = rest.join(" ").trim();
      if (!prompt) {
        process.stderr.write('route: missing prompt. Usage: route "<prompt>"\n');
        return 1;
      }
      return cmdRoute(prompt, configPath);
    }
    case "doctor": {
      const installFlag = Boolean(values.install);
      const noVerify = Boolean(values["no-verify"]);
      const harnessArg = values.harness as string | undefined;
      let harnessFilter: HarnessId | undefined;
      if (harnessArg !== undefined) {
        const known = HARNESS_SPECS.map((s) => s.harness);
        if (!known.includes(harnessArg)) {
          process.stderr.write(
            `doctor --harness: unknown harness "${harnessArg}". Expected one of: ${known.join(", ")}\n`,
          );
          return 1;
        }
        harnessFilter = harnessArg;
      }
      return cmdDoctor(configPath, installFlag, noVerify, harnessFilter);
    }
    case "install": {
      const opts: InstallCmdOpts = {};
      if (typeof values.target === "string") opts.target = values.target;
      if (values.print === true) opts.print = true;
      if (typeof values.name === "string") opts.name = values.name;
      return cmdInstall(opts);
    }
    case "uninstall": {
      // Same code path as `install` but with the verb flipped. Doesn't
      // accept `--print` (no snippet to print when removing).
      const opts: InstallCmdOpts = { uninstall: true };
      if (typeof values.target === "string") opts.target = values.target;
      if (typeof values.name === "string") opts.name = values.name;
      return cmdInstall(opts);
    }
    case "onboard": {
      const wizardOpts: { configPath?: string; skipInstall?: boolean } = {};
      if (typeof values.config === "string") wizardOpts.configPath = values.config;
      if (values["skip-install"] === true) wizardOpts.skipInstall = true;
      return runWizard(wizardOpts);
    }
    case "auth":
      // No subcommand → show. `auth rotate` is the only other action.
      return cmdAuth(rest[0]);
    case "list-services":
      return cmdListServices(configPath);
    case "dashboard": {
      const watch = Boolean(values.watch);
      let intervalMs = 1000;
      if (values.interval !== undefined) {
        const parsed = Number(values.interval);
        if (Number.isFinite(parsed) && parsed > 0) intervalMs = parsed;
      }
      return cmdDashboard(configPath, watch, intervalMs);
    }
    case "serve": {
      let httpPort: number | undefined;
      if (values.http !== undefined) {
        const parsed = Number(values.http);
        if (Number.isNaN(parsed)) {
          process.stderr.write(`serve --http: expected a port number, got "${values.http}"\n`);
          return 1;
        }
        httpPort = parsed;
      }
      const serveOpts: { port?: number; bind?: string; requireAuth?: boolean } = {};
      if (httpPort !== undefined) serveOpts.port = httpPort;
      else serveOpts.port = 8765; // default HTTP port; spec
      if (typeof values.bind === "string") serveOpts.bind = values.bind;
      if (values["require-auth"] === true) serveOpts.requireAuth = true;
      return cmdServe(configPath, serveOpts);
    }
    default:
      process.stderr.write(`unknown command: ${command}\n`);
      printUsage();
      return 1;
  }
}

const entrypoint =
  typeof process !== "undefined" && Array.isArray(process.argv) ? process.argv[1] : "";
if (entrypoint && (entrypoint.endsWith("bin.ts") || entrypoint.endsWith("bin.js"))) {
  void main(process.argv.slice(2)).then((code) => {
    process.exit(code);
  });
}
