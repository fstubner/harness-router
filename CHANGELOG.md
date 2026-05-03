# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

(empty — track changes for the next release here)

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

[Unreleased]: https://github.com/fstubner/harness-router-mcp/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/fstubner/harness-router-mcp/releases/tag/v0.1.0
