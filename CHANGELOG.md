# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

(empty — track changes for the next release here)

## [0.2.0] — 2026-05-03

Major redirect: the router is now **model-first**, not harness-first. The pitch
shifted to "use your AI subscriptions before metered API." Most of the v0.1
scoring layer turned out to be decorative and was removed.

### Breaking changes

- **MCP tool surface collapsed from 12 tools to 4.** The new tools are `code`,
  `code_mixture`, `dashboard`, and `get_quota_status`. The 6 `code_with_<harness>`
  tools, `code_auto`, `list_available_services`, and `setup` are all gone. Most
  use cases in v0.1 are now `code` with optional `hints.service` / `hints.model`.
- **MCP prompts collapsed from 5 to 3.** New: `route-task`, `compare-models`,
  `health-check`. The previous prompts referenced the dropped tools.
- **`ServiceConfig` schema simplified.** Dropped: `weight`, `cliCapability`,
  `capabilities`, `escalateModel`, `escalateOn`, `leaderboardModel`. The `tier`
  field is now `"subscription" | "metered"` (was a number `1|2|3`).
- **`RouterConfig` adds `modelPriority: string[]`.** This is the user-declared
  ordered list of models. Auto-detect picks a sensible default if absent.
- **`RoutingDecision` simplified.** New shape: `{model, service, tier,
quotaScore, reason}`. Dropped: `qualityScore`, `cliCapability`,
  `capabilityScore`, `taskType`, `elo`, `finalScore`.
- **`RouteHints` simplified.** Kept: `service` (force a service), `model` (bump
  a model to the front). Dropped: `taskType`, `harness`, `preferLargeContext`.
- **`LeaderboardCache` removed.** The Arena ELO scoring layer is gone — model
  preference is the user's call now, not an inferred quality score.

### Algorithm

- **Model-first walk.** For each model in priority order: try every
  subscription-tier service (highest quota first), then every metered-tier
  service. When all routes for a model fail, drop to the next model.
- **Subscription/metered tiers** map directly onto the user's intent: prefer
  flat-rate paid subscriptions; fall back to per-token API only when needed.
- **Rate-limit semantics changed.** The previous router stopped dispatch on
  rate-limit and surfaced the error. The new router excludes the rate-limited
  service for the rest of this dispatch _and_ trips the breaker, then falls
  through to the next route. The user gets a response from a different service
  instead of an error. The breaker stays tripped for the provider's
  `retryAfter` duration; subsequent dispatches skip the route immediately
  until the cooldown elapses, at which point the next read of `isTripped`
  auto-resets.
