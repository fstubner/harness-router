/**
 * Shared test fixtures: a fake Dispatcher, a ServiceConfig builder, and a
 * RuntimeHolder builder. Used by every test that needs an in-memory
 * router/quota/dispatcher trio.
 *
 * Three test files used to inline near-identical versions of these:
 * tests/mcp/tools.test.ts (FakeDispatcher / makeService / buildHolder),
 * tests/mcp/server.test.ts (StubDispatcher / makeSvc / buildState),
 * tests/router.test.ts (its own ad-hoc fixtures). Centralising here
 * removes ~100 LOC of near-duplicate scaffolding and makes future
 * runtime-shape changes a one-place edit.
 */

import { Router } from "../../src/router.js";
import { QuotaCache } from "../../src/quota.js";
import { QuotaStore } from "../../src/state/quota-store.js";
import { RuntimeHolder, type RuntimeState } from "../../src/mcp/config-hot-reload.js";
import type { Dispatcher } from "../../src/dispatchers/base.js";
import type {
  DispatchResult,
  DispatcherEvent,
  QuotaInfo,
  RouterConfig,
  ServiceConfig,
} from "../../src/types.js";

/**
 * Fake dispatcher whose every async surface returns the same canned
 * DispatchResult. Defaults to a successful "hello" response; callers
 * override per-instance for failure / specific-output tests.
 */
export class FakeDispatcher implements Dispatcher {
  readonly id: string;
  constructor(
    id: string,
    private readonly response: DispatchResult = {
      output: "hello",
      service: id,
      success: true,
    },
    private readonly available = true,
  ) {
    this.id = id;
  }
  async dispatch(): Promise<DispatchResult> {
    return this.response;
  }
  async checkQuota(): Promise<QuotaInfo> {
    return { service: this.id, source: "unknown" };
  }
  async *stream(): AsyncIterable<DispatcherEvent> {
    yield { type: "completion", result: this.response };
  }
  isAvailable(): boolean {
    return this.available;
  }
}

/**
 * Build a ServiceConfig with sensible defaults. `name` becomes the
 * synthetic service id, `harness` defaults to `name`, `model` defaults
 * to `<name>-model`. Override anything via the second arg.
 */
export function makeService(name: string, over: Partial<ServiceConfig> = {}): ServiceConfig {
  return {
    name,
    enabled: true,
    type: "cli",
    harness: name,
    command: name,
    model: `${name}-model`,
    tier: "subscription",
    maxOutputTokens: 64_000,
    maxInputTokens: 1_000_000,
    ...over,
  };
}

/**
 * Build a RuntimeHolder with the given services + dispatchers wired
 * through Router + QuotaCache (in-memory SQLite store, no host disk
 * touch).
 *
 * `modelPriority` defaults to "every service's model field, declaration
 * order" — sufficient for tests that just want the router to walk
 * something. Override for priority-walk-specific tests.
 */
export function buildHolder(
  services: Record<string, ServiceConfig>,
  dispatchers: Record<string, Dispatcher>,
  modelPriority?: readonly string[],
): RuntimeHolder {
  const priority =
    modelPriority ??
    Object.values(services)
      .map((s) => s.model ?? "")
      .filter(Boolean);
  const config: RouterConfig = { services, modelPriority: priority };
  const quota = new QuotaCache(dispatchers, {
    store: new QuotaStore({ path: ":memory:", skipMkdir: true }),
  });
  const router = new Router(config, quota, dispatchers);
  const state: RuntimeState = { config, dispatchers, quota, router, mtimeMs: 0 };
  return new RuntimeHolder(state);
}

/**
 * Build a RuntimeState directly (no holder). Use this when the test
 * needs to inject the state into something other than a RuntimeHolder.
 */
export function buildState(
  services: Record<string, ServiceConfig>,
  dispatchers: Record<string, Dispatcher>,
  modelPriority?: readonly string[],
): RuntimeState {
  const priority =
    modelPriority ??
    Object.values(services)
      .map((s) => s.model ?? "")
      .filter(Boolean);
  const config: RouterConfig = { services, modelPriority: priority };
  const quota = new QuotaCache(dispatchers, {
    store: new QuotaStore({ path: ":memory:", skipMkdir: true }),
  });
  const router = new Router(config, quota, dispatchers);
  return { config, dispatchers, quota, router, mtimeMs: 0 };
}
