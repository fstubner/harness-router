# harness-router

> **Use your AI subscriptions before paying for metered API.**
> An MCP server that routes coding tasks model-first across whatever CLIs you have installed. Subscription-backed CLIs (Claude Code, Cursor, Codex, Copilot CLI, opencode) are tried first; metered API is the fallback.

[![npm version](https://img.shields.io/npm/v/harness-router.svg)](https://www.npmjs.com/package/harness-router)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

---

## What this does

You declare a model priority list. For every coding request the router walks
down it: for each model, it tries every subscription-backed CLI that can serve
it (highest free quota first), then falls through to metered API. Only when
every route for the top model is dead does it move to the next.

The point: if you pay for Claude Pro AND have a Cursor Pro AND have an
Anthropic API key for fallback, you burn through flat-rate quota first — no
manual tool-switching when one rate-limits.

## What it gives you

**One MCP tool** that any MCP-aware host (Claude Desktop, Cursor, Claude Code,
Codex) exposes:

- **`code`** — main routing tool.
  - `mode: "single"` (default) — route once.
  - `mode: "fanout"` — run the prompt against multiple routes in parallel
    (one result per route; the caller synthesises).
  - Hints in single mode: `hints.model` (bump a model to the front of
    priority) or `hints.service` (force a specific dispatcher).
  - Fanout axis: `models: [...]` (canonical model keys; each expands to ALL
    its registered routes). Falls back to `mixture_default` from config,
    then to every available route.

**Two MCP resources** for inspectable state:

- **`harness-router://status`** — multi-line text dashboard.
- **`harness-router://status.json`** — same data as JSON.

Plus the operational machinery:

- **Multi-harness routes** — Claude Code AND Cursor AND opencode can all be
  registered for `claude-opus-4-7`; the router falls through within the
  same tier when the highest-quota route fails.
- **Quota tracking** — reads rate-limit headers per dispatch, scores
  availability, prefers higher-headroom routes.
- **Circuit breaker** — rate-limited routes get pulled from rotation
  automatically; recovery is half-open + probed.
- **Cross-process shared state** — concurrent stdio servers (Claude Desktop +
  Cursor + Codex on one machine) share quota counters via SQLite WAL — no
  daemon needed.
- **Live dashboard** — `harness-router dashboard --watch` for a TTY view.
- **Hot config reload** — edit `config.yaml` while the server runs.
- **OpenTelemetry** — optional OTLP export of dispatch / router / MCP-tool spans.

## Install

```bash
# One-shot (what hosts launch as a subprocess)
npx -y harness-router

# Global, for the CLI
npm install -g harness-router
harness-router --help
```

Requires **Node ≥ 20** and at least one installed CLI: `claude`, `codex`,
`gemini`, Cursor's `agent`, `opencode`, `copilot`, or a third-party CLI
registered via YAML.

## First-run setup

```bash
harness-router onboard
```

Interactive wizard. Walks through:

1. **Detect** installed AI CLIs.
2. **Pick models from OpenRouter's catalog** _(optional, falls through to
   free-text on any failure)_.
3. **Free-text additional models** — for local models or anything OpenRouter
   missed.
4. **Order the priority** — sequential picker.
5. **Subscription harnesses per model** — multi-checkbox of detected CLIs.
   Multiple harnesses serving one model is the common case.
6. **Metered fallback** — when `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` /
   `GEMINI_API_KEY` is set and the model name matches the provider regex,
   offers a metered fallback service. API keys are written as `${VAR}` —
   env-interpolation, never the raw value.
7. **Mixture default** — which models `code mode:fanout` fans out to by
   default.
8. **MCP host install** — Claude Desktop / Code / Cursor / Codex auto-detected.
9. **Confirm + write** to `~/.harness-router/config.yaml`.

After: restart the host(s); run `harness-router doctor` (or
`harness-router doctor --probe-routes` for the full per-route dispatch probe)
to verify each CLI is authed and accepting the configured `--model` value.

## Config file

`~/.harness-router/config.yaml` is model-keyed:

```yaml
priority:
  - claude-opus-4-7
  - gpt-5.4
  - gemini-2.5-pro
mixture_default: [claude-opus-4-7, gpt-5.4]
models:
  claude-opus-4-7:
    subscription: # single-route shorthand
      harness: claude_code
      command: claude
    metered:
      base_url: https://api.anthropic.com/v1
      api_key: ${ANTHROPIC_API_KEY}
  gpt-5.4:
    subscription:
      harness: cursor
      command: agent
  gemini-2.5-pro:
    metered:
      base_url: https://generativelanguage.googleapis.com/v1beta/openai
      api_key: ${GEMINI_API_KEY}
```

For a model served by **multiple harnesses**, use the array form:

```yaml
models:
  claude-opus-4-7:
    subscription: # array form
      - harness: claude_code
        command: claude
      - harness: cursor
        command: agent
      - harness: opencode
        command: opencode
    metered:
      - base_url: https://api.anthropic.com/v1
        api_key: ${ANTHROPIC_API_KEY}
      - base_url: http://localhost:11434/v1
        api_key: ollama # local relay as third fallback
```

Both shapes work — the loader normalises to array internally.

Optional `http:` block for the HTTP transport:

```yaml
http:
  bind: 127.0.0.1
  port: 8765
  auth:
    required: false # auto-forced true when bind is non-loopback
```

## CLI

```bash
# Bare invocation = stdio MCP server (what hosts launch)
harness-router

# HTTP transport
harness-router serve --http 8765 --bind 127.0.0.1
harness-router serve --bind 0.0.0.0           # auto-creates bearer token

# HTTP auth tokens
harness-router auth                            # show token + path + perms warning
harness-router auth rotate                     # replace with a fresh token

# Day-to-day
harness-router doctor                          # is each CLI installed/authed?
harness-router doctor --probe-routes           # also dispatch a 5-token probe per route
harness-router dashboard                       # one-shot text view
harness-router dashboard --watch               # live TTY redraw
harness-router install                         # wire into MCP hosts (idempotent)
harness-router uninstall                       # reverse it
harness-router onboard                         # interactive setup
```

## Routing model

When the agent calls `code({prompt: "…"})`:

1. Walk `priority`. For each model:
   - Try every `subscription`-tier route, **highest quota score first**
     (declared array order is the tiebreak).
   - When subscription is exhausted, try `metered` routes the same way.
2. Tripped breakers and unavailable dispatchers are skipped silently.
3. Rate-limit on a route → trip its breaker, exclude for the rest of this
   dispatch, fall through to the next route. **The agent gets a successful
   response from a different route**, not an error.
4. Response carries `routing: {model, tier, quotaScore, reason}` so the agent
   sees what fired.

Internally, each route in the YAML becomes one synthetic service id of the
form `${model}::${routeKey}` (e.g. `claude-opus-4-7::claude_code`,
`claude-opus-4-7::api.anthropic.com`). These are debuggable internal
handles — they show up in the dashboard, breaker errors, and OTel spans.
Users never write them.

## HTTP auth

- **Default bind**: `127.0.0.1:8765`.
- **Loopback bypass**: connections from `127.x` / `::1` / `::ffff:127.0.0.1`
  bypass the bearer-token check unless you pass `--require-auth`. The OS
  process boundary IS the auth there.
- **Non-loopback bind**: force-enables auth, auto-creates
  `~/.harness-router/auth.token` (chmod 600) on first start, prints the
  path to stderr.
- **401 response**: `WWW-Authenticate: Bearer realm="harness-router"`.
- **Constant-time comparison** via `crypto.timingSafeEqual` (length-mismatch
  short-circuited before the compare to avoid Buffer-construction timing
  leaks).

## Cross-process shared state

Every stdio/HTTP server opens the same SQLite database at
`~/.harness-router/state.db` in WAL mode. Quota counters use additive
UPSERTs, so concurrent processes accumulate cleanly:

- Three stdio servers (Claude Desktop + Cursor + Codex) all see the same
  total `local_calls` for a given route.
- No daemon, no IPC, no lifecycle.
- `sqlite3 state.db .dump` is a valid debugging tool.

## Compatibility

- v0.2 configs are NOT migrated. The loader rejects them with a
  `ConfigError` pointing at `harness-router onboard`.
- The npm package renamed from `harness-router-mcp` to `harness-router` at
  v0.3.0. The old name is unpublished going forward.

## License

MIT
