# harness-router-mcp — Routing Instructions

When working in this repo (or any repo where `harness-router-mcp` is wired into your MCP client), route coding tasks through its tools instead of attempting them directly. You are the orchestrator — delegate, then synthesize.

## When to route

Route any task involving: writing code, fixing bugs, running tests, code review, architecture decisions, refactoring, debugging, or explaining code.

## How to route

Use `code_auto` with a `task_type` hint that matches what the task actually is:

```
code_auto(
  prompt="<full task description>",
  workingDir="<absolute path to project>",
  hints={ taskType: "execute" | "plan" | "review" }
)
```

| task_type | Use for                                                         | Best harness       |
| --------- | --------------------------------------------------------------- | ------------------ |
| execute   | Running tests, applying fixes, autonomous multi-step coding     | codex → cursor     |
| plan      | Architecture, design decisions, "how should we build X"         | claude_code (Opus) |
| review    | Code review, security audit, explain code, refactor suggestions | claude_code (Opus) |

## Model escalation (claude_code harness)

A `claude_code` service can auto-escalate to a stronger model on reasoning-heavy task types:

- `taskType=execute` → Sonnet (fast, cheap)
- `taskType=plan|review` → Opus (extended thinking)

This is configured per-service in `config.yaml` via `escalate_model` + `escalate_on`. `code_auto` resolves the right model before dispatch — no manual switching.

## For multiple perspectives

Use `code_mixture` when the task benefits from different harness opinions (architecture decisions, design tradeoffs, anything where blind spots matter):

```
code_mixture(prompt="<task>", hints={ taskType: "plan" })
```

It fans the prompt out to every available harness in parallel and returns each output for you to synthesize.

## Per-harness routing

When you specifically need one harness's strengths, use the explicit tools — they bypass the router and pick the best service of that harness:

- `code_with_claude` — file/Bash/Edit tools, strong on plan & review
- `code_with_cursor` — codebase indexing, strong on execute in editor flows
- `code_with_codex` — full-auto execution loop, strongest on pure execute
- `code_with_gemini` — 1M+ token context, strong on review/plan over large codebases
- `code_with_opencode` — provider-agnostic OSS agent, multi-subscription per install
- `code_with_copilot` — GitHub Copilot CLI, GitHub-tooling-aware (gh / repo / PR context)
- For third-party CLIs registered via YAML, route through `code_auto({hints:{harness:"<your-id>"}})` — there's no auto-registered `code_with_<custom>` tool

## Health check

If unsure about service availability before routing, call `dashboard` (or `get_quota_status` / `list_available_services` for structured data). For first-time setup, run `harness-router-mcp init` from the terminal — it walks through installed/verified state per harness with exact next-step commands.
