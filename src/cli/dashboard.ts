/**
 * `harness-router dashboard [--watch]` — text status of every configured
 * service: model, tier, quota, breaker state, the router's current pick.
 *
 * `--watch` re-renders every `intervalMs` (default 1000). Ctrl-C exits.
 */

import { Router } from "../router.js";
import { loadConfig } from "../config/index.js";
import { QuotaCache } from "../quota.js";
import { buildDispatchers } from "../mcp/dispatcher-factory.js";
import { renderDashboard, type DashboardState, type RecentEvent } from "../dashboard/live.js";

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

export async function cmdDashboard(
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
  const onSigint = (): void => {
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
