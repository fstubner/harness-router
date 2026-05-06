/**
 * HTTP MCP server integration tests.
 *
 * These exercise the actual `startMcpHttpServer` entry point with a real
 * loopback HTTP listener and the SDK's `StreamableHTTPClientTransport`. The
 * focus is the multi-session story — the previous implementation had a
 * `connected` flag that made every session after the first hang because the
 * second `server.connect()` would have thrown. This test guards against
 * regression by spinning up TWO clients sequentially against the same HTTP
 * server and verifying both can roundtrip a tool call.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { startMcpHttpServer, type HttpMcpHandle } from "../../src/mcp/server.js";

let configPath: string;
let server: HttpMcpHandle | undefined;

beforeEach(async () => {
  // Redirect the SQLite quota state DB to a tmpdir so this test doesn't
  // touch the host's real ~/.harness-router/state.db.
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "harness-router-http-test-"));
  process.env["HARNESS_ROUTER_STATE_DB"] = path.join(tmp, "state.db");

  // Minimal v0.3 config — empty models map. Enough to exercise HTTP plumbing.
  configPath = path.join(tmp, "config.yaml");
  await fs.writeFile(configPath, "priority: []\nmodels: {}\n", "utf8");

  // Avoid OTel SDK init noise in tests.
  process.env["OTEL_SDK_DISABLED"] = "true";
});

afterEach(async () => {
  if (server) {
    await server.close();
    server = undefined;
  }
  delete process.env["OTEL_SDK_DISABLED"];
  delete process.env["HARNESS_ROUTER_STATE_DB"];
  vi.restoreAllMocks();
});

async function newClient(port: number): Promise<{ client: Client; close: () => Promise<void> }> {
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
  const client = new Client({ name: "http-test-client", version: "0" }, { capabilities: {} });
  // The SDK's StreamableHTTPClientTransport is a proper Transport at runtime,
  // but its `sessionId: string | undefined` is incompatible with the
  // `exactOptionalPropertyTypes`-strict Transport type alias the consumer
  // expects. Cast through unknown — purely a type-system mismatch, not a
  // runtime issue, and the rest of the type system still catches misuse.
  await client.connect(transport as unknown as Parameters<typeof client.connect>[0]);
  return {
    client,
    close: async () => {
      await client.close();
    },
  };
}

describe("startMcpHttpServer — single session", () => {
  it("listTools roundtrips over real HTTP transport", async () => {
    server = await startMcpHttpServer({ configPath });
    const { client, close } = await newClient(server.port);
    try {
      const resp = await client.listTools();
      // v0.3 single-tool surface — regardless of services configured.
      const names = resp.tools.map((t) => t.name);
      expect(names).toEqual(["code"]);
    } finally {
      await close();
    }
  });
});

describe("startMcpHttpServer — multi-session (regression)", () => {
  it("two sequential sessions both succeed (the connected-flag bug)", async () => {
    // The previous implementation guarded `server.connect(transport)` with
    // a `connected` flag because the SDK's Protocol.connect() throws on a
    // second call. Net effect: session 1 worked, session 2's transport
    // was never wired to McpServer and silently hung. The fix builds a
    // per-session McpServer; this test asserts both sessions can roundtrip
    // AND that they see the same tool list (audit B: WEAK-7 strengthened
    // the assertion to compare lists, so a stale-session bug couldn't
    // pass this test by serving wrong data).
    server = await startMcpHttpServer({ configPath });

    let firstToolNames: string[] = [];
    const a = await newClient(server.port);
    try {
      const r1 = await a.client.listTools();
      firstToolNames = r1.tools.map((t) => t.name).sort();
      expect(firstToolNames.length).toBeGreaterThan(0);
    } finally {
      await a.close();
    }

    // Second session — would have hung on the old code. Compare the tool
    // list against session A's result so a regression that returns a
    // partial / stale list also fails this test.
    const b = await newClient(server.port);
    try {
      const r2 = await b.client.listTools();
      const secondToolNames = r2.tools.map((t) => t.name).sort();
      expect(secondToolNames).toEqual(firstToolNames);
    } finally {
      await b.close();
    }
  });

  it("two concurrent sessions both succeed", async () => {
    server = await startMcpHttpServer({ configPath });

    const [a, b] = await Promise.all([newClient(server.port), newClient(server.port)]);
    try {
      const [r1, r2] = await Promise.all([a.client.listTools(), b.client.listTools()]);
      expect(r1.tools.length).toBeGreaterThan(0);
      expect(r2.tools.length).toBeGreaterThan(0);
      // Both responses should be the same shape — they're talking to the
      // same shared runtime (config / dispatchers / quota) under the hood.
      expect(r1.tools.map((t) => t.name).sort()).toEqual(r2.tools.map((t) => t.name).sort());
    } finally {
      await Promise.all([a.close(), b.close()]);
    }
  });
});
