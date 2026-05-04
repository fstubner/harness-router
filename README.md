# harness-router-mcp

> **Use your AI subscriptions before paying for metered API.**
> An MCP server that routes coding tasks model-first across whatever CLIs you have installed. Subscription-backed CLIs (Claude Code, Cursor, Codex, Copilot CLI, opencode) are tried first; metered API is the fallback.

[![npm version](https://img.shields.io/npm/v/harness-router-mcp.svg)](https://www.npmjs.com/package/harness-router-mcp)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**Landing page:** [fstubner.github.io/harness-router-mcp](https://fstubner.github.io/harness-router-mcp/)

---

## What this does

You declare a model preference list — for example:

```yaml
model_priority:
  - claude-opus-4.7
  - gpt-5.4
  - claude-sonnet-4.6
```

For every coding request, the router walks down that list. For each model, it
tries each subscription-backed CLI that can serve it (highest free quota
first). When subscriptions are exhausted, it falls through to metered API for
the same model. Only when every route for the top model is dead does it drop
to the next model.

The point: if you pay for Claude Pro and ChatGPT Plus, you can burn through
that flat-rate quota before any per-token API charges kick in — without
manually switching tools when one rate-limits.

## What it gives you

Four MCP tools that show up in any MCP-aware host (Claude Desktop, Cursor's
agent panel, Claude Code, Codex desktop):

- **`code`** — main routing tool. Walks your model priority + tier list and
  dispatches. Hints: `model` (bump a model to the front) or `service` (force a
  specific CLI).
- **`code_mixture`** — fan a prompt out to every available service in parallel.
  One result per service; you synthesise.
- **`dashboard`** — text status of every configured service: model, tier
  (subscription / metered), quota left, breaker state, the router's current pick.
- **`get_quota_status`** — JSON version of the dashboard, for tooling.

Plus three prompts in the host's slash menu:

| Prompt           | What it does                                                                          |
| ---------------- | ------------------------------------------------------------------------------------- |
| `route-task`     | Send a task through `code` with optional model override. The most common entry point. |
| `compare-models` | Fan a task out via `code_mixture` to every available service for synthesis.           |
| `health-check`   | Walk through `dashboard` + `get_quota_status` to diagnose routing problems.           |

Plus the operational machinery you'd want anyway:

- **Quota tracking** — reads rate-limit headers per dispatch, scores
  availability per service, prefers higher-headroom routes.
- **Circuit breaker** — services that rate-limit get pulled from rotation
  automatically; recovery is half-open + probed.
- **Live dashboard** — `harness-router-mcp dashboard --watch` for a TTY view.
- **Hot config reload** — edit `config.yaml` while the server runs; changes
  apply between tool calls without a restart.
- **OpenTelemetry** — optional OTLP export of dispatch / routing / MCP-tool spans.

## Install

```bash
# One-shot (recommended for Claude Desktop / Cursor configs)
npx -y harness-router-mcp mcp

# Global
npm install -g harness-router-mcp
harness-router-mcp --help
```

Requires **Node ≥ 20** and at least one installed CLI: `claude`, `codex`, `gemini`, Cursor's `agent`, `opencode`, `copilot` (GitHub Copilot CLI), or any third-party CLI you register via YAML.

## First-run setup

The fastest way to know whether your stack is ready:

```bash
harness-router-mcp init
```

Per-harness checklist with three states (installed / verified / ready) and the exact next-step command for anything red. Runs a tiny ~5-token dispatch to verify each CLI's auth + JSON parsing actually works end-to-end.

> **Inside an MCP host** (Claude Desktop, Cursor agent, etc.) the server logs a one-line startup banner to stderr summarising what it found — count of reachable services per tier, the active model priority, and a pointer back to `harness-router-mcp init` if nothing is reachable. Most MCP hosts surface stderr in their server logs (Claude Desktop: "View server logs"; Cursor: "MCP" panel), which is where to look when routing isn't doing what you expect.

```text
claude_code  Claude Code CLI
  ✓ installed  v2.1.119
  ✓ verified   "ok" in 5.3s
  ─ ready

codex        OpenAI Codex CLI
  ✓ installed  v0.77.0  ⚠ latest 0.125.0
  ✗ verified   AuthRequired: token not authorized
  → upgrade (admin): npm install -g @openai/codex@latest
  → auth: codex auth login
```

Flags:

| Flag             | Effect                                                                                                                                                                |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--install`      | Try `npm install -g <pkg>@latest` for any missing or upgradable harness. On Windows non-admin / Unix non-sudo, prints the elevation hint instead of failing opaquely. |
| `--harness <id>` | Limit to one harness: `claude_code`, `codex`, `cursor`, `gemini_cli`, `opencode`, or `copilot` (or any third-party id you registered via YAML).                       |
| `--no-verify`    | Skip the live ~5-token dispatch probe. Pure offline check.                                                                                                            |

Exit code is `0` if every targeted harness is ready, `1` otherwise — pipe-friendly.

## Authenticate the CLIs you want to use

`init` will tell you which CLIs need auth. The commands:

```bash
claude auth login                    # Claude Code (Pro / Max)
codex auth login                     # Codex CLI (ChatGPT Pro)
gemini auth                          # Gemini CLI (or set GEMINI_API_KEY)
opencode auth login                  # OpenCode — multiple providers per install
copilot                              # First-run OAuth (no separate auth subcommand)
# Cursor — sign in via the Cursor desktop app
```

> **Copilot CLI policy**: even after `gh auth login` succeeds, your org/subscription policy may block CLI use. If you see `Access denied by policy settings`, check https://github.com/settings/copilot. The router surfaces this clearly rather than as a generic auth error.

> **OpenCode supports multiple subscriptions in one install** — Anthropic (Claude Pro/Max OAuth), OpenAI (ChatGPT subscription), Google, OpenRouter, and direct API keys. Useful for mixing subscription-billed and API-billed access in the same harness.

## Trust model

The router runs each underlying CLI in its **non-interactive / max-permission mode**: `--full-auto` for Codex, `--trust` for Cursor, broad `--allowedTools` for Claude Code, `run` (positional prompt) for OpenCode. The dispatched CLI can read, write, and execute anything in the workspace it's pointed at. **Treat dispatched tasks as you would any agentic CLI run by a colleague:** keep them out of repos with secrets you don't want exfiltrated, and prefer running them in a clean directory or container if the codebase is sensitive.

The router does **not** add isolation beyond what each CLI provides — sandboxing belongs at the OS / container layer (Docker, Codespaces, Vercel Sandbox, Firecracker microVMs), not in a meta-router. If you need stronger guarantees, run `harness-router-mcp` itself inside an ephemeral environment.

### `generic_cli` extensibility — trust the config

`type: generic_cli` lets you add any CLI from YAML alone. Anyone who can edit your `config.yaml` can make the router execute any binary on `PATH`. Treat the file as you would `~/.bashrc`: restrict its filesystem permissions, don't load configs from untrusted sources, and review diffs on shared/team configs the same way you review shell scripts.

### HTTP transport — no built-in auth

`harness-router-mcp mcp --http` (or `startMcpHttpServer()` programmatically) speaks Streamable-HTTP MCP **without authentication**. Bind to loopback (the default) for desktop-host integration. For remote use, place a reverse proxy with auth in front (Tailscale, Cloudflare Tunnel, nginx + basic auth, etc.) — the router will not validate credentials itself. Session IDs are UUIDv4 (128-bit entropy), so they aren't guessable, but a bare-internet endpoint without a proxy IS world-callable.

## Configure

Zero-config mode works out of the box: at startup, the server probes your `PATH` for `claude`, `codex`, `gemini`, and `agent` and uses sensible defaults for each one it finds.

For anything beyond defaults, create `config.yaml` and either pass it via `--config`, set `HARNESS_ROUTER_CONFIG=/path/to/config.yaml`, or place it in the project root:

```yaml
# Minimal — supply a Gemini API key
gemini_api_key: ${GEMINI_API_KEY}

# Skip a CLI even if installed
disabled: [cursor]

# Tweak auto-detected defaults
overrides:
  claude_code:
    weight: 1.2
  gemini_cli:
    thinking_level: medium

# Add local / third-party endpoints
endpoints:
  - name: ollama
    base_url: http://localhost:11434/v1
    model: llama3.2
    tier: 3
```

Full schema (custom models per service, multiple entries per harness, per-task capability scores, model escalation) lives in [`config.example.yaml`](config.example.yaml).

## Use with Claude Desktop / Cursor

Add to `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/`, Windows: `%APPDATA%\Claude\`):

```json
{
  "mcpServers": {
    "harness-router": {
      "command": "npx",
      "args": ["-y", "harness-router-mcp", "mcp"],
      "env": {
        "HARNESS_ROUTER_CONFIG": "/path/to/config.yaml",
        "GEMINI_API_KEY": "your-gemini-api-key-here"
      }
    }
  }
}
```

Restart Claude Desktop. The four MCP tools (`code`, `code_mixture`, `dashboard`, `get_quota_status`) become available in the chat.

## How routing actually works

The algorithm is short. Walk the user's `model_priority` list. For each model:

1. Find every enabled service whose `model:` matches and whose dispatcher is
   reachable + breaker-closed.
2. Split those candidates into `subscription` and `metered` tiers (by the
   service's `tier:` field).
3. Try subscription routes first, in quota-descending order. If one rate-limits,
   skip to the next. When all subscription routes are exhausted, fall through
   to metered.
4. When every route for the current model has failed, drop to the next model.

That's the whole thing. No quality scores, no per-harness multipliers — those
were vibes. The data the router actually has is "is this CLI installed",
"is its breaker closed", and "what's its quota score".

## Adding a service

```yaml
# Subscription-backed: routes through this CLI count as zero marginal cost.
claude_code_opus:
  enabled: true
  harness: claude_code
  command: claude
  model: claude-opus-4.7 # canonical name (matches model_priority entries)
  cli_model: opus # what `claude --model` actually accepts
  tier: subscription

# Metered API: only used when subscription routes for the same model are exhausted.
anthropic_api:
  enabled: true
  type: openai_compatible
  base_url: https://api.anthropic.com/v1
  model: claude-opus-4.7 # same canonical name → both routes serve the same model
  cli_model: claude-opus-4-20250101 # what the API expects
  api_key: ${ANTHROPIC_API_KEY}
  tier: metered
```

### Two model names per service?

`model:` is the canonical ID — used by the router to match services against
`model_priority` entries. Pick whatever convention you want (semantic versions,
date-suffixed IDs, aliases), just keep it consistent across `model_priority`
and every service's `model:` field.

`cli_model:` is what gets passed to the underlying CLI's `--model` flag at
dispatch time. Use it when the canonical name you want for routing differs
from what the CLI accepts. When omitted, falls back to `model`.

This is the join that lets two different CLIs serve "the same model" with
different name conventions. Claude Code's CLI calls Opus `opus`; Cursor's
agent might call it `claude-3-opus-thinking-max`; the Anthropic API wants the
full versioned ID. They're all the same model from the router's perspective —
it walks `model_priority`, finds every service whose `model:` matches, and
hands each one its own `cli_model:` at dispatch time.

OpenAI-compatible endpoints (Ollama, LM Studio, OpenRouter, raw OpenAI/Anthropic
APIs) work the same way — they default to `tier: metered` since that's how
they bill.

### Per-CLI model name conventions

Each CLI accepts its own naming style for `--model`. The router doesn't
translate; whatever you put in `model:` (or `cli_model:`) is what the CLI
sees. Reference for the six built-in harnesses, current as of May 2026:

| CLI              | Aliases                                                  | Concrete IDs (examples)                                                           | Notes                                                                                    |
| ---------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `claude`         | `default`, `best`, `sonnet`, `opus`, `haiku`, `opusplan` | `claude-opus-4-7`, `claude-sonnet-4-6`, `claude-haiku-4-5` (dashes, no dots)      | Aliases roll forward to latest. Append `[1m]` for 1M context.                            |
| `codex`          | _(none)_                                                 | `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.3-codex`, `gpt-5.3-codex-spark`      | Dots in versions. `gpt-5.5` only on ChatGPT auth, not API auth.                          |
| `gemini`         | `auto`, `pro`, `flash`, `flash-lite`                     | `gemini-2.5-pro`, `gemini-3-pro-preview`, `gemini-2.5-flash`                      | Aliases preferred — auto-roll. Preview models gated behind a flag.                       |
| `agent` (Cursor) | `Auto`                                                   | `Composer 2`, `Opus 4.6`, `Codex 5.3 High Fast`, `Gemini 3 Pro`, `Grok`           | Descriptive names (mixed casing). Run `agent models` to list what's available.           |
| `opencode`       | _(none)_                                                 | `anthropic/claude-sonnet-4-20250514`, `openai/gpt-5`, `lmstudio/<provider/model>` | Format is always `provider_id/model_id`. Run `opencode /models` to enumerate.            |
| `copilot`        | `auto`                                                   | `claude-sonnet-4.5`, `gpt-5.4`, `gpt-5.3-codex`                                   | Subject to subscription policy. Run `/model` interactively to see what your seat allows. |

Built-in defaults pick aliases over fully-versioned IDs where the CLI
supports them, so they keep working as the providers ship new versions.
Override per service when you want to pin to a specific version.

### Adding a third-party CLI without writing code

Any headless coding CLI that takes a prompt argument and writes the agent's
reply to stdout can be plugged into the router from YAML alone — no
TypeScript dispatcher required. **The minimum viable entry is two lines:**

```yaml
services:
  my_custom_cli:
    command: my-cli
```

That's it. The router auto-promotes any service with `command:` and an
unknown harness to `GenericCliDispatcher`, which runs `<command> "<prompt>"`
and treats stdout as the response. Route via
`code({ prompt, hints: { service: "my_custom_cli" } })` to force it, or just
include it in the priority list and the router will pick it when its model
comes up.

For non-trivial CLIs (different prompt-delivery, file flags, JSON output
parsing, env vars) extend the recipe — `type: generic_cli` is optional but
makes the intent explicit:

```yaml
my_custom_cli:
  enabled: true
  type: generic_cli
  harness:
    my_custom_cli # used as the harness id; route via
    # used as the harness id; route via the model priority list
  command: my-cli # bare name; resolved via `which`
  tier: 2
  tier: subscription

  # Argv assembly:
  #   [...args_before_prompt, ?--model <m>, ?--workdir <dir>,
  #    <prompt slot>, ...args_after_prompt]
  # Flags only appear when their value is present.
  args_before_prompt: [run, --no-color]
  model_flag: --model
  cwd_flag: --workdir
  forward_env: [MY_CLI_API_KEY]

  # Prompt delivery — three modes:
  #   positional (default): prompt is a positional argv entry
  #   flag:                 prompt is [prompt_flag, <text>] AFTER model/cwd
  #   stdin:                prompt is fed on the child's stdin
  prompt_delivery: positional # or "flag" / "stdin"
  # prompt_flag: --prompt          # required when prompt_delivery: flag

  # Optional: extract the response text from a JSON envelope.
  # Falls back to plain stdout if parsing fails.
  output_json_path:
    result # supports nested paths e.g.
    #   choices.0.message.content
  tokens_json_path:
    usage # accepts {input,output},
    #   {input_tokens,output_tokens},
    #   {prompt_tokens,completion_tokens}

  model: my-cli-default-model
```

What you get for free:

- **Routing**: include the service in your `model_priority` (declare the
  service's `model:`). Or force it via
  `code({ prompt, hints: { service: "my_custom_cli" } })`.
- Quota / circuit-breaker integration with rate-limit detection on stderr
- Onboarding probe (`init`) with the same install/verify/ready flow as
  built-in harnesses
- Hot config reload — change the recipe and the router picks it up
  for routing decisions (between tool calls, no restart)

When to write a real dispatcher instead: if your CLI emits live tool-use
or thinking events you want to stream mid-run, or if it needs per-call
config-file mutations. The generic dispatcher treats the CLI as a black
box: argv in, plain stdout (or stdin/flag-fed prompt) out. That's enough
for most third-party tools.

## CLI

```bash
harness-router-mcp init                   # onboarding stack check (installed / verified / ready)
harness-router-mcp init --install         # auto-run npm install -g for missing or upgradable harnesses
harness-router-mcp mcp                    # MCP server on stdio
harness-router-mcp mcp --http 7330        # MCP server over streamable HTTP
harness-router-mcp route "<prompt>"       # one-shot dispatch with live streaming
harness-router-mcp list-services          # show enabled services (model + tier)
harness-router-mcp dashboard              # model priority / quota / breaker snapshot
harness-router-mcp dashboard --watch      # re-render every --interval ms
```

## Observability

Set `OTEL_EXPORTER_OTLP_ENDPOINT` to send spans to any OTLP collector (Honeycomb, Datadog, Jaeger, Tempo, …). Three span types:

- `harness-router-mcp.dispatcher.{dispatch,stream}` — per-CLI invocation, tagged with harness/model/tokens.
- `harness-router-mcp.router.{route,pick_service,route_to,stream}` — routing decisions.
- `harness-router-mcp.mcp.tool` — per MCP tool invocation.

Disable entirely with `OTEL_SDK_DISABLED=true`.

## Development

```bash
npm ci
npm run typecheck
npm test            # 227 vitest cases (includes prompt + tool round-trips)
npm run build
npm run smoke       # spawns dist/bin.js and runs a real JSON-RPC handshake
node dist/bin.js --help
```

## License

MIT — see [LICENSE](LICENSE).
