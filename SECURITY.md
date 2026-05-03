# Security Policy

## Supported versions

| Version | Status               |
| ------- | -------------------- |
| 0.1.x   | ✓ supported (latest) |
| < 0.1   | ✗ no security fixes  |

While the project is in `0.x`, only the most recent minor version receives security fixes.

## Reporting a vulnerability

**Do not open a public issue for security-sensitive reports.** Instead, use one of:

1. **GitHub private vulnerability reporting** — preferred. Open the [Security tab](https://github.com/fstubner/harness-router-mcp/security/advisories/new) on the repo and submit a private advisory.
2. **Email** — `felix.stubner@gmail.com` with `[harness-router-mcp security]` in the subject line.

Please include:

- Affected version (`harness-router-mcp --version`)
- A reproducer or proof-of-concept
- Your assessment of impact (confidentiality / integrity / availability)
- Whether you've disclosed this anywhere else

## Response timeline

- **Within 72 hours** — acknowledgement that we've received your report.
- **Within 7 days** — initial triage with severity assessment.
- **Within 30 days** — patch released for confirmed High/Critical issues, or a clear timeline if more time is required.

We'll credit reporters in the release notes unless you'd prefer to remain anonymous.

## Scope

In scope:

- The published `harness-router-mcp` npm package and its `dist/` output.
- The MCP tools and prompts the server exposes.
- The `harness-router-mcp init` install/upgrade flow.

Out of scope:

- Vulnerabilities in the underlying CLIs (`claude`, `codex`, `gemini`, `agent`) — please report those upstream to their respective vendors.
- Vulnerabilities in dependencies — those should typically be reported to the dependency author, though we'll triage and bump versions if relevant.
- Issues that require local code-execution or filesystem access on the user's machine to exploit.
