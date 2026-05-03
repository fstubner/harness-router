# harness-router-mcp

> **Same model, different harness, different result.**
> An MCP server that routes coding tasks across Claude Code, Cursor, Codex, Gemini CLI, OpenCode, and GitHub Copilot CLI — quota-aware, circuit-breaking, and (model × harness) scored. Plug in any other CLI with a one-line YAML entry.

[![npm version](https://img.shields.io/npm/v/harness-router-mcp.svg)](https://www.npmjs.com/package/harness-router-mcp)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**Landing page:** [fstubner.github.io/harness-router-mcp](https://fstubner.github.io/harness-router-mcp/)

---

## Why a _harness_ router?

Other LLM routers (OpenRouter, LiteLLM, etc.) route raw model APIs. Harness Router routes **agentic CLIs** — recognising that Claude inside Cursor isn't the same thing as Claude inside Claude Code, even though it's the same underlying model.

Each configured service is a **(model, harness)** pair:

```
claude_code_opus  = claude-opus-4-6        × claude_code harness
cursor_sonnet     = claude-sonnet-4-6      × cursor harness
codex_gpt54       = gpt-5.4                × codex harness
gemini31pro       = gemini-3.1-pro-preview × gemini_cli harness
opencode_sonnet   = claude-sonnet-4-6      × opencode harness
```

The harness brings tooling — Cursor's codebase indexing, Claude Code's Bash/Read/Edit, Codex's `--full-auto` execution, Gemini's 2M-token context window, OpenCode's provider-agnostic tool layer with multi-subscription support. Your task lands in the harness whose tooling actually fits the work, not just the harness whose underlying model is highest on a leaderboard.

## What it does

- **`code_auto`** — picks the best available (model × harness) for the task. Hints accepted: `task_type`, `harness`, `prefer_large_context`, explicit `service`.
- **`code_mixture`** — fans the prompt out to multiple services in parallel and returns all outputs for synthesis. Useful when you want a second opinion on architecture decisions.
- **Per-harness tools** — `code_with_claude`, `code_with_cursor`, `code_with_codex`, `code_with_gemini`, `code_with_opencode`, `code_with_copilot` for explicit routing.
- **Quota-aware** — tracks free-tier usage per service and steers traffic away from exhausted ones.
- **Circuit breaker** — failing services trip out of rotation automatically; recovery is half-open + probed.
- **Live dashboard** — `harness-router-mcp dashboard --watch` for a TTY view of tier, ELO, quota, and breaker state per service.
- **OpenTelemetry** — optional OTLP export of dispatch / routing / MCP-tool spans.

### Built-in MCP prompts

The server also advertises five prompts via the MCP `prompts/list` capability — they show up in the host's prompt picker (Claude Desktop's slash menu, Cursor's command palette) and serve as built-in documentation for the server's tools:

| Prompt                    | What it does                                                                                     |
| ------------------------- | ------------------------------------------------------------------------------------------------ |
| `route-coding-task`       | Sends a task through `code_auto` with optional `task_type` hint. The most common entry point.    |
| `compare-implementations` | Fans a task out via `code_mixture` and synthesizes the strongest answer from each harness.       |
| `harness-health-check`    | Inspects every service's reachability, quota, and breaker state — diagnostic flow.               |
| `onboard-coding-stack`    | Walks through running `harness-router-mcp init` and fixing each not-ready harness one at a time. |
| `pick-best-harness`       | Recommends a harness for a task without dispatching. Explanatory flow.                           |

## Install

```bash
# One-shot (recommended for Claude Desktop / Cursor configs)
npx -y harness-router-mcp mcp

# Global
npm install -g harness-router-mcp
harness-router-mcp --help
```

Requires **Node ≥ 20** and at least one installed CLI: `claude`, `codex`, `gemini`, Cursor's `agent`, `opencode`, `copilot` (GitHub Copilot CLI), or any third-party CLI you register via YAML.

## Onboarding

The fastest way to know whether your stack is ready:

```bash
harness-router-mcp init
```

Per-harness checklist with three states (installed / verified / ready) and the exact next-step command for anything red. Runs a tiny ~5-token dispatch to verify each CLI's auth + JSON parsing actually works end-to-end.

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

Restart Claude Desktop. The 12 MCP tools (`code_auto`, `code_mixture`, `code_with_*` for each of the 6 built-in harnesses, `get_quota_status`, `list_available_services`, `dashboard`, `setup`) become available in the chat.

## Routing & scoring

Each enabled service is scored per task:

```
score = quality_score × cli_capability × capabilities[task_type] × quota_score × weight
```

| Term                      | Meaning                                                                                                                                                                                          |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `quality_score`           | normalized ELO × thinking multiplier. ELO source priority: bundled `data/coding_benchmarks.json` (Arena + Aider + SWE-bench blend) → live Arena AI Code leaderboard (24h cached) → 0.85 default. |
| `cli_capability`          | how much the harness adds beyond the raw model. Reference: `claude_code` 1.10, `codex` 1.08, `cursor` 1.05, `gemini_cli` 1.00.                                                                   |
| `capabilities[task_type]` | per-service relative strength on `execute` / `plan` / `review`.                                                                                                                                  |
| `quota_score`             | live availability ∈ [0, 1], updated from each dispatch response.                                                                                                                                 |
| `weight`                  | static preference multiplier from config (default 1.0).                                                                                                                                          |

Services group into tiers (Frontier / Strong / Fast) by ELO. Tier 1 is always tried first; the router only falls through to tier 2/3 when every tier-1 service is circuit-broken or quota-exhausted.

### Model escalation

A service can auto-escalate to a stronger model on reasoning-heavy task types:

```yaml
claude_code_sonnet:
  model: claude-sonnet-4-6
  escalate_model: claude-opus-4-6
  escalate_on: [plan, review] # Sonnet for execute, Opus for plan/review
```

`code_auto` resolves the right model per task before dispatch — Sonnet speed on execution, Opus depth on design decisions, no manual switching.

## Adding a new service

```yaml
cursor_opus:
  enabled: true
  harness: cursor
  command: agent
  model: claude-opus-4-6-thinking-max
  tier: 1
  leaderboard_model: "claude-opus-4-6"
  cli_capability: 1.05
  weight: 1.0
  capabilities:
    execute: 0.94
    plan: 0.97
    review: 0.96
```

OpenAI-compatible endpoints (Ollama, LM Studio, OpenRouter) work too:

```yaml
ollama_local:
  enabled: true
  type: openai_compatible
  base_url: http://localhost:11434/v1
  model: llama3.2
  api_key: ""
  tier: 3
  weight: 0.6
```

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
`code_auto({ prompt, hints: { harness: "my_custom_cli" } })`.

For non-trivial CLIs (different prompt-delivery, file flags, JSON output
parsing, env vars) extend the recipe — `type: generic_cli` is optional but
makes the intent explicit:

```yaml
my_custom_cli:
  enabled: true
  type: generic_cli
  harness:
    my_custom_cli # used as the harness id; route via
    # code_auto with hints.harness="my_custom_cli"
  command: my-cli # bare name; resolved via `which`
  tier: 2
  cli_capability: 1.0

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

  capabilities:
    execute: 0.9
    plan: 0.7
    review: 0.7
```

What you get for free:

- **Routing**: invoke via `code_auto` (or `code_mixture`) with the
  `harness:` hint set to the YAML key — e.g.
  `code_auto({ prompt, hints: { harness: "my_custom_cli" } })`.
  The five built-in harnesses each have a dedicated `code_with_<harness>`
  shortcut tool; **`code_with_<custom>` is not auto-registered for
  `generic_cli` services** (the MCP tool list is built once at startup
  from the static built-in registry). Use the `harness:` hint instead.
- Quota / circuit-breaker integration with rate-limit detection on stderr
- Onboarding probe (`init`) with the same install/verify/ready flow as
  built-in harnesses
- Hot config reload — change the recipe and the router picks it up
  for routing decisions (the MCP tool registry stays static — restart
  the server to add/remove `code_with_<harness>` tools)

When to write a real dispatcher instead: if your CLI emits live tool-use
or thinking events you want to stream mid-run, or if it needs per-call
config-file mutations (the way Gemini's settings.json patch works). The
generic dispatcher treats the CLI as a black box: argv in, plain stdout
(or stdin/flag-fed prompt) out. That's enough for most third-party tools.

**Known gaps** (open issues, not stoppers):

- No `code_with_<custom>` shortcut tool gets auto-registered for
  third-party `generic_cli` services — the MCP tool list is built once at
  startup from the static built-in registry of 6 harnesses. Route
  third-party services via `code_auto({hints:{harness:"<id>"}})` instead.
  Generic CLI services DO appear in the `harness-router-mcp init`
  per-harness checklist (`auth_command` from the recipe is surfaced as
  the auth CTA).
- File context is appended to the prompt as a `Files to work with: …`
  block. There's no `--file <path>` per-file flag injection — if your CLI
  needs that, write a wrapper script or a hand-tuned dispatcher.

## CLI

```bash
harness-router-mcp init                   # onboarding stack check (installed / verified / ready)
harness-router-mcp init --install         # auto-run npm install -g for missing or upgradable harnesses
harness-router-mcp mcp                    # MCP server on stdio
harness-router-mcp mcp --http 7330        # MCP server over streamable HTTP
harness-router-mcp route "<prompt>"       # one-shot dispatch with live streaming
harness-router-mcp list-services          # show enabled (model × harness) services
harness-router-mcp dashboard              # tier / ELO / quota / breaker snapshot
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
