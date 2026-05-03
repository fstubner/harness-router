/**
 * Dispatcher factory — shared between the CLI (`bin.ts`) and the MCP server.
 *
 * Every supported harness has a constructor in the static `HARNESS_TABLE`.
 * `buildDispatchers()` walks the config and instantiates one dispatcher per
 * enabled service whose harness has a known constructor. Unknown harnesses
 * are silently skipped — the router never sees them, mirroring the legacy
 * Python behavior.
 *
 * History: this file used dynamic `import()` calls during the multi-agent
 * port to allow each branch to compile before its sibling branches landed.
 * Now that every dispatcher exists, the static-import form gives us full
 * type safety and lets us drop the `@ts-ignore`.
 */

import which from "which";

import type { Dispatcher, DispatcherInitOpts } from "../dispatchers/base.js";
import type { RouterConfig, ServiceConfig } from "../types.js";

import { ClaudeCodeDispatcher } from "../dispatchers/claude-code.js";
import { CodexDispatcher } from "../dispatchers/codex.js";
import { CopilotDispatcher } from "../dispatchers/copilot.js";
import { CursorDispatcher } from "../dispatchers/cursor.js";
import { GeminiDispatcher } from "../dispatchers/gemini.js";
import { GenericCliDispatcher } from "../dispatchers/generic-cli.js";
import { OpenCodeDispatcher } from "../dispatchers/opencode.js";
import { OpenAICompatibleDispatcher } from "../dispatchers/openai-compatible.js";

/** Map of enabled service name -> dispatcher instance. */
export type DispatcherMap = Record<string, Dispatcher>;

type DispatcherCtor = new (svc: ServiceConfig, opts?: DispatcherInitOpts) => Dispatcher;

/**
 * Keys are canonical harness names. A service's harness is resolved as
 * `svc.harness ?? name` — which allows multiple services to share the same
 * CLI harness with different model strings (e.g. cursor_sonnet + cursor_opus
 * both using the "cursor" harness).
 *
 * `gemini` is a back-compat alias for `gemini_cli` accepted in older configs.
 */
const HARNESS_TABLE: Record<string, DispatcherCtor> = {
  claude_code: ClaudeCodeDispatcher,
  codex: CodexDispatcher,
  copilot: CopilotDispatcher,
  cursor: CursorDispatcher,
  gemini_cli: GeminiDispatcher,
  gemini: GeminiDispatcher,
  opencode: OpenCodeDispatcher,
};

/** Resolve a CLI binary on PATH. Returns null when not found. */
async function resolveCliPath(command: string | undefined): Promise<string | null> {
  if (!command) return null;
  try {
    const r = await which(command, { nothrow: true });
    return r ?? null;
  } catch {
    return null;
  }
}

/**
 * Build one dispatcher from a service config. Returns `undefined` when the
 * harness isn't registered above (so the router can skip it).
 *
 * Kept `async` because we resolve the CLI path via `which()` to inform the
 * dispatcher's `isAvailable()` — and a future remote dispatcher could
 * legitimately need async construction too.
 */
export async function makeDispatcher(
  name: string,
  svc: ServiceConfig,
): Promise<Dispatcher | undefined> {
  if (svc.type === "openai_compatible") {
    // HTTP dispatcher — no CLI to resolve, always considered available.
    return new OpenAICompatibleDispatcher(svc);
  }
  if (svc.type === "generic_cli") {
    // YAML-driven CLI: resolve the bare command via `which` so isAvailable()
    // reflects PATH presence, then build a GenericCliDispatcher from the
    // recipe in `svc.genericCli`. Skips the HARNESS_TABLE lookup — generic
    // services are self-describing.
    const cliPath = await resolveCliPath(svc.command);
    return new GenericCliDispatcher(svc, { cliPath });
  }
  const harness = svc.harness ?? name;
  const Ctor = HARNESS_TABLE[harness];
  if (!Ctor) {
    // Auto-promote: a `type: cli` service with a `command` but an unknown
    // harness gets the generic dispatcher instead of being silently
    // skipped. Lets users add new tools with the absolute minimum YAML:
    //
    //   my_new_tool:
    //     command: my-new-tool
    //
    // — no `type: generic_cli`, no recipe block. The generic dispatcher
    // runs `<command> "<prompt>"` and treats stdout as the response,
    // which works for any plain-positional CLI.
    //
    // Without this fallback, the unknown-harness path returned `undefined`
    // and the service vanished from routing — confusing UX. With it, the
    // service is reachable via `code_auto({hints:{harness:"<id>"}})`.
    if (svc.command) {
      const cliPath = await resolveCliPath(svc.command);
      return new GenericCliDispatcher(svc, { cliPath });
    }
    return undefined;
  }

  // Resolve the CLI once at construction so `isAvailable()` reflects reality
  // — the router skips services whose CLI isn't on PATH. Crucial for legacy
  // YAML configs that explicitly list services for CLIs the user doesn't
  // have installed; auto-detect mode already filters those out in loadConfig
  // but legacy mode does not.
  const cliPath = await resolveCliPath(svc.command);
  return new Ctor(svc, { cliPath });
}

/**
 * Build a dispatcher map for every enabled service in the config.
 *
 * Services without a registered constructor are quietly skipped — the router
 * never sees them. Services whose CLI is missing from PATH are still mapped
 * here; the dispatcher's `isAvailable()` is what gates routing decisions.
 */
export async function buildDispatchers(config: RouterConfig): Promise<DispatcherMap> {
  const out: DispatcherMap = {};
  for (const [name, svc] of Object.entries(config.services)) {
    if (!svc.enabled) continue;
    const d = await makeDispatcher(name, svc);
    if (d) out[name] = d;
  }
  return out;
}
