# Contributing to harness-router

Thanks for considering a contribution. This project is in `0.x` and the surface area is still moving — small, focused PRs land fastest.

## Development setup

```bash
git clone https://github.com/fstubner/harness-router.git
cd harness-router
npm ci
```

You'll need **Node ≥ 22** and at least one of the supported CLIs on PATH (`claude`, `codex`, `gemini`, Cursor's `agent`, `opencode`, or `copilot`) if you want live route probing to work. CI runs the unit tests without any of them.

## Useful scripts

| Command                | What it does                                                                      |
| ---------------------- | --------------------------------------------------------------------------------- |
| `npm run check`        | Typecheck (src + tests) and run all 456 vitest cases. Run this before pushing.    |
| `npm run typecheck`    | Typecheck only — fast feedback on type errors in both `src/` and `tests/`.        |
| `npm test`             | Vitest, run mode.                                                                 |
| `npm run test:watch`   | Vitest, watch mode.                                                               |
| `npm run build`        | Compile TypeScript to `dist/`. Required before `npm run smoke`.                   |
| `npm run smoke`        | Spawns `dist/bin.js mcp` and exchanges JSON-RPC frames — release-readiness check. |
| `npm run format`       | Apply Prettier across the repo.                                                   |
| `npm run format:check` | Verify Prettier formatting (used in CI).                                          |

For a real end-to-end dispatch through your installed CLIs:

```bash
HARNESS_ROUTER_LIVE_DISPATCH=1 npm run smoke
```

This costs ~$0.005 in API tokens (one tiny dispatch per harness).

## Project layout

```
src/
  bin.ts                    # CLI entrypoint (init / route / dashboard / mcp)
  router.ts                 # scoring + dispatch decision
  config.ts                 # YAML loader + auto-detect
  quota.ts                  # quota tracking + persistence
  leaderboard.ts            # ELO source priority
  circuit-breaker.ts
  onboarding.ts             # `init` orchestrator
  dispatchers/              # per-harness CLI invokers
    claude-code.ts
    codex.ts
    cursor.ts
    gemini.ts
    openai-compatible.ts
  mcp/
    server.ts               # MCP server entrypoints (stdio + HTTP)
    tools.ts                # 10 MCP tools
    prompts.ts              # 5 MCP prompts
    dispatcher-factory.ts
    config-hot-reload.ts
  observability/            # OpenTelemetry spans
  dashboard/                # `dashboard` renderer
tests/                      # vitest cases mirroring src/ layout
scripts/
  mcp-smoke.mjs             # end-to-end JSON-RPC smoke
  fetch_benchmarks.py       # refresh data/coding_benchmarks.json
docs/
  index.html                # landing page (deployed via GitHub Pages)
```

## Adding a new harness

1. Implement a dispatcher in `src/dispatchers/<name>.ts` extending `BaseDispatcher`. The `stream()` method is the canonical primitive; `dispatch()` falls out of it via the base class.
2. Register the harness in `src/mcp/dispatcher-factory.ts:HARNESS_TABLE`.
3. Add an entry to `src/onboarding.ts:HARNESS_SPECS` (display name, command, npm package or download URL, auth command).
4. Add unit tests under `tests/dispatchers/<name>.test.ts` covering the success path and at least one error path.
5. Run `npm run check`. The full suite must pass on Linux, macOS, and Windows.

## Style

- **Prettier** is the source of truth for formatting. Run `npm run format` before committing.
- **TypeScript strict mode** is on, including `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess`. Tests are typechecked too.
- **No suppressions without a comment** — if you write `// @ts-ignore`, explain why on the next line.
- **Errors carry context** — surface what the user can do (e.g., "run `codex auth login`") not just what failed.

## Reporting issues

Use the issue templates in [`.github/ISSUE_TEMPLATE/`](.github/ISSUE_TEMPLATE). For security issues, please follow [`SECURITY.md`](SECURITY.md) instead of opening a public issue.

## Code of conduct

Participation in this project (issues, PRs, discussions) is governed by the project's [Code of Conduct](CODE_OF_CONDUCT.md), which adopts the Contributor Covenant 2.1. Reports go to **felix.stubner@gmail.com**.

## License

By contributing, you agree that your contributions will be licensed under the MIT license (see [LICENSE](LICENSE)).
