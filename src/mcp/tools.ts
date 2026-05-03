/**
 * Tool registry for the harness-router-mcp server.
 *
 * The MCP surface is intentionally small:
 *   - `code`              — main routing tool (model-first walk + tier fallback)
 *   - `code_mixture`      — fan out to N services in parallel (compare outputs)
 *   - `dashboard`         — text status of every configured service
 *   - `get_quota_status`  — JSON quota + breaker state
 *
 * `setup` (Claude-Code routing-hook bootstrap) is now a CLI subcommand
 * (`harness-router-mcp setup-routing-hook`) — it's a host-side install action,
 * not something an agent should ever call mid-conversation.
 *
 * When the caller sets `_meta.progressToken` on the `code` request, each
 * dispatcher event fires a `notifications/progress` so streaming-aware
 * clients see live output.
 */

import path from "node:path";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ServerNotification } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import type { DispatchResult, DispatcherEvent, RouteHints, RoutingDecision } from "../types.js";
import { withMcpToolSpan } from "../observability/spans.js";
import type { RuntimeHolder } from "./config-hot-reload.js";
import type { ConfigHotReloader } from "./config-hot-reload.js";

// ---------------------------------------------------------------------------
// Shared zod schemas
// ---------------------------------------------------------------------------

const MAX_PROMPT_BYTES = 1_000_000; // 1 MB
const MAX_FILES = 256;
const MAX_PATH_LEN = 4096;

const routeHintsSchema = z
  .object({
    service: z
      .string()
      .max(MAX_PATH_LEN)
      .optional()
      .describe("Force a specific service (bypasses model priority walk)."),
    model: z
      .string()
      .max(MAX_PATH_LEN)
      .optional()
      .describe(
        "Bump a specific model to the front of the priority list. The router still falls through to the rest of the list if this model has no usable routes.",
      ),
  })
  .describe("Optional routing hints.");

const workingDirSchema = z
  .string()
  .max(MAX_PATH_LEN)
  .refine((p) => p === "" || path.isAbsolute(p), {
    message: "workingDir must be an absolute path or empty",
  })
  .optional();

const filesSchema = z
  .array(z.string().max(MAX_PATH_LEN))
  .max(MAX_FILES)
  .optional()
  .describe("Absolute file paths to include as context (max 256 entries).");

const promptSchema = z
  .string()
  .max(MAX_PROMPT_BYTES)
  .describe("The coding task or question (max 1 MB).");

const codeInputShape = {
  prompt: promptSchema,
  files: filesSchema,
  workingDir: workingDirSchema.describe("Working directory for the CLI process."),
  hints: routeHintsSchema.optional(),
} as const;

const mixtureInputShape = {
  prompt: promptSchema,
  files: filesSchema,
  workingDir: workingDirSchema,
  services: z
    .array(z.string().max(MAX_PATH_LEN))
    .max(MAX_FILES)
    .optional()
    .describe("Optional subset of service names — defaults to every available service."),
} as const;

// ---------------------------------------------------------------------------
// Response shapes
// ---------------------------------------------------------------------------

export interface RouteResponse {
  success: boolean;
  output: string;
  error?: string;
  service: string;
  model?: string;
  durationMs?: number;
  tokensUsed?: { input: number; output: number };
  rateLimited?: boolean;
  retryAfter?: number;
  routing?: {
    model: string;
    tier: "subscription" | "metered";
    quotaScore: number;
    reason: string;
  };
}

