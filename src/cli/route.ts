/**
 * `harness-router route "<prompt>"` — one-shot dispatch with live streaming.
 *
 * Loads the user's config, builds dispatchers, constructs a one-off
 * QuotaCache + Router, and streams the result to stdout/stderr. Useful as
 * a smoke test (`harness-router route "say ok"`) and for shell scripts
 * that want a single coding response without standing up the MCP server.
 */

import { Router } from "../router.js";
import { loadConfig } from "../config/index.js";
import { QuotaCache } from "../quota.js";
import { buildDispatchers } from "../mcp/dispatcher-factory.js";

export async function cmdRoute(prompt: string, configPath: string | undefined): Promise<number> {
  const config = await loadConfig(configPath);
  const dispatchers = await buildDispatchers(config);
  if (Object.keys(dispatchers).length === 0) {
    process.stderr.write(
      "No dispatchers available. Install at least one CLI (claude, codex, gemini, agent, opencode, copilot) " +
        "and try again, or point --config at a YAML with explicit routes.\n",
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
        // Thinking trace to stderr so it doesn't contaminate stdout.
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
