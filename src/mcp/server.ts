/**
 * MCP server entry points for harness-router.
 *
 * Exposes:
 *   startMcpServer({ configPath })            — stdio transport (default).
 *   startMcpHttpServer({ configPath, port })  — streamable-HTTP transport.
 *
 * Both functions return a handle with `close()` so the caller (tests, bin.ts)
 * can shut the server down cleanly.
 */

import { createServer, type Server as HttpServer } from "node:http";
import { randomUUID } from "node:crypto";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import {
  bootstrapRuntime,
  ConfigHotReloader,
  RuntimeHolder,
  type RuntimeState,
} from "./config-hot-reload.js";
import { registerTools } from "./tools.js";
import { registerResources } from "./resources.js";
import { compareBearerToken, openAuthTokenStore, parseBearerHeader } from "../auth/token.js";
import { initObservability } from "../observability/index.js";
import { VERSION } from "../version.js";

const SERVER_NAME = "harness-router";
const SERVER_VERSION = VERSION;

const SERVER_INSTRUCTIONS =
  "Model-first router: walks the user's `priority` model list, preferring " +
  "subscription-backed routes over metered API. Use the `code` tool for " +
  'coding tasks. In default `mode: "single"`, pass `hints.model` to bump ' +
  "a model to the front of the priority list or `hints.service` to force an " +
  'internal route id. Use `mode: "fanout"` with `models` to run the same ' +
  "prompt across multiple configured model routes for synthesis. Inspect " +
  "routing state via MCP resources: `harness-router://status` for text and " +
  "`harness-router://status.json` for JSON. If no routes are configured or " +
  "reachable, run `harness-router onboard` or `harness-router doctor` from " +
  "the terminal.";

// ---------------------------------------------------------------------------
// Builder — shared between stdio and HTTP entry points
// ---------------------------------------------------------------------------

export interface BuildMcpOptions {
  /** Path to config.yaml. Omit to use ~/.harness-router/config.yaml. */
  configPath?: string;
}

export interface BuiltMcp {
  server: McpServer;
  holder: RuntimeHolder;
  reloader: ConfigHotReloader;
}

/**
 * Log a one-line summary of the routing state to stderr at server start.
 * Uses stderr so it can't pollute the stdio JSON-RPC channel; MCP hosts
 * surface stderr in their server logs, which is where users look when the
 * router isn't doing what they expect.
 */
function logStartupBanner(state: RuntimeState): void {
  const services = Object.values(state.config.services).filter((s) => s.enabled);
  const reachable = services.filter((s) => state.dispatchers[s.name]?.isAvailable());
  const subscription = reachable.filter((s) => (s.tier ?? "subscription") === "subscription");
  const metered = reachable.filter((s) => s.tier === "metered");
  const priority = state.config.modelPriority ?? [];

  const ready = reachable.map((s) => s.name).join(", ") || "(none)";
  process.stderr.write(
    `[harness-router v${SERVER_VERSION}] ` +
      `${reachable.length}/${services.length} services reachable ` +
      `(${subscription.length} subscription, ${metered.length} metered) | ` +
      `priority: ${priority.length > 0 ? priority.join(" → ") : "(empty — no models declared)"}\n`,
  );
  process.stderr.write(`[harness-router] ready: ${ready}\n`);
  if (reachable.length === 0) {
    process.stderr.write(
      "[harness-router] no services reachable. Run `harness-router doctor` " +
        "to see what needs installing or authenticating.\n",
    );
  }
}

/** Bootstrap runtime state + build an `McpServer` with all tools registered. */
export async function buildMcpServer(opts: BuildMcpOptions = {}): Promise<BuiltMcp> {
  // Initialize OpenTelemetry once. Idempotent; no-op when OTEL_SDK_DISABLED=true.
  await initObservability();

  const stateOpts: { configPath?: string } = {};
  if (opts.configPath !== undefined) stateOpts.configPath = opts.configPath;
  const state = await bootstrapRuntime(stateOpts);
  const holder = new RuntimeHolder(state);
  const reloader = new ConfigHotReloader(holder, opts.configPath);

  logStartupBanner(state);

  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: SERVER_INSTRUCTIONS },
  );
  registerTools(server, { holder, reloader });
  registerResources(server, { holder, reloader });
  return { server, holder, reloader };
}

// ---------------------------------------------------------------------------
// stdio
// ---------------------------------------------------------------------------

