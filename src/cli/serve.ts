/**
 * Server-mode entrypoints used by the bare invocation (stdio) and the
 * explicit `serve` subcommand (HTTP).
 *
 * Both wire SIGINT/SIGTERM through `waitForShutdown` so Ctrl-C cleanly
 * closes the transport, flushes the QuotaCache, and exits 0.
 */

import { startMcpHttpServer, startMcpServer } from "../mcp/server.js";

/**
 * Run the MCP server on stdio. Bare `npx harness-router` calls this —
 * hosts launch us as a subprocess and speak JSON-RPC over stdin/stdout.
 */
export async function cmdStdio(configPath: string | undefined): Promise<number> {
  const buildOpts: { configPath?: string } = {};
  if (configPath !== undefined) buildOpts.configPath = configPath;
  const handle = await startMcpServer(buildOpts);
  return waitForShutdown(handle.close);
}

/**
 * Run the MCP server over Streamable HTTP. Default bind is 127.0.0.1:8765;
 * `--bind 0.0.0.0` (or any non-loopback) auto-creates a bearer token.
 */
export async function cmdServe(
  configPath: string | undefined,
  opts: { port?: number; bind?: string; requireAuth?: boolean },
): Promise<number> {
  const startOpts: {
    configPath?: string;
    port?: number;
    bind?: string;
    requireAuth?: boolean;
  } = {};
  if (configPath !== undefined) startOpts.configPath = configPath;
  if (opts.port !== undefined) startOpts.port = opts.port;
  if (opts.bind !== undefined) startOpts.bind = opts.bind;
  if (opts.requireAuth !== undefined) startOpts.requireAuth = opts.requireAuth;
  const handle = await startMcpHttpServer(startOpts);
  process.stderr.write(
    `harness-router listening on http://${opts.bind ?? "127.0.0.1"}:${handle.port}/mcp\n`,
  );
  return waitForShutdown(handle.close);
}

async function waitForShutdown(close: () => Promise<void>): Promise<number> {
  const shutdown = async (): Promise<void> => {
    try {
      await close();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
  await new Promise<void>(() => {
    /* never resolves */
  });
  return 0;
}