export interface MixtureItem {
  service: string;
  model: string;
  tier: "subscription" | "metered";
  success: boolean;
  output: string;
  error?: string;
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonText(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function plainText(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

function toHints(h: z.infer<typeof routeHintsSchema> | undefined): RouteHints {
  if (!h) return {};
  const out: RouteHints = {};
  if (h.service !== undefined) out.service = h.service;
  if (h.model !== undefined) out.model = h.model;
  return out;
}

async function ensureFreshConfig(reloader: ConfigHotReloader | undefined): Promise<void> {
  if (reloader) await reloader.maybeReload();
}

export interface ToolExtra {
  _meta?: { progressToken?: string | number } & Record<string, unknown>;
  sendNotification?: (notification: ServerNotification) => Promise<void>;
}

async function emitProgress(
  extra: ToolExtra | undefined,
  progressToken: string | number | undefined,
  counter: { value: number },
  event: DispatcherEvent,
  service?: string,
): Promise<void> {
  if (!extra?.sendNotification || progressToken === undefined) return;
  counter.value += 1;
  try {
    await extra.sendNotification({
      method: "notifications/progress",
      params: {
        progressToken,
        progress: counter.value,
        message: summarizeEvent(event, service),
        _meta: { event, service },
      },
    });
  } catch {
    // Best-effort.
  }
}

function summarizeEvent(event: DispatcherEvent, service?: string): string {
  const prefix = service ? `[${service}] ` : "";
  switch (event.type) {
    case "stdout":
      return `${prefix}stdout: ${truncate(event.chunk, 60)}`;
    case "stderr":
      return `${prefix}stderr: ${truncate(event.chunk, 60)}`;
    case "tool_use":
      return `${prefix}tool_use: ${event.name}`;
    case "thinking":
      return `${prefix}thinking: ${truncate(event.chunk, 60)}`;
    case "completion":
      return `${prefix}completion: ${event.result.success ? "ok" : "fail"}`;
    case "error":
      return `${prefix}error: ${event.error}`;
  }
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 3)}...`;
}

function shapeRouteResponse(
  result: DispatchResult,
  decision: RoutingDecision | null,
): RouteResponse {
  const response: RouteResponse = {
    success: result.success,
    output: result.output,
    service: result.service,
  };
  if (result.error !== undefined) response.error = result.error;
  if (result.durationMs !== undefined) response.durationMs = result.durationMs;
  if (result.tokensUsed !== undefined) response.tokensUsed = result.tokensUsed;
  if (result.rateLimited) response.rateLimited = true;
  if (result.retryAfter !== undefined) response.retryAfter = result.retryAfter;
  if (decision) {
    if (decision.model) response.model = decision.model;
    response.routing = {
      model: decision.model,
      tier: decision.tier,
      quotaScore: decision.quotaScore,
      reason: decision.reason,
    };
  }
  return response;
}

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------

export interface ToolDeps {
  holder: RuntimeHolder;
  reloader?: ConfigHotReloader;
}

async function runRoutedStreaming(
  deps: ToolDeps,
  prompt: string,
  files: string[],
  workingDir: string,
  hints: RouteHints,
  extra: ToolExtra | undefined,
): Promise<RouteResponse> {
  await ensureFreshConfig(deps.reloader);
  const state = deps.holder.state;
  const progressToken = extra?._meta?.progressToken;
  const counter = { value: 0 };

  let finalResult: DispatchResult | null = null;
  let finalDecision: RoutingDecision | null = null;

  for await (const { event, decision } of state.router.stream(prompt, files, workingDir, {
    hints,
  })) {
    if (decision) finalDecision = decision;
    await emitProgress(extra, progressToken, counter, event, decision?.service);
    if (event.type === "completion") finalResult = event.result;
  }

  const result: DispatchResult = finalResult ?? {
    output: "",
    service: "none",
    success: false,
    error: "Router stream ended without a completion event",
  };
  return shapeRouteResponse(result, finalDecision);
}

async function runRoutedBuffered(
  deps: ToolDeps,
  prompt: string,
  files: string[],
  workingDir: string,
  hints: RouteHints,
): Promise<RouteResponse> {
  await ensureFreshConfig(deps.reloader);
  const state = deps.holder.state;
  const { result, decision } = await state.router.route(prompt, files, workingDir, { hints });
  return shapeRouteResponse(result, decision);
}

export async function handleCode(
  deps: ToolDeps,
  input: z.infer<z.ZodObject<typeof codeInputShape>>,
  extra?: ToolExtra,
): Promise<RouteResponse> {
  const progressToken = extra?._meta?.progressToken;
  return withMcpToolSpan({ "tool.name": "code" }, async () => {
    const hints = toHints(input.hints);
    const prompt = input.prompt;
    const files = input.files ?? [];
    const workingDir = input.workingDir ?? process.cwd();
    if (progressToken !== undefined) {
      return runRoutedStreaming(deps, prompt, files, workingDir, hints, extra);
    }
    return runRoutedBuffered(deps, prompt, files, workingDir, hints);
  });
}

export async function handleCodeMixture(
  deps: ToolDeps,
  input: z.infer<z.ZodObject<typeof mixtureInputShape>>,
  extra?: ToolExtra,
): Promise<{ results: MixtureItem[]; error?: string }> {
  return withMcpToolSpan({ "tool.name": "code_mixture" }, async () => {
    await ensureFreshConfig(deps.reloader);
    const state = deps.holder.state;
    const requested = new Set(input.services ?? []);
    const progressToken = extra?._meta?.progressToken;
    const counter = { value: 0 };

    const candidates: string[] = [];
    for (const [name, svc] of Object.entries(state.config.services)) {
      if (!svc.enabled) continue;
      if (!(name in state.dispatchers)) continue;
      if (requested.size > 0 && !requested.has(name)) continue;
      const breaker = state.router.getBreaker(name);
      if (breaker && breaker.isTripped) continue;
      const disp = state.dispatchers[name];
      if (!disp?.isAvailable()) continue;
      candidates.push(name);
    }

    if (candidates.length === 0) {
      return {
        results: [],
        error:
          "No candidate services available for code_mixture. Check breaker " +
          "state via get_quota_status, or relax the `services` filter.",
      };
    }

    const prompt = input.prompt;
    const files = input.files ?? [];
    const workingDir = input.workingDir ?? process.cwd();

    const outcomes = await Promise.all(
      candidates.map(async (svcName): Promise<MixtureItem> => {
        const svc = state.config.services[svcName]!;
        const t0 = Date.now();
        let result: DispatchResult;
        if (progressToken !== undefined) {
          let captured: DispatchResult | null = null;
          for await (const { event } of state.router.streamTo(svcName, prompt, files, workingDir)) {
            await emitProgress(extra, progressToken, counter, event, svcName);
            if (event.type === "completion") captured = event.result;
          }
          result = captured ?? {
            output: "",
            service: svcName,
            success: false,
            error: "Stream ended without completion",
          };
        } else {
          const outcome = await state.router.routeTo(svcName, prompt, files, workingDir);
          result = outcome.result;
        }
        const item: MixtureItem = {
          service: svcName,
          model: svc.model ?? "",
          tier: svc.tier ?? "subscription",
          success: result.success,
          output: result.output,
          durationMs: Date.now() - t0,
        };
        if (result.error !== undefined) item.error = result.error;
        return item;
      }),
    );

    outcomes.sort((a, b) => {
      if (a.success !== b.success) return a.success ? -1 : 1;
      // Tie-break by tier (subscription before metered) then duration.
      if (a.tier !== b.tier) return a.tier === "subscription" ? -1 : 1;
      return a.durationMs - b.durationMs;
    });
    return { results: outcomes };
  });
}

export async function handleQuotaStatus(deps: ToolDeps): Promise<Record<string, unknown>> {
  await ensureFreshConfig(deps.reloader);
  const state = deps.holder.state;
  const quota = await state.quota.fullStatus();
  const breakers = state.router.circuitBreakerStatus();
  const out: Record<string, unknown> = {};
  const names = new Set([...Object.keys(quota), ...Object.keys(breakers)]);
  for (const name of names) {
    out[name] = {
      ...(quota[name] ?? {}),
      circuitBreaker: breakers[name] ?? { tripped: false, failures: 0 },
    };
  }
  return out;
}

function fmtTokens(n: number | undefined): string {
  if (n === undefined) return "?";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return `${n}`;
}

export async function handleDashboard(deps: ToolDeps): Promise<string> {
  await ensureFreshConfig(deps.reloader);
  const state = deps.holder.state;
  const quota = await state.quota.fullStatus();
  const breakers = state.router.circuitBreakerStatus();

  const lines: string[] = [];
  lines.push("harness-router-mcp — status dashboard", "");

  const priority = state.config.modelPriority ?? [];
  if (priority.length > 0) {
    lines.push(`  model priority: ${priority.join(" → ")}`);
    lines.push("");
  }

  const byTier: Map<string, string[]> = new Map();
  for (const name of Object.keys(state.config.services)) {
    const svc = state.config.services[name]!;
    const tier = svc.tier ?? "subscription";
    const bucket = byTier.get(tier);
    if (bucket) bucket.push(name);
    else byTier.set(tier, [name]);
  }

  const tierLabels: Record<string, string> = {
    subscription: "Subscription — flat-rate, zero marginal cost",
    metered: "Metered — per-token API",
  };

  for (const tier of ["subscription", "metered"].filter((t) => byTier.has(t))) {
    lines.push(`── ${tierLabels[tier]} ──────────────────────────────`);
    lines.push("");
    for (const name of byTier.get(tier)!) {
      const svc = state.config.services[name]!;
      const dispatcher = state.dispatchers[name];
      const reachable = dispatcher?.isAvailable() ?? false;
      const icon = reachable && svc.enabled ? "✓" : "✗";
      lines.push(`  [${icon}] ${name.toUpperCase()}`);
      if (svc.model) lines.push(`      model      : ${svc.model}`);
      if (svc.type === "openai_compatible") {
        lines.push(`      connection : HTTP API  ${svc.baseUrl ?? "(no base_url)"}`);
      } else {
        lines.push(`      connection : ${svc.command ?? "(no command)"}`);
      }
      lines.push(
        `      limits     : output-cap ${fmtTokens(svc.maxOutputTokens)}, context ${fmtTokens(svc.maxInputTokens)}`,
      );

      const q = quota[name];
      if (q && q.remaining !== null && q.limit !== null && q.limit > 0) {
        const pct = Math.round((q.remaining / q.limit) * 100);
        const bar = "█".repeat(Math.round(pct / 5)) + "░".repeat(20 - Math.round(pct / 5));
        lines.push(`      quota      : [${bar}] ${pct}%  (${q.remaining}/${q.limit})`);
      } else {
        const pct = q ? Math.round(q.score * 100) : 100;
        lines.push(`      quota      : ${pct}% assumed available`);
      }
      const calls = q?.localCallCount ?? 0;
      lines.push(`      calls      : ${calls} this session`);

      const b = breakers[name];
      if (b?.tripped) {
        const cd = b.cooldownRemainingSec ?? 0;
        lines.push(`      breaker    : ⚡ OPEN — ${Math.round(cd)}s until reset`);
      } else {
        lines.push(`      breaker    : closed  (${b?.failures ?? 0} recent failures)`);
      }
      if (!svc.enabled) lines.push("      note       : disabled in config");
      lines.push("");
    }
  }

  const ready = Object.entries(state.config.services)
    .filter(([name, svc]) => svc.enabled && state.dispatchers[name]?.isAvailable())
    .map(([name]) => name);
  lines.push(`Ready to route: ${ready.length === 0 ? "none" : ready.join(", ")}`);

  const decision = await state.router.pickService();
  if (decision) {
    lines.push(
      `Next pick     : ${decision.service} for model=${decision.model} tier=${decision.tier} (quota ${decision.quotaScore.toFixed(2)})`,
    );
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Registration with McpServer
// ---------------------------------------------------------------------------

export const TOOL_NAMES = ["code", "code_mixture", "dashboard", "get_quota_status"] as const;

export function registerTools(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "code",
    {
      title: "Run a coding task",
      description:
        "Route a coding task through the configured model priority list. " +
        "Subscription-backed CLIs are tried first; metered API is the fallback. " +
        "Use `hints.model` to bump a specific model to the front, or `hints.service` to force a specific dispatcher.",
      inputSchema: codeInputShape,
    },
    async (args, extra) => jsonText(await handleCode(deps, args, extra as ToolExtra)),
  );

  server.registerTool(
    "code_mixture",
    {
      title: "Fan out a coding task to multiple services",
      description:
        "Run the same prompt against every available service in parallel. " +
        "Returns one result per service; the caller synthesises. " +
        "Useful for design questions where multiple perspectives help.",
      inputSchema: mixtureInputShape,
    },
    async (args, extra) => jsonText(await handleCodeMixture(deps, args, extra as ToolExtra)),
  );

  server.registerTool(
    "dashboard",
    {
      title: "Service status dashboard",
      description:
        "Multi-line text dashboard — model priority, per-service reachability, " +
        "quota, circuit-breaker state, and the router's current pick.",
      inputSchema: {} as const,
    },
    async () => plainText(await handleDashboard(deps)),
  );

  server.registerTool(
    "get_quota_status",
    {
      title: "Get quota + breaker state (JSON)",
      description: "Per-service quota and circuit-breaker state, JSON-shaped for tooling.",
      inputSchema: {} as const,
    },
    async () => jsonText(await handleQuotaStatus(deps)),
  );
}

// ---------------------------------------------------------------------------
// Test convenience — invoke a tool handler by name without going through MCP.
// ---------------------------------------------------------------------------

export type InvokeResult = { kind: "json"; data: unknown } | { kind: "text"; data: string };

export async function invokeTool(
  name: string,
  args: unknown,
  deps: ToolDeps,
): Promise<InvokeResult> {
  switch (name) {
    case "code": {
      const parsed = z.object(codeInputShape).parse(args);
      return { kind: "json", data: await handleCode(deps, parsed) };
    }
    case "code_mixture": {
      const parsed = z.object(mixtureInputShape).parse(args);
      return { kind: "json", data: await handleCodeMixture(deps, parsed) };
    }
    case "dashboard":
      return { kind: "text", data: await handleDashboard(deps) };
    case "get_quota_status":
      return { kind: "json", data: await handleQuotaStatus(deps) };
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
