/**
 * MCP server smoke tests.
 *
 * Uses the SDK's `InMemoryTransport.createLinkedPair()` so the client and
 * server can exchange JSON-RPC frames entirely in-process.
 */

import { describe, expect, it } from "vitest";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { registerTools, TOOL_NAMES } from "../../src/mcp/tools.js";
import { RuntimeHolder, type RuntimeState } from "../../src/mcp/config-hot-reload.js";
import { Router } from "../../src/router.js";
import { QuotaCache } from "../../src/quota.js";
import { QuotaStore } from "../../src/state/quota-store.js";
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
  constructor(
    id: string,
    private readonly reply: string,
  ) {
    this.id = id;
  }
  async dispatch(): Promise<DispatchResult> {
    return { output: this.reply, service: this.id, success: true };
  }
  async checkQuota(): Promise<QuotaInfo> {
    return { service: this.id, source: "unknown" };
  }
  async *stream(): AsyncIterable<DispatcherEvent> {
    yield {
      type: "completion",
      result: { output: this.reply, service: this.id, success: true },
    };
  }
  isAvailable(): boolean {
    return true;
  }
}

function makeSvc(name: string, harness: string, model: string): ServiceConfig {
  return {
    name,
    enabled: true,
    type: "cli",
    harness,
    command: name,
    model,
    tier: "subscription",
    maxOutputTokens: 64_000,
    maxInputTokens: 1_000_000,
  };
}

function buildState(): RuntimeState {
  const services = {
    a: makeSvc("a", "claude_code", "claude-opus-4.7"),
    b: makeSvc("b", "codex", "gpt-5.4"),
  };
  const dispatchers: Record<string, Dispatcher> = {
    a: new StubDispatcher("a", "answer-from-a"),
    b: new StubDispatcher("b", "answer-from-b"),
  };
  const config: RouterConfig = {
    services,
    modelPriority: ["claude-opus-4.7", "gpt-5.4"],
  };
  const quota = new QuotaCache(dispatchers, {
    store: new QuotaStore({ path: ":memory:", skipMkdir: true }),
  });
  const router = new Router(config, quota, dispatchers);
  return { config, dispatchers, quota, router, mtimeMs: 0 };
}

async function startLinked(): Promise<{
  client: Client;
  server: McpServer;
  close: () => Promise<void>;
}> {
  const server = new McpServer(
    { name: "harness-router-mcp-test", version: "test" },
    { instructions: "test server" },
  );
  const holder = new RuntimeHolder(buildState());
  registerTools(server, { holder });

  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "test" }, { capabilities: {} });

  await server.connect(serverT);
  await client.connect(clientT);

  return {
    client,
    server,
    async close() {
      await client.close();
      await server.close();
    },
  };
}

describe("MCP server — registration", () => {
  it("registers all four tools via McpServer.registerTool", async () => {
    const { client, close } = await startLinked();
    try {
      const resp = await client.listTools();
      const names = resp.tools.map((t) => t.name).sort();
      expect(names).toEqual([...TOOL_NAMES].sort());
      for (const t of resp.tools) {
        expect(t.inputSchema).toBeDefined();
        expect(t.inputSchema.type).toBe("object");
      }
    } finally {
      await close();
    }
  });

  it("code round-trips through the in-memory transport", async () => {
    const { client, close } = await startLinked();
    try {
      const resp = await client.callTool({
        name: "code",
        arguments: { prompt: "say hi" },
      });
      expect(resp.isError).not.toBe(true);
      const content = resp.content as Array<{ type: string; text: string }>;
      expect(content).toHaveLength(1);
      expect(content[0]!.type).toBe("text");
      const parsed = JSON.parse(content[0]!.text) as {
        success: boolean;
        service: string;
        output: string;
        routing?: { model: string; tier: string };
      };
      expect(parsed.success).toBe(true);
      // First model in priority is claude-opus-4.7 → service "a".
      expect(parsed.service).toBe("a");
      expect(parsed.output.length).toBeGreaterThan(0);
      expect(parsed.routing).toBeDefined();
      expect(parsed.routing?.tier).toBe("subscription");
    } finally {
      await close();
    }
  });

  it("dashboard returns a text content block", async () => {
    const { client, close } = await startLinked();
    try {
      const resp = await client.callTool({
        name: "dashboard",
        arguments: {},
      });
      const content = resp.content as Array<{ type: string; text: string }>;
      expect(content[0]!.type).toBe("text");
      expect(content[0]!.text).toContain("harness-router-mcp");
    } finally {
      await close();
    }
  });

  it("get_quota_status returns JSON with breaker state", async () => {
    const { client, close } = await startLinked();
    try {
      const resp = await client.callTool({
        name: "get_quota_status",
        arguments: {},
      });
      const content = resp.content as Array<{ type: string; text: string }>;
      const parsed = JSON.parse(content[0]!.text) as Record<string, unknown>;
      expect(Object.keys(parsed).sort()).toEqual(["a", "b"]);
    } finally {
      await close();
    }
  });
});
