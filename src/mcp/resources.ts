/**
 * MCP resources for harness-router.
 *
 * v0.3 cuts the v0.2 `dashboard` and `get_quota_status` tools and exposes
 * the same data as **resources** instead. Rationale: tools are for actions
 * with side effects; resources are for inspectable state. Routing status
 * is the latter — agents shouldn't have to "call a tool" to see what their
 * router is doing.
 *
 * Two resources:
 *   - `harness-router://status`         — multi-line text dashboard
 *   - `harness-router://status.json`    — machine-readable quota + breaker state
 *
 * Both are read-on-demand (no subscriptions) and unauthenticated — they
 * inherit the transport's auth model (loopback by default, bearer token
 * for non-loopback).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";

import { handleDashboard, handleQuotaStatus, type ToolDeps } from "./tools.js";

export const RESOURCE_URIS = ["harness-router://status", "harness-router://status.json"] as const;

export function registerResources(server: McpServer, deps: ToolDeps): void {
  server.registerResource(
    "harness-router-status",
    "harness-router://status",
    {
      title: "Routing status",
      description:
        "Multi-line text dashboard — model priority, per-service reachability, " +
        "quota, circuit-breaker state, and the router's current pick.",
      mimeType: "text/plain",
    },
    async (uri): Promise<ReadResourceResult> => {
      const text = await handleDashboard(deps);
      return {
        contents: [{ uri: uri.href, mimeType: "text/plain", text }],
      };
    },
  );

  server.registerResource(
    "harness-router-status-json",
    "harness-router://status.json",
    {
      title: "Routing status (JSON)",
      description: "Per-service quota + circuit-breaker state in JSON form.",
      mimeType: "application/json",
    },
    async (uri): Promise<ReadResourceResult> => {
      const data = await handleQuotaStatus(deps);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(data, null, 2),
          },
        ],
      };
    },
  );
}
