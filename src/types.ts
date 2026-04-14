/**
 * STUB — owned by Agent 1 (types). Agent 4 placed this file so that router
 * tests could run in isolation; at merge time Agent 1's `src/types.ts`
 * replaces this file wholesale. Keep the exported names identical to the
 * R1-HANDOFF type shapes so nothing breaks.
 */

export type TaskType = "execute" | "plan" | "review" | "local" | "";
export type ThinkingLevel = "low" | "medium" | "high";

export interface ServiceConfig {
  name: string;
  enabled: boolean;
  type: "cli" | "openai_compatible";
  harness?: string;
  command?: string;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  tier: number;
  weight: number;
  cliCapability: number;
  leaderboardModel?: string;
  thinkingLevel?: ThinkingLevel;
  escalateModel?: string;
  escalateOn: TaskType[];
  capabilities: Partial<Record<"execute" | "plan" | "review", number>>;
}

export interface RouterConfig {
  services: Record<string, ServiceConfig>;
  geminiApiKey?: string;
  disabled?: readonly string[];
}

export interface RoutingDecision {
  service: string;
  tier: number;
  quotaScore: number;
  qualityScore: number;
  cliCapability: number;
  capabilityScore: number;
  taskType: TaskType;
  model: string | undefined;
  elo: number | undefined;
  finalScore: number;
  reason: string;
}

export interface RouteHints {
  service?: string;
  preferLargeContext?: boolean;
  taskType?: TaskType;
  harness?: string;
}

export interface DispatchResult {
  output: string;
  service: string;
  success: boolean;
  error?: string;
  rateLimited?: boolean;
  retryAfter?: number;
  rateLimitHeaders?: Record<string, string>;
}

export interface QuotaInfo {
  service: string;
  used: number | null;
  limit: number | null;
  remaining: number | null;
  resetAt: string | null;
  source: "json" | "file" | "headers" | "api" | "unknown";
}

export type DispatcherEvent =
  | { kind: "stdout"; chunk: string }
  | { kind: "stderr"; chunk: string }
  | { kind: "done"; result: DispatchResult };
