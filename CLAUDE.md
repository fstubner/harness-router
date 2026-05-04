# harness-router-mcp — Routing Instructions

When working in this repo (or any repo where `harness-router-mcp` is wired into your MCP client), route coding tasks through its tools instead of attempting them directly. You are the orchestrator — delegate, then synthesize.

## When to route

Route any task involving: writing code, fixing bugs, running tests, code review, architecture decisions, refactoring, debugging, or explaining code.

## How to route

Call the `code` tool. It walks the user's `model_priority` list, preferring subscription-backed services over metered API for the same model.

```
code(
  prompt="<full task description>",
  workingDir="<absolute path to project>",   // optional; defaults to cwd
  files=[<absolute paths>],                  // optional, max 256 entries
  hints={                                    // optional
    model: "<canonical model id>",   // bump this model to the front of the priority list
    service: "<service name>"        // force a specific dispatcher (bypasses priority walk)
  }
)
```

The router's algorithm is short: walk `model_priority`. For each model, try every subscription-tier service (highest quota first), then every metered-tier service. When all routes for a model fail, drop to the next model.

## Picking a different model on the fly

The model is what you care about; the CLI is plumbing. Two ways to influence:

- `hints.model` — bump a specific model to the front of the priority list. Falls through normally if it has no usable routes. Use this when the prompt benefits from a heavier model (e.g. architectural reasoning).
- `hints.service` — force a specific dispatcher entirely (bypasses the model walk). Use sparingly; you're overriding quota tracking.

## For multiple perspectives

Call `code_mixture` when the task benefits from contrasts between services (architecture decisions, design tradeoffs, anything where blind spots matter):

```
code_mixture(prompt="<task>")
```

It fans the prompt to every available service in parallel and returns one result per service for you to synthesize.

## Health check

Before routing — or when something fails unexpectedly — call `dashboard` for a multi-line text status of every configured service (model, tier, quota, breaker state, the router's current pick). `get_quota_status` returns the same data as JSON for tooling.

For first-time setup, run `harness-router-mcp onboard` to wire the router into your MCP hosts. Run `harness-router-mcp doctor` afterwards (or any time something feels off) to verify each underlying CLI is installed, authed, and dispatching — it walks installed/verified/ready state per harness with exact next-step commands for anything red.