- **`cli_model` field.** A service can declare both a canonical `model:` (used
  by the router to match against `model_priority`) and a `cli_model:` (passed
  to the underlying CLI's `--model` flag). This lets two different CLIs serve
  the same canonical model under different naming conventions — Claude Code's
  `opus` and the Anthropic API's `claude-opus-4-20250101` are the same model
  for routing purposes.
- **Default `model_priority`** is now derived from the configured services'
  `model:` fields in declaration order, instead of a hardcoded list. This
  prevents the default priority from referencing models that no installed
  service can serve.
- **No artificial fallback cap.** v0.1's `maxFallbacks: 2` default capped
  retries; the new router relies on `pickService` returning `null` when no
  routes remain. Combined with the monotonically-growing exclude set and
  the breaker filter, the loop terminates in at most O(services) iterations.

### Code reduction

Approximately 1,000 lines removed (LeaderboardCache, scoring math, scoring
parity tests, six redundant `code_with_<harness>` tools, the `setup` MCP tool).
The new model-first router is ~400 lines including type definitions, replacing
a router that was ~800 lines. Total test count dropped from 381 to 332 (the
deleted tests were the scoring/leaderboard ones; semantics-preserving tests
were ported to the new router shape).

### Removed

- `setup` as an MCP tool. The Claude-Code-routing-hook bootstrap is a
  host-install action a human runs once, not something an agent should call
  mid-conversation. (May come back as a CLI subcommand if there's demand.)
- The "harness × task_type" capability matrix and the `cli_capability`
  multipliers per harness. Those numbers were vibes, not measurements.

### Install command

- **`harness-router-mcp install`** — new CLI subcommand that wires the MCP
  server itself into every detected MCP host's user-scoped config:
  - Claude Desktop (`%APPDATA%\Claude\claude_desktop_config.json` on Windows,
    `~/Library/Application Support/Claude/...` on macOS, `~/.config/Claude/...`
    on Linux) — JSON, under `mcpServers["harness-router"]`.
  - Claude Code (the CLI / Anthropic's coding agent) — invokes
    `claude mcp add harness-router --scope user -- npx -y harness-router-mcp mcp`
    on your behalf. Claude Code owns its own MCP-server registry at
    `~/.claude.json`, so we delegate to its CLI rather than poking the file
    directly.
  - Cursor IDE (`~/.cursor/mcp.json`) — same JSON shape as Claude Desktop.
  - Codex CLI / Desktop / IDE extension (`~/.codex/config.toml`) — TOML,
    `[mcp_servers.harness-router]`. All three Codex clients share this file
    per [OpenAI's MCP docs](https://developers.openai.com/codex/mcp).
- Idempotent: re-running on an already-installed host is a no-op. Preserves
  every other entry in the host's config (verified against real configs with
  six existing servers in Codex's TOML, custom HTTP-style entries in Cursor,
  preferences blocks in Claude Desktop).
- Detection is opportunistic — only acts on hosts whose config dir actually
  exists. Hosts not installed on the machine are skipped with a log line, not
  treated as errors.
- Flags: `--target <id>` (single-host), `--print` (dry-run, prints snippets
  to stdout for manual install), `--uninstall` (remove the entry), `--name`
  (override the entry's server name).
- New dep: `smol-toml` (~24 kB, ESM-native, maintained) for round-tripping
  Codex's TOML config without clobbering existing entries.

### First-run UX

- Default models in `CLI_DEFAULTS` now use each CLI's documented alias where
  one exists (`sonnet` for Claude Code, `pro` for Gemini, `auto` for Cursor
  and Copilot). Aliases auto-roll forward as providers ship new versions; full
  IDs are still accepted via `model:` overrides for users who want to pin.
- README now has a per-CLI model-name reference table covering Claude Code,
  Codex, Gemini, Cursor, opencode, and Copilot CLI.
- MCP server logs a one-line startup banner to stderr summarising reachable
  services per tier and the active model priority. When zero services are
  reachable, the banner points the user at `harness-router-mcp init`.
- The "no available routes" error from the `code` tool now classifies the
  cause (no services configured / nothing installed / everything rate-limited
  / no service matches the priority list) instead of just dumping the full
  breaker state JSON.

## [0.1.0] — 2026-05-01

Initial public release.

### MCP server

- **12 MCP tools** — `code_auto`, `code_mixture`, per-harness `code_with_{claude,cursor,codex,gemini,opencode,copilot}`, `get_quota_status`, `list_available_services`, `dashboard`, `setup`.
- **5 MCP prompts** that surface in the host's prompt picker: `route-coding-task`, `compare-implementations`, `harness-health-check`, `pick-best-harness`, `onboard-coding-stack`.
- **Two transports**: stdio (single-session, default for desktop hosts) and Streamable-HTTP (multi-session, per-session McpServer pattern matching the SDK's official example).
- **MCP tool input bounds** — Zod schemas cap `prompt` at 1 MB, `files` at 256 entries (each ≤ 4 KB path), `workingDir` must be empty or absolute. Bounds are documented inline.

### Routing

- **(model × harness) scoring** — every service is scored with `quality_score × cli_capability × capabilities[task_type] × quota_score × weight`. Tier-aware fallback (Frontier → Strong → Fast).
- **Six built-in harnesses**: Claude Code, Cursor, Codex, Gemini CLI, OpenCode, GitHub Copilot CLI. OpenCode supports multi-subscription configs (Anthropic / OpenAI / Google) in one install. Copilot is the standalone `@github/copilot` agentic CLI (distinct from the VS Code extension, which has no headless invocation and isn't routable).
- **`type: cli` auto-promote**: any service with a `command:` field but an unknown harness id falls through to the `GenericCliDispatcher` automatically. Adding a third-party CLI is now a one-line YAML entry — no `type: generic_cli` boilerplate required.
- **Codex JSONL error-event surfacing**: codex's `{type:"error",message:"..."}` and `{type:"turn.failed",error:{message}}` events on stdout are now lifted into `result.error`. Previously the unrelated `rmcp::transport::worker` stderr noise (codex's internal MCP integration failing) dominated, masking quota / rate-limit messages.
- **`RouteResponse.rateLimited` / `retryAfter`**: rate-limit signals from any dispatcher now propagate through MCP responses (the router's circuit breaker already used them internally; clients now see them too).
- **OpenCode `--cwd` removal**: opencode 1.14+ rejects `--cwd`. The dispatcher now relies on subprocess `cwd` (same pattern as every other dispatcher).
- **`type: generic_cli` extensibility** — add any third-party CLI via YAML alone. Recipe controls argv assembly, prompt delivery (positional / flag / stdin), per-file flag injection, JSONL streaming for live tool_use/thinking events, env-var forwarding, and JSON-path output extraction.
- **Auto-detect** — probes `PATH` for the five built-in harnesses' binaries at startup with sensible defaults.
- **Quota awareness** — tracks free-tier usage from rate-limit headers per dispatch; steers traffic away from exhausted services.
- **Circuit breaker** — failing services trip out of rotation; auto-resets after the cooldown (or provider-supplied retry-after).
- **Hot config reload** — `ConfigHotReloader` polls the config file's mtime between tool calls; preserves circuit-breaker remaining cooldowns across reloads.

### Onboarding & observability

- **`harness-router-mcp init`** — per-harness install/verify/ready checklist with exact next-step command for anything red. Generic_cli services declared in config also appear in the checklist. Flags: `--install`, `--harness <id>`, `--no-verify`.
- **Live dashboard** — `harness-router-mcp dashboard --watch` for a TTY view of tier, ELO, quota, and breaker state per service.
- **OpenTelemetry** — optional OTLP export of dispatch/router/MCP-tool spans. Disable with `OTEL_SDK_DISABLED=true`. SDK init failure is logged to stderr (not stdout — that's reserved for MCP JSON-RPC).
- **End-to-end smoke test** — `npm run smoke` exchanges JSON-RPC frames over stdio with the actual binary.

### Quality & security

- **0 CVEs** in production deps (verified with `npm audit --omit=dev`). The OTel auto-instrumentations transitive `uuid` / `gaxios` chain pinned via `package.json` `overrides` to `^14` / `^7` respectively.
- **All MIT-compatible licenses** in the dependency tree (135 MIT, 82 Apache-2.0, 14 ISC, 13 BSD-3, others). Zero copyleft (GPL/AGPL/LGPL).
- **No transitive dep with `postinstall` scripts.**
- **Test coverage** measured by `@vitest/coverage-v8`, baseline 82.88% lines / 69.32% branches / 76.94% functions. Thresholds set to baseline-minus-headroom so regressions trip the gate.
- **ESLint** flat config with `typescript-eslint` recommended-type-checked plus rules tuned to this codebase: `no-floating-promises`, `no-misused-promises`, `consistent-type-imports`, `no-explicit-any`, `prefer-promise-reject-errors`, vitest-plugin assertion checks. Zero errors at baseline.
- **JSDoc** on every public re-export from `src/index.ts`.
- **Trust model** documented in README — generic_cli command resolution, HTTP-no-auth boundary, OS-level isolation guidance.
- **CI matrix** — Node 20/22 × ubuntu/windows/macOS with format-check + lint + typecheck + test + build + tarball validation. Coverage runs on a single leg (Node 22 / ubuntu) and uploads `lcov.info` as an artifact.
- **npm publish** with `--provenance` + OIDC, tag-triggered (`v*`).

### Notes

- **Quota state file**: `~/.harness-router/quota_state.json` (override with `QuotaCacheOptions.stateFile`). **Single-process** by design — the read-modify-write race between two MCP processes sharing one state file is documented as a known limit; mitigation is per-process `state_file` paths in YAML.
- **Config path**: `--config <path>` flag, `$HARNESS_ROUTER_CONFIG` env var, then auto-detect — first match wins.
- **Requires Node ≥ 20.**
- **At least one** of `claude`, `codex`, `gemini`, Cursor's `agent`, `opencode`, or `copilot` on PATH (or any third-party `command:` you register via YAML).

### Reporting

- Code of Conduct: [Contributor Covenant 2.1](CODE_OF_CONDUCT.md), reports to **felix.stubner@gmail.com**.
- Security disclosures: [SECURITY.md](SECURITY.md).
- Issues: [GitHub issue tracker](https://github.com/fstubner/harness-router-mcp/issues).

[Unreleased]: https://github.com/fstubner/harness-router-mcp/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/fstubner/harness-router-mcp/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/fstubner/harness-router-mcp/releases/tag/v0.1.0