export interface McpHandle {
  close(): Promise<void>;
}

/**
 * Start an MCP server bound to stdio (the default transport for desktop
 * hosts like Claude Desktop and Cursor). The returned handle's `close()`
 * stops the hot-reloader, flushes the QuotaCache, and shuts down the
 * server cleanly.
 *
 * Single-session by design — stdio is one process, one client.
 *
 * @see startMcpHttpServer for the multi-session HTTP transport.
 */
export async function startMcpServer(opts: BuildMcpOptions = {}): Promise<McpHandle> {
  const { server, holder, reloader } = await buildMcpServer(opts);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return {
    async close() {
      // Stop the reloader BEFORE closing the server so a concurrent
      // reload can't swap in a fresh runtime state during shutdown
      // (audit pass A: BUG-A3).
      try {
        await reloader.stop();
      } catch {
        /* best-effort */
      }
      // Flush any pending quota writes so counts persist across restarts.
      // Audit pass A flagged that the stdio path was leaking the
      // QuotaCache's writeChain on shutdown.
      try {
        await holder.state.quota.flush();
      } catch {
        /* best-effort */
      }
      await server.close();
    },
  };
}

// ---------------------------------------------------------------------------
// HTTP (streamable)
// ---------------------------------------------------------------------------

export interface HttpMcpHandle extends McpHandle {
  /** The actual port the HTTP server is listening on. */
  port: number;
}

export interface StartHttpOptions extends BuildMcpOptions {
  port?: number;
  /** Path the MCP endpoint is mounted at. Defaults to `/mcp`. */
  route?: string;
  /**
   * Bind address. Default: `127.0.0.1`. Anything other than 127.0.0.1 / ::1 /
   * localhost force-enables bearer-token auth — see src/auth/token.ts.
   */
  bind?: string;
  /** When true, require bearer-token auth even for loopback. Default: false. */
  requireAuth?: boolean;
}

/**
 * Start an MCP server over Streamable-HTTP transport. Multi-session: each
 * incoming connection gets its own `McpServer` + transport pair (per the
 * SDK pattern — `Protocol.connect()` throws on a second call to one
 * server instance). The shared runtime state (config, dispatchers,
 * quota cache, hot-reloader) is built once and reused across sessions.
 *
 * Threat boundary: NO authentication is configured by default. Bind to
 * loopback for desktop-host use, or place a reverse proxy in front
 * for remote use. Session IDs are UUIDv4 (128-bit, unguessable).
 *
 * @see startMcpServer for the stdio transport (single session).
 */
