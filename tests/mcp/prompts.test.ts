/**
 * MCP prompt registration tests.
 *
 * Round-trip listPrompts() and getPrompt() through the SDK's in-memory
 * transport to confirm prompts are advertised and rendered correctly.
 */

import { describe, expect, it } from "vitest";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { registerPrompts } from "../../src/mcp/prompts.js";
import { RuntimeHolder, type RuntimeState } from "../../src/mcp/config-hot-reload.js";
import { Router } from "../../src/router.js";
import { QuotaCache } from "../../src/quota.js";
import type { Dispatcher } from "../../src/dispatchers/base.js";
import type {
  DispatchResult,
  DispatcherEvent,
  QuotaInfo,
  RouterConfig,
  ServiceConfig,
} from "../../src/types.js";

class StubDispatcher implements Dispatcher {
  readonly id: string;
  constructor(id: string) {
    this.id = id;
  }
  async dispatch(): Promise<DispatchResult> {
    return { output: "", service: this.id, success: true };
  }
  async checkQuota(): Promise<QuotaInfo> {
    return { service: this.id, source: "unknown" };
  }
  async *stream(): AsyncIterable<DispatcherEvent> {
    yield { type: "completion", result: { output: "", service: this.id, success: true } };
  }
  isAvailable(): boolean {
    return true;
  }
}

function makeSvc(name: string, harness: string): ServiceConfig {
  return {
    name,
    enabled: true,
    type: "cli",
    harness,
    command: name,
    model: `${name}-model`,
    tier: "subscription",
  };
}

function buildState(): RuntimeState {
  const services = { a: makeSvc("a", "claude_code") };
  const dispatchers: Record<string, Dispatcher> = { a: new StubDispatcher("a") };
  const config: RouterConfig = { services, modelPriority: ["a-model"] };
  const quota = new QuotaCache(dispatchers);
  const router = new Router(config, quota, dispatchers);
  return { config, dispatchers, quota, router, mtimeMs: 0 };
}

async function startLinked(): Promise<{ client: Client; close: () => Promise<void> }> {
  const server = new McpServer(
    { name: "harness-router-mcp-test", version: "test" },
    { instructions: "test server" },
  );
  const holder = new RuntimeHolder(buildState());
  registerPrompts(server, { holder });

  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "test" }, { capabilities: {} });

  await server.connect(serverT);
  await client.connect(clientT);

  return {
    client,
    async close() {
      await client.close();
      await server.close();
    },
  };
}

describe("MCP prompts", () => {
  it("advertises the three prompts", async () => {
    const { client, close } = await startLinked();
    try {
      const resp = await client.listPrompts();
      const names = resp.prompts.map((p) => p.name).sort();
      expect(names).toEqual(["compare-models", "health-check", "route-task"]);
      for (const p of resp.prompts) {
        expect(p.description).toBeTruthy();
      }
    } finally {
      await close();
    }
  });

  it("route-task interpolates the task and the model override", async () => {
    const { client, close } = await startLinked();
    try {
      const resp = await client.getPrompt({
        name: "route-task",
        arguments: { task: "rename foo to bar", model: "claude-opus-4.7" },
      });
      const text = (resp.messages[0]!.content as { text: string }).text;
      expect(text).toContain("rename foo to bar");
      expect(text).toContain('hints.model: "claude-opus-4.7"');
      expect(text).toContain("`code`");
    } finally {
      await close();
    }
  });

  it("compare-models points at code_mixture", async () => {
    const { client, close } = await startLinked();
    try {
      const resp = await client.getPrompt({
        name: "compare-models",
        arguments: { task: "design a rate limiter" },
      });
      const text = (resp.messages[0]!.content as { text: string }).text;
      expect(text).toContain("code_mixture");
      expect(text).toContain("design a rate limiter");
    } finally {
      await close();
    }
  });

  it("health-check needs no arguments and lists the inspection tools", async () => {
    const { client, close } = await startLinked();
    try {
      const resp = await client.getPrompt({
        name: "health-check",
        arguments: {},
      });
      const text = (resp.messages[0]!.content as { text: string }).text;
      expect(text).toContain("dashboard");
      expect(text).toContain("get_quota_status");
    } finally {
      await close();
    }
  });
});
