#!/usr/bin/env node
// End-to-end MCP smoke test.
//
// Spawns the published binary (`node dist/bin.js mcp`), exchanges JSON-RPC
// frames over stdio, and confirms the server advertises the expected name,
// version (loaded from package.json at runtime), tool set, and prompt set.
//
// The vitest suite covers the same logic via the SDK's in-memory transport;
// this script is the one that exercises the actual spawned binary, so it
// doubles as a release-readiness check.
//
// Usage:
//   npm run build && npm run smoke

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf-8"));
const expectedName = pkg.name;
const expectedVersion = pkg.version;

const child = spawn(process.execPath, [join(repoRoot, "dist", "bin.js"), "mcp"], {
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
  const tick = ok ? "✔" : "✖";
  console.log(`  ${tick} ${label}${detail ? `  — ${detail}` : ""}`);
}

try {
  console.log(`Spawned: node dist/bin.js mcp  (pid=${child.pid})\n`);

  // --- initialize ---------------------------------------------------------
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
  console.log(`  instructions[0..80]= ${(init.result?.instructions ?? "").slice(0, 80)}…\n`);

  check("serverInfo.name matches package.json", info.name === expectedName, `got "${info.name}"`);
  check(
    "serverInfo.version matches package.json",
    info.version === expectedVersion,
    `got "${info.version}"`,
  );
  const caps = init.result?.capabilities ?? {};
  check("server advertises tools capability", "tools" in caps);
  check("server advertises prompts capability", "prompts" in caps);

  notify("notifications/initialized", {});

  // --- tools/list ---------------------------------------------------------
  const toolsR = await rpc("tools/list", {});
  const toolNames = (toolsR.result?.tools ?? []).map((t) => t.name).sort();
  console.log(`\n[tools/list — ${toolNames.length}] ${toolNames.join(", ")}`);
  const expectedTools = [
    "code_auto",
    "code_mixture",
    "code_with_claude",
    "code_with_codex",
    "code_with_copilot",
    "code_with_cursor",
    "code_with_gemini",
    "code_with_opencode",
    "dashboard",
    "get_quota_status",
    "list_available_services",
    "setup",
  ].sort();
  check("all 12 tools advertised", JSON.stringify(toolNames) === JSON.stringify(expectedTools));

  // --- prompts/list -------------------------------------------------------
  const promptsR = await rpc("prompts/list", {});
  const promptNames = (promptsR.result?.prompts ?? []).map((p) => p.name).sort();
  console.log(`\n[prompts/list — ${promptNames.length}] ${promptNames.join(", ")}`);
  const expectedPrompts = [
    "compare-implementations",
    "harness-health-check",
    "onboard-coding-stack",
    "pick-best-harness",
    "route-coding-task",
  ];
  check(
    "all 5 prompts advertised",
    JSON.stringify(promptNames) === JSON.stringify(expectedPrompts),
  );

  // --- prompts/get --------------------------------------------------------
  const got = await rpc("prompts/get", {
    name: "route-coding-task",
    arguments: { task: "fix the auth bug on /login", task_type: "execute" },
  });
  const text = got.result?.messages?.[0]?.content?.text ?? "";
  console.log(`\n[prompts/get route-coding-task] rendered ${text.length} chars`);
  console.log(`  preview: ${text.split("\n").slice(0, 3).join(" / ")}`);
  check("prompt rendered the task", text.includes("fix the auth bug on /login"));
  check("prompt rendered the task_type hint", text.includes('hints.taskType: "execute"'));
  check("prompt names code_auto", text.includes("code_auto"));

  // --- live tool call -----------------------------------------------------
  const listSvc = await rpc("tools/call", {
    name: "list_available_services",
    arguments: {},
  });
  const svcContent = listSvc.result?.content?.[0]?.text ?? "";
  let parsedSvc = null;
  try {
    parsedSvc = JSON.parse(svcContent);
  } catch {
    /* nope */
  }
  console.log(
    `\n[tools/call list_available_services] services=${parsedSvc?.services?.length ?? "?"}`,
  );
  check(
    "list_available_services returns a JSON services array",
    Array.isArray(parsedSvc?.services),
  );

  // --- get_quota_status ---------------------------------------------------
  const quota = await rpc("tools/call", {
    name: "get_quota_status",
    arguments: {},
  });
  const quotaText = quota.result?.content?.[0]?.text ?? "";
  let parsedQuota = null;
  try {
    parsedQuota = JSON.parse(quotaText);
  } catch {
    /* nope */
  }
  const quotaCount = parsedQuota ? Object.keys(parsedQuota).length : 0;
  console.log(`\n[tools/call get_quota_status] services=${quotaCount}`);
  check("get_quota_status returns per-service quota objects", quotaCount > 0);

  // --- dashboard ----------------------------------------------------------
  const dash = await rpc("tools/call", {
    name: "dashboard",
    arguments: {},
  });
  const dashText = dash.result?.content?.[0]?.text ?? "";
  console.log(
    `\n[tools/call dashboard] ${dashText.split("\n").length} lines, ${dashText.length} chars`,
  );
  check(
    "dashboard renders a multi-line text block",
    dashText.includes("Tier 1") && dashText.length > 200,
  );

  // --- LIVE DISPATCH (opt-in) --------------------------------------------
  // Set HARNESS_ROUTER_LIVE_DISPATCH=1 to run a real `code_auto` call.
  // Uses ~5 input + ~5 output tokens against whichever harness wins routing.
  if (process.env.HARNESS_ROUTER_LIVE_DISPATCH === "1") {
    console.log("\n[live] dispatching code_auto with a 5-token prompt …");
    const live = await rpc(
      "tools/call",
      {
        name: "code_auto",
        arguments: {
          prompt: "Reply with only the single word: ok",
          hints: { taskType: "execute" },
        },
      },
      60_000,
    );
    const liveText = live.result?.content?.[0]?.text ?? "";
    let parsedLive = null;
    try {
      parsedLive = JSON.parse(liveText);
    } catch {
      /* nope */
    }
    console.log(`  service: ${parsedLive?.service}`);
    console.log(`  success: ${parsedLive?.success}`);
    console.log(`  output:  ${(parsedLive?.output ?? "").slice(0, 60).replace(/\n/g, " ")}`);
    if (parsedLive?.routing) {
      console.log(
        `  routing: tier=${parsedLive.routing.tier} score=${parsedLive.routing.finalScore?.toFixed?.(3)}`,
      );
    }
    check(
      "live code_auto returned success=true",
      parsedLive?.success === true,
      parsedLive?.error ?? "",
    );
    check("live code_auto returned non-empty output", (parsedLive?.output ?? "").length > 0);
    check("live code_auto recorded a routing decision", !!parsedLive?.routing);

    // --- per-harness verification --------------------------------------
    // One forced dispatch through each harness's tool. Proves each
    // dispatcher's subprocess args + JSON-output parsing actually work.
    const perHarness = [
      { tool: "code_with_claude", harness: "claude_code" },
      { tool: "code_with_codex", harness: "codex" },
      { tool: "code_with_cursor", harness: "cursor" },
      { tool: "code_with_gemini", harness: "gemini_cli" },
      { tool: "code_with_opencode", harness: "opencode" },
      { tool: "code_with_copilot", harness: "copilot" },
    ];
    console.log("\n[per-harness] dispatching one prompt through each of 6 harnesses…");
    for (const { tool, harness } of perHarness) {
      const t0 = Date.now();
      let resp;
      try {
        resp = await rpc(
          "tools/call",
          {
            name: tool,
            arguments: {
              prompt: "Reply with only the single word: ok",
              hints: { taskType: "execute" },
            },
          },
          120_000,
        );
      } catch (err) {
        console.log(`  ✖ ${tool} → ${err.message}`);
        check(`${tool} (${harness}) succeeded`, false, err.message);
        continue;
      }
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      const text = resp.result?.content?.[0]?.text ?? "";
      let parsed = null;
      try {
        parsed = JSON.parse(text);
      } catch {
        /* no */
      }
      const out = (parsed?.output ?? "").trim().slice(0, 40).replace(/\n/g, " ");
      const svc = parsed?.service ?? "?";
      const routedHarness = parsed?.routing?.service ?? svc;
      const ok = parsed?.success === true && (parsed?.output ?? "").length > 0;
      const tick = ok ? "✔" : "✖";
      const err = parsed?.error ?? "";
      console.log(
        `  ${tick} ${tool}  →  ${svc} (${elapsed}s)  output: "${out}"${err ? `  err: ${err}` : ""}`,
      );
      check(`${tool} succeeded against ${harness}`, ok, err);
      if (ok) {
        check(
          `${tool} routed to a ${harness} service`,
          routedHarness.includes(harness) || svc.includes(harness.split("_")[0]),
          `service=${svc}`,
        );
      }
    }
  } else {
    console.log("\n[live] skipped — set HARNESS_ROUTER_LIVE_DISPATCH=1 to run a real dispatch.");
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
}