export async function startMcpHttpServer(opts: StartHttpOptions = {}): Promise<HttpMcpHandle> {
  // The MCP SDK's `Protocol.connect()` throws if called twice on the same
  // server instance ("Already connected to a transport"). So for stateful
  // multi-session HTTP we follow the official `simpleStreamableHttp` pattern:
  // share the heavy bootstrap (config, dispatchers, runtime holder, hot
  // reloader) across sessions, but spin up a fresh `McpServer` + `transport`
  // pair per session. The shared holder means tools see the same live
  // routing state regardless of which session called them.
  await initObservability();
  const stateOpts: { configPath?: string } = {};
  if (opts.configPath !== undefined) stateOpts.configPath = opts.configPath;
  const state = await bootstrapRuntime(stateOpts);
  const holder = new RuntimeHolder(state);
  const reloader = new ConfigHotReloader(holder, opts.configPath);

  const route = opts.route ?? "/mcp";
  const port = opts.port ?? 0;
  const bind = opts.bind ?? "127.0.0.1";
  const isLoopback = bind === "127.0.0.1" || bind === "::1" || bind === "localhost";

  // Auth gate: optional for loopback (off by default), forced for non-loopback.
  // The token is read from disk at server-start; rotating it requires a
  // restart. That's intentional — token rotation is a deliberate event,
  // not a hot-reload concern.
  const authRequired = !isLoopback || opts.requireAuth === true;
  let authToken: string | null = null;
  if (authRequired) {
    const store = openAuthTokenStore();
    authToken = store.read();
    if (!authToken) {
      // Auto-create when binding non-loopback. The user can rotate later.
      authToken = store.create();
      process.stderr.write(
        `[harness-router] auth: created bearer token at ${store.path} ` +
          `(non-loopback bind requires auth). ` +
          `Send via \`Authorization: Bearer <token>\`.\n`,
      );
    }
  }

  const isLoopbackRemote = (remote: string | undefined): boolean => {
    if (!remote) return false;
    return (
      remote === "127.0.0.1" ||
      remote === "::1" ||
      remote === "::ffff:127.0.0.1" ||
      remote.startsWith("127.")
    );
  };

  // One transport AND one McpServer per session. We track both so we can
  // close them on session end and during shutdown.
  const sessions = new Map<
    string,
    { transport: StreamableHTTPServerTransport; server: McpServer }
  >();

  const buildPerSessionServer = (): McpServer => {
    const server = new McpServer(
      { name: SERVER_NAME, version: SERVER_VERSION },
      { instructions: SERVER_INSTRUCTIONS },
    );
    registerTools(server, { holder, reloader });
    registerResources(server, { holder, reloader });
    return server;
  };

  const http: HttpServer = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname !== route) {
        res.statusCode = 404;
        res.end("not found");
        return;
      }

      // Auth gate. Loopback connections always bypass — the OS process
      // boundary is the real boundary there, and forcing every local
      // request to carry a token would just be friction. Non-loopback
      // requests must present a matching bearer token.
      if (authToken) {
        const remote = req.socket.remoteAddress ?? undefined;
        const localOnly = isLoopbackRemote(remote);
        const allowBypass = localOnly && opts.requireAuth !== true;
        if (!allowBypass) {
          const provided = parseBearerHeader(req.headers.authorization);
          if (!provided || !compareBearerToken(provided, authToken)) {
            res.statusCode = 401;
            res.setHeader("WWW-Authenticate", 'Bearer realm="harness-router"');
            res.end("unauthorized");
            return;
          }
        }
      }
      const sessionId = (req.headers["mcp-session-id"] as string | undefined) ?? undefined;
      let transport: StreamableHTTPServerTransport;
      if (sessionId && sessions.has(sessionId)) {
        transport = sessions.get(sessionId)!.transport;
      } else {
        // New session: build a transport AND a per-session McpServer, then
        // connect them. Without the per-session server we'd hit the
        // "Already connected" throw on the second session.
        const sessionServer = buildPerSessionServer();
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid: string) => {
            sessions.set(sid, { transport, server: sessionServer });
          },
        });
        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid) {
            const entry = sessions.get(sid);
            sessions.delete(sid);
            // Best-effort close the per-session server too — frees its
            // hold on the transport callbacks. Errors here are harmless;
            // the transport is already going down.
            entry?.server.close().catch(() => undefined);
          }
        };
        // The SDK's `StreamableHTTPServerTransport` exposes
        // `sessionId: string | undefined` (a getter that may not yet be
        // initialized) while the imported `Transport` type declares it as
        // optional (`?: string`). With `exactOptionalPropertyTypes: true`,
        // those two are structurally different. The runtime is correct;
        // narrow via `Parameters<>` to track the SDK's actual signature
        // — if a future SDK update reshapes `connect()`, this cast becomes
        // an error here rather than silently accepting wrong types.
        await sessionServer.connect(
          transport as unknown as Parameters<typeof sessionServer.connect>[0],
        );
      }
      await transport.handleRequest(req, res);
    } catch (err) {
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end(err instanceof Error ? err.message : String(err));
      } else {
        res.end();
      }
    }
  });

  await new Promise<void>((resolve) => {
    http.listen(port, bind, () => resolve());
  });
  const addr = http.address();
  const actualPort = typeof addr === "object" && addr ? addr.port : port;

  return {
    port: actualPort,
    async close() {
      // Stop the reloader BEFORE iterating sessions. Without this, a
      // concurrent `maybeReload()` could call `holder.replace(next)` mid-
      // shutdown, leaving the new state's dispatchers / quota cache
      // un-flushed (audit pass A: BUG-A3).
      try {
        await reloader.stop();
      } catch {
        /* best-effort */
      }
      // Flush pending quota writes from the SHARED holder before tearing
      // down sessions — every per-session McpServer reads from the same
      // holder, so the quota cache is shared and only needs flushing once.
      try {
        await holder.state.quota.flush();
      } catch {
        /* best-effort */
      }
      // Close every per-session pair. Transport and server may both error
      // on close if the connection was already torn down — swallow.
      for (const { transport, server } of sessions.values()) {
        try {
          await transport.close();
        } catch {
          /* best-effort */
        }
        try {
          await server.close();
        } catch {
          /* best-effort */
        }
      }
      sessions.clear();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}
