/**
 * Prompt registry for the harness-router-mcp server.
 *
 * MCP prompts are pre-built templates that show up in the host's slash-menu
 * (Claude Desktop, Cursor, etc.). When a user picks one, its rendered text
 * is injected into the conversation as a user message — so prompts double as
 * built-in documentation for *how* to drive the server's tools effectively.
 *
 * Each prompt here points the LLM at the right tool(s) for a common workflow.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { RuntimeHolder } from "./config-hot-reload.js";

export interface PromptDeps {
  holder: RuntimeHolder;
}

/** Convenience: build a single user-message prompt response. */
function userMessage(text: string) {
  return {
    messages: [
      {
        role: "user" as const,
        content: { type: "text" as const, text },
      },
    ],
  };
}

const taskTypeSchema = z
  .enum(["execute", "plan", "review", "local"])
  .describe("execute (apply changes) | plan (architecture) | review (audit) | local");

export function registerPrompts(server: McpServer, _deps: PromptDeps): void {
  // ---------------------------------------------------------------------------
  // route-coding-task — entry point for the most common flow
  // ---------------------------------------------------------------------------
  server.registerPrompt(
    "route-coding-task",
    {
      title: "Route a coding task",
      description:
        "Send a coding task through harness-router. Picks the best (model × harness) service for the task type and streams the dispatch.",
      argsSchema: {
        task: z.string().describe("The coding task to route (free-form prompt)."),
        task_type: taskTypeSchema.optional(),
      },
    },
    ({ task, task_type }) =>
      userMessage(
        [
          "Use the harness-router-mcp server to route this coding task to the best available (model × harness) service.",
          "",
          `Task: ${task}`,
          task_type ? `Task type: ${task_type}` : "Task type: (let the router decide)",
          "",
          "Steps:",
          `1. Call code_auto with the task as \`prompt\`${task_type ? ` and \`hints.taskType: "${task_type}"\`` : ""}.`,
          "2. Show me the routing decision (which service was picked, the score, the reason).",
          "3. Stream or summarize the dispatch output.",
          "4. If the dispatch fails, call get_quota_status to check whether the chosen service is rate-limited or circuit-broken, and try again with a different harness via code_with_<harness>.",
        ].join("\n"),
      ),
  );

  // ---------------------------------------------------------------------------
  // compare-implementations — second-opinion / mixture flow
  // ---------------------------------------------------------------------------
  server.registerPrompt(
    "compare-implementations",
    {
      title: "Get a second opinion (mixture of agents)",
      description:
        "Fan a coding task out to multiple harnesses in parallel via code_mixture, then synthesize the strongest answer.",
      argsSchema: {
        task: z
          .string()
          .describe("The task to fan out — best for architecture, design, or hard tradeoffs."),
      },
    },
    ({ task }) =>
      userMessage(
        [
          "Use harness-router-mcp's code_mixture tool to get multiple perspectives on this task, then synthesize.",
          "",
          `Task: ${task}`,
          "",
          "Steps:",
          "1. Call code_mixture with the task as `prompt`. This dispatches in parallel to every available service.",
          "2. Compare the outputs. Note where they agree (high confidence) and where they diverge (worth investigating).",
          "3. Synthesize a final recommendation that takes the strongest argument from each, citing which harness contributed each insight.",
          "4. If outputs disagree on a fundamental tradeoff, surface that tradeoff explicitly rather than picking arbitrarily.",
        ].join("\n"),
      ),
  );

  // ---------------------------------------------------------------------------
  // harness-health-check — diagnostic flow
  // ---------------------------------------------------------------------------
  server.registerPrompt(
    "harness-health-check",
    {
      title: "Check harness-router service health",
      description:
        "Inspect the live state of every configured service: reachability, ELO/tier, quota, and circuit-breaker status.",
    },
    () =>
      userMessage(
        [
          "Use the harness-router-mcp server to give me a health snapshot of every configured service.",
          "",
          "Steps:",
          "1. Call list_available_services to see what's enabled and CLI-reachable on this host.",
          "2. Call get_quota_status for live quota usage and circuit-breaker state per service.",
          "3. Call dashboard for the formatted multi-line view (tier, ELO, recent calls).",
          "",
          "Then summarize:",
          "- Which services are healthy (reachable, quota OK, breaker closed)?",
          "- Which are degraded (rate-limited, near quota, breaker half-open)?",
          "- Which are out of rotation (unreachable or breaker open)?",
          "- Recommend any concrete action — auth a missing CLI, refresh a token, switch the default harness.",
        ].join("\n"),
      ),
  );

  // ---------------------------------------------------------------------------
  // onboard-coding-stack — first-run / setup flow
  // ---------------------------------------------------------------------------
  server.registerPrompt(
    "onboard-coding-stack",
    {
      title: "Onboard the harness-router stack",
      description:
        "Walk through installing, authenticating, and verifying each harness CLI (claude_code, codex, cursor, gemini_cli, opencode, copilot).",
    },
    () =>
      userMessage(
        [
          "Help me get my harness-router-mcp stack onboarded.",
          "",
          "Steps:",
          "1. Run `harness-router-mcp init` (no flags). This prints a per-harness checklist:",
          "   ✓ installed | ✗ installed (with the install command), ✓/✗ verified, → next-steps.",
          "2. For every harness not marked `ready`, walk me through fixing it ONE at a time.",
          "   - If `installed: false` and there's a next-step `npm install -g …` command, remind me to run it from an elevated shell on Windows or with `sudo` on Linux/macOS. Do NOT run it for me — installing global packages is mine to authorize.",
          "   - If `installed: false` and the install path is a download URL (Cursor's `agent`), give me the URL and stop.",
          "   - If `installed: true` but `verified: false` with an auth-shaped error, tell me the exact auth command (e.g. `claude auth login`) and let me run it interactively.",
          "3. After I report a fix is done, suggest re-running `harness-router-mcp init --harness <id>` to confirm just that one is now ready.",
          "4. Once everything is ready, run `harness-router-mcp init` once more to confirm an all-green report.",
          "",
          "Be terse. One harness at a time. Don't run installation commands on my behalf — quote them and explain what they do.",
        ].join("\n"),
      ),
  );

  // ---------------------------------------------------------------------------
  // pick-best-harness — explanatory / advisory flow
  // ---------------------------------------------------------------------------
  server.registerPrompt(
    "pick-best-harness",
    {
      title: "Recommend a harness for a task",
      description:
        "Given a task description, recommend which harness (claude_code / cursor / codex / gemini_cli / opencode / copilot) is the best fit and why — without dispatching.",
      argsSchema: {
        task: z.string().describe("Describe the task in your own words."),
      },
    },
    ({ task }) =>
      userMessage(
        [
          "Use harness-router-mcp to recommend the best harness for this task — without dispatching.",
          "",
          `Task: ${task}`,
          "",
          "Steps:",
          "1. Call list_available_services to see which harnesses are reachable here.",
          "2. Reason about the task type: is it execute (code change), plan (architecture/design), or review (audit/security)?",
          "3. For each available harness, give a one-line take on its fit:",
          "   - claude_code   — file/Bash/Edit tools, strong on plan & review.",
          "   - cursor        — codebase indexing, strong on execute in editor-style flows.",
          "   - codex         — full-auto execution loop, strongest on execute.",
          "   - gemini_cli    — 2M token context window, strong on review/plan over large codebases.",
          "   - opencode      — provider-agnostic OSS agent, supports multiple subscriptions per install.",
          "   - copilot       — GitHub Copilot CLI, GitHub-tooling-aware (gh / repo / PR context).",
          "   - <other>       — any service from `code_auto`'s list_available_services output that's NOT in the built-in set is a generic_cli registration; route via `code_auto({hints:{harness:\"<id>\"}})`.",
          "4. Recommend one primary harness and one fallback, and explain *why* in one sentence each.",
          "5. End with the exact code_with_<harness> tool call I should make next, with the task as prompt.",
        ].join("\n"),
      ),
  );
}
