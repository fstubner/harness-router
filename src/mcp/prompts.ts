/**
 * Prompt registry for the harness-router-mcp server.
 *
 * MCP prompts surface in the host's slash-menu (Claude Desktop, Cursor,
 * etc.). When picked, the rendered text is injected into the conversation
 * as a user message — so prompts double as built-in docs for *how* to
 * drive the server's tools.
 *
 * The set is small on purpose: one prompt per tool that actually benefits
 * from a hand-written intro.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { RuntimeHolder } from "./config-hot-reload.js";

export interface PromptDeps {
  holder: RuntimeHolder;
}

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

export function registerPrompts(server: McpServer, _deps: PromptDeps): void {
  // ---------------------------------------------------------------------------
  // route-task — the main flow
  // ---------------------------------------------------------------------------
  server.registerPrompt(
    "route-task",
    {
      title: "Route a coding task",
      description:
        "Send a coding task through harness-router. Picks the highest-priority model whose CLI has quota and dispatches there.",
      argsSchema: {
        task: z.string().describe("The coding task (free-form prompt)."),
        model: z
          .string()
          .optional()
          .describe(
            "Optional: bump a specific model to the front of the priority list. The router still falls back through the rest of the list if this model has no usable routes.",
          ),
      },
    },
    (args) => {
      const task = args.task ?? "";
      const model = args.model ?? "";
      const lines = [`Use the \`code\` tool to route this task:`, "", `task: ${task}`];
      if (model) lines.push(`hints.model: "${model}"`);
      lines.push("", "Subscription routes are tried first; metered API is the fallback.");
      return userMessage(lines.join("\n"));
    },
  );

  // ---------------------------------------------------------------------------
  // compare-models — multi-perspective for design questions
  // ---------------------------------------------------------------------------
  server.registerPrompt(
    "compare-models",
    {
      title: "Compare outputs across services",
      description:
        "Fan out a task to every available service in parallel via `code_mixture`. Use for design questions where multiple perspectives help.",
      argsSchema: {
        task: z.string().describe("The task to fan out."),
      },
    },
    (args) => {
      const task = args.task ?? "";
      return userMessage(
        [
          "Use the `code_mixture` tool to fan this out to every available service:",
          "",
          `prompt: ${task}`,
          "",
          "Then synthesise across the responses, noting where they agree and disagree. Subscription-tier routes return first; metered-tier results follow.",
        ].join("\n"),
      );
    },
  );

  // ---------------------------------------------------------------------------
  // health-check — when something feels off
  // ---------------------------------------------------------------------------
  server.registerPrompt(
    "health-check",
    {
      title: "Check service health",
      description:
        "Diagnose routing problems. Calls `dashboard` for the human-readable view and `get_quota_status` for the machine-readable detail.",
      argsSchema: {},
    },
    () =>
      userMessage(
        [
          "Run a routing health check:",
          "",
          "1. Call the `dashboard` tool for a human-readable status of every configured service (model, tier, quota, breaker).",
          "2. Call `get_quota_status` for the JSON detail of any service that looks off.",
          "",
          "Report which services are ready, which are tripped, and what's left in quota for each.",
        ].join("\n"),
      ),
  );
}
