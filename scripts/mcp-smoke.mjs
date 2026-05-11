#!/usr/bin/env node
// End-to-end MCP smoke test.
//
// Fast mode spawns the built binary as hosts do (`node dist/bin.js`) with a
// temporary v0.3 config, then verifies initialize, tools/list, resources/list,
// and resources/read over stdio.
//
// Usage:
//   npm run build && npm run smoke
//   HARNESS_ROUTER_CONFIG=/path/to/real/config.yaml npm run smoke -- --live
//
// `--live` dispatches one tiny prompt through the real configured router. It
// consumes real quota and therefore never runs by default.

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf-8"));
const expectedName = pkg.name;
const expectedVersion = pkg.version;

const LIVE = process.argv.includes("--live") || process.env.HARNESS_ROUTER_LIVE_DISPATCH === "1";

const tempDir = mkdtempSync(join(tmpdir(), "harness-router-smoke-"));
const smokeConfig = join(tempDir, "config.yaml");
writeFileSync(
  smokeConfig,
  [
    "priority: [smoke-model]",
    "models:",
    "  smoke-model:",
    "    metered:",
    "      base_url: http://127.0.0.1:9/v1",
    "      api_key: smoke-test",
    "",
  ].join("\n"),
);

const configPath = LIVE ? process.env.HARNESS_ROUTER_CONFIG : smokeConfig;
const childArgs = [join(repoRoot, "dist", "bin.js")];
if (configPath) childArgs.push("--config", configPath);

const child = spawn(process.execPath, childArgs, {
  stdio: ["pipe", "pipe", "pipe"],
  cwd: repoRoot,
  env: { ...process.env, OTEL_SDK_DISABLED: "true" },
});

let stderr = "";
child.stderr.on("data", (b) => {
  stderr += b.toString();
});

let buf = "";
const pending = new Map();
child.stdout.on("data", (b) => {
  buf += b.toString();
  let nl;
  while ((nl = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.id !== undefined && pending.has(msg.id)) {
      const resolver = pending.get(msg.id);
      pending.delete(msg.id);
      resolver(msg);
    }
  }
});

let nextId = 1;
function rpc(method, params, timeoutMs = 8000) {
  const id = nextId++;
  const frame = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
  child.stdin.write(frame);
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`timeout on ${method} (id=${id})`));
      }
    }, timeoutMs);
  });
}

function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
}

const results = [];
function check(label, ok, detail) {
  results.push({ label, ok, detail });
  const tick = ok ? "OK" : "FAIL";
  console.log(`  ${tick} ${label}${detail ? ` - ${detail}` : ""}`);
}

try {
  console.log(`Spawned: node ${childArgs.join(" ")}  (pid=${child.pid})\n`);

  const init = await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "harness-router-e2e-smoke", version: "0.0.1" },
  });

  console.log("[initialize result]");
  const info = init.result?.serverInfo ?? {};
  console.log(`  serverInfo.name    = ${info.name}`);
  console.log(`  serverInfo.version = ${info.version}`);
  console.log(`  protocolVersion    = ${init.result?.protocolVersion}`);
  console.log(`  capabilities       = ${Object.keys(init.result?.capabilities ?? {}).join(", ")}`);
  console.log(`  instructions[0..80]= ${(init.result?.instructions ?? "").slice(0, 80)}...\n`);

  check("serverInfo.name matches package.json", info.name === expectedName, `got "${info.name}"`);
  check(
    "serverInfo.version matches package.json",
    info.version === expectedVersion,
    `got "${info.version}"`,
  );
  const caps = init.result?.capabilities ?? {};
  check("server advertises tools capability", "tools" in caps);
  check("server advertises resources capability", "resources" in caps);

  notify("notifications/initialized", {});

  const toolsR = await rpc("tools/list", {});
  const toolNames = (toolsR.result?.tools ?? []).map((t) => t.name).sort();
  console.log(`\n[tools/list - ${toolNames.length}] ${toolNames.join(", ")}`);
  check("single v0.3 tool advertised", JSON.stringify(toolNames) === JSON.stringify(["code"]));

  const resourcesR = await rpc("resources/list", {});
  const resourceUris = (resourcesR.result?.resources ?? []).map((r) => r.uri).sort();
  console.log(`\n[resources/list - ${resourceUris.length}] ${resourceUris.join(", ")}`);
  const expectedResources = ["harness-router://status", "harness-router://status.json"].sort();
  check(
    "status resources advertised",
    JSON.stringify(resourceUris) === JSON.stringify(expectedResources),
  );

  const statusR = await rpc("resources/read", { uri: "harness-router://status" });
  const statusText = statusR.result?.contents?.[0]?.text ?? "";
  console.log(`\n[resources/read status] ${statusText.split("\n").length} lines`);
  check("text status renders dashboard", statusText.includes("harness-router"));

  const statusJsonR = await rpc("resources/read", { uri: "harness-router://status.json" });
  const jsonText = statusJsonR.result?.contents?.[0]?.text ?? "";
  let parsedStatus = null;
  try {
    parsedStatus = JSON.parse(jsonText);
  } catch {
    /* no */
  }
  check("JSON status parses", parsedStatus !== null);
  check(
    "JSON status includes smoke route in fast mode",
    LIVE || Object.keys(parsedStatus ?? {}).some((k) => k.includes("smoke-model")),
  );

  if (LIVE) {
    console.log("\n[live] dispatching code with a tiny prompt...");
    const live = await rpc(
      "tools/call",
      {
        name: "code",
        arguments: { prompt: "Reply with only the single word: ok" },
      },
      120_000,
    );
    const liveText = live.result?.content?.[0]?.text ?? "";
    let parsedLive = null;
    try {
      parsedLive = JSON.parse(liveText);
    } catch {
      /* no */
    }
    const route = parsedLive?.route;
    console.log(`  mode:    ${parsedLive?.mode}`);
    console.log(`  service: ${route?.service}`);
    console.log(`  success: ${route?.success}`);
    console.log(`  output:  ${(route?.output ?? "").slice(0, 60).replace(/\n/g, " ")}`);
    check("live code returned mode=single", parsedLive?.mode === "single");
    check("live code returned success=true", route?.success === true, route?.error ?? "");
    check("live code returned non-empty output", (route?.output ?? "").length > 0);
    check("live code recorded a routing decision", !!route?.routing);
  } else {
    console.log("\n[live] skipped - pass --live to run a real dispatch.");
  }

  console.log("\n--- summary ---");
  const passed = results.filter((r) => r.ok).length;
  console.log(`${passed}/${results.length} checks passed`);
  if (passed !== results.length) {
    console.log("\nstderr from server:\n" + stderr);
    process.exitCode = 1;
  }
} catch (err) {
  console.error("\nFATAL:", err.message);
  console.error("stderr:\n" + stderr);
  process.exitCode = 1;
} finally {
  child.kill("SIGTERM");
  await new Promise((r) => child.on("exit", r));
  rmSync(tempDir, { recursive: true, force: true });
}
