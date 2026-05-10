#!/usr/bin/env node
/**
 * harness-router — CLI entrypoint.
 *
 * Bare invocation (`npx harness-router`) starts the stdio MCP server —
 * what hosts launch as a subprocess. Subcommands cover every other
 * operator action; each lives in its own file under src/cli/.
 *
 * This file's only responsibilities:
 *   - parse argv with node:util `parseArgs`
 *   - dispatch to the right cmdX function
 *   - print --version / --help text
 *
 * Adding a new command? Drop a `src/cli/<name>.ts` exporting `cmd<Name>`,
 * import it here, add a case to the switch + a usage line.
 */

import { parseArgs } from "node:util";

import { VERSION } from "./version.js";
import { initObservability } from "./observability/index.js";
import { HARNESS_SPECS, type HarnessId } from "./harnesses.js";
import { runWizard } from "./onboarding/wizard.js";
import { cmdAuth } from "./cli/auth.js";
import { cmdRoute } from "./cli/route.js";
import { cmdListServices } from "./cli/list-services.js";
import { cmdDashboard } from "./cli/dashboard.js";
import { cmdDoctor } from "./cli/doctor.js";
import { cmdStdio, cmdServe } from "./cli/serve.js";
import { cmdInstall, type InstallCmdOpts } from "./cli/install.js";

function printVersion(): void {
  process.stdout.write(`harness-router ${VERSION}\n`);
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
      "  harness-router doctor --probe-routes    Live-probe EVERY (harness, model) route in the config.",
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
      "probe-routes": { type: "boolean" },
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
  // when OTEL_SDK_DISABLED=true. Spans without a configured backend go
  // to a no-op exporter.
  await initObservability();

  const [command, ...rest] = positionals;
  // Resolve config path: explicit --config wins, else $HARNESS_ROUTER_CONFIG,
  // else loadConfig() defaults to ~/.harness-router/config.yaml.
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
      const probeRoutes = Boolean(values["probe-routes"]);
      return cmdDoctor(configPath, installFlag, noVerify, harnessFilter, probeRoutes);
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
      else serveOpts.port = 8765;
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
