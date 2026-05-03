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
import { LeaderboardCache } from "../../src/leaderboard.js";
import type { Dispatcher } from "../../src/dispatchers/base.js";
import type { DispatchResult, QuotaInfo, RouterConfig, ServiceConfig } from "../../src/types.js";

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
  async *stream(): AsyncIterable<never> {
    throw new Error("StubDispatcher.stream() is not implemented");
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
    tier: 1,
    weight: 1.0,
    cliCapability: 1.0,
    capabilities: { execute: 1.0, plan: 1.0, review: 1.0 },
    escalateOn: [],
    leaderboardModel: `${name}-model`,
    maxOutputTokens: 64_000,
    maxInputTokens: 1_000_000,
  };
}

function buildState(): RuntimeState {
  const services = { a: makeSvc("a", "claude_code") };
  const dispatchers: Record<string, Dispatcher> = { a: new StubDispatcher("a") };
  const config: RouterConfig = { services };
  const quota = new QuotaCache(dispatchers);
  const leaderboard = new LeaderboardCache();
  const router = new Router(config, quota, dispatchers, leaderboard);
  return { config, dispatchers, quota, router, leaderboard, mtimeMs: 0 };
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
  it("advertises all five prompts", async () => {
    const { client, close } = await startLinked();
    try {
      const resp = await client.listPrompts();
      const names = resp.prompts.map((p) => p.name).sort();
      expect(names).toEqual([
        "compare-implementations",
        "harness-health-check",
        "onboard-coding-stack",
        "pick-best-harness",
        "route-coding-task",
      ]);
      for (const p of resp.prompts) {
        expect(p.description).toBeTruthy();
      }
    } finally {
      await close();
    }
  });

  it("onboard-coding-stack points at `harness-router-mcp init`", async () => {
    const { client, close } = await startLinked();
    try {
      const resp = await client.getPrompt({
        name: "onboard-coding-stack",
        arguments: {},
      });
      const text = (resp.messages[0]!.content as { text: string }).text;
      expect(text).toContain("harness-router-mcp init");
      expect(text).toContain("elevated shell");
      expect(text).toContain("Cursor");
    } finally {
      await close();
    }
  });

  it("route-coding-task interpolates the task and task_type", async () => {
    const { client, close } = await startLinked();
    try {
      const resp = await client.getPrompt({
        name: "route-coding-task",
        arguments: { task: "rename foo to bar", task_type: "execute" },
      });
      expect(resp.messages).toHaveLength(1);
      const msg = resp.messages[0]!;
      expect(msg.role).toBe("user");
      expect(msg.content.type).toBe("text");
      const text = (msg.content as { text: string }).text;
      expect(text).toContain("rename foo to bar");
      expect(text).toContain('hints.taskType: "execute"');
      expect(text).toContain("code_auto");
    } finally {
      await close();
    }
  });

  it("route-coding-task without task_type leaves routing to the router", async () => {
    const { client, close } = await startLinked();
    try {
      const resp = await client.getPrompt({
        name: "route-coding-task",
        arguments: { task: "review the auth module" },
      });
      const text = (resp.messages[0]!.content as { text: string }).text;
      expect(text).toContain("review the auth module");
      expect(text).toContain("(let the router decide)");
      expect(text).not.toContain("hints.taskType");
    } finally {
      await close();
    }
  });

  it("compare-implementations points at code_mixture", async () => {
    const { client, close } = await startLinked();
    try {
      const resp = await client.getPrompt({
        name: "compare-implementations",
        arguments: { task: "design a rate limiter" },
      });
      const text = (resp.messages[0]!.content as { text: string }).text;
      expect(text).toContain("code_mixture");
      expect(text).toContain("design a rate limiter");
    } finally {
      await close();
    }
  });

  it("harness-health-check needs no arguments and lists the inspection tools", async () => {
    const { client, close } = await startLinked();
    try {
      const resp = await client.getPrompt({
        name: "harness-health-check",
        arguments: {},
      });
      const text = (resp.messages[0]!.content as { text: string }).text;
      expect(text).toContain("list_available_services");
      expect(text).toContain("get_quota_status");
      expect(text).toContain("dashboard");
    } finally {
      await close();
    }
  });

  it("pick-best-harness names every harness type", async () => {
    const { client, close } = await startLinked();
    try {
      const resp = await client.getPrompt({
        name: "pick-best-harness",
        arguments: { task: "refactor a 10k-line file" },
      });
      const text = (resp.messages[0]!.content as { text: string }).text;
      expect(text).toContain("refactor a 10k-line file");
      expect(text).toContain("claude_code");
      expect(text).toContain("cursor");
      expect(text).toContain("codex");
      expect(text).toContain("gemini_cli");
      expect(text).toContain("opencode");
      expect(text).toContain("code_with_");
    } finally {
      await close();
    }
  });
});
