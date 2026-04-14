/**
 * coding-agent-mcp — TypeScript rewrite.
 *
 * Public library surface. Stable starting at R3.
 */

export { Router } from "./router.js";
export { CircuitBreaker } from "./circuit-breaker.js";
export { QuotaCache, QuotaState } from "./quota.js";
export { LeaderboardCache } from "./leaderboard.js";
export { loadConfig, watchConfig } from "./config.js";
export * from "./types.js";
export type { Dispatcher, DispatchOpts } from "./dispatchers/base.js";

export const VERSION = "1.0.0-alpha.0";
