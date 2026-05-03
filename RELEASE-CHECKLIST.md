# v0.1.0 release checklist

This file is a hand-off from the pre-publish audit pass. Everything in
"Pre-flight" is already green. Sections "Repo setup" through "Day-of"
need actions on your side that I can't do unattended (account-bound
operations, DNS, gh-cli interactive prompts).

Delete this file after the release ships.

---

## Pre-flight (already green)

- [x] `npm audit --omit=dev`: **0 vulns**
- [x] License audit: all permissive (MIT / Apache-2.0 / ISC / BSD / BlueOak)
- [x] Secret scan (current tree + git history): clean
- [x] `npm run check`: typecheck + lint + format + **362 tests across 29 files**
- [x] `npm pack --dry-run`: tarball matches `files` field
- [x] `npm view harness-router-mcp`: 404 (name available)
- [x] Tarball install + `init`: **6/6 harnesses ready** end-to-end
      (claude_code, codex, cursor, gemini_cli, opencode, copilot)
- [x] **Real MCP dispatch verified live** for every working harness +
      auto-promote (2-line YAML registers any third-party CLI)
- [x] **Long-running multi-step task verified**: claude_code wrote
      rpn.py + test_rpn.py via Write tool, all 4 pytest tests pass
- [x] **Codex rate-limit / quota error surfacing fixed** — clean
      "You've hit your usage limit" message + `rateLimited: true`
      propagated through MCP response
- [x] **OpenCode `--cwd` flag bug fixed** — current opencode 1.14.x
      doesn't accept `--cwd`; we now rely on subprocess cwd
- [x] **MCP prompts updated** for all 6 harnesses + generic_cli third-party note
- [x] **Server-level instructions updated** to advertise all 12 tools
      and the YAML-third-party path
- [x] CHANGELOG promoted to `[0.1.0] — 2026-05-01`
- [x] `package.json` version: `0.1.0`
- [x] CODE_OF_CONDUCT.md, SECURITY.md, CONTRIBUTING.md, README.md all
      present and consistent
- [x] CI matrix (Node 20/22 × ubuntu/windows/macOS) configured with
      lint + coverage gate
- [x] Provenance wired in `publish.yml` with OIDC

## Repo setup (do once)

### npm account

- [ ] Enable 2FA on your npm account: <https://www.npmjs.com/settings/<your-username>/profile>
- [ ] In the GitHub repo Settings → Secrets and variables → Actions →
      Environments, create a `release` environment with the `NPM_TOKEN`
      secret set to a publish-scoped npm automation token.
      (`publish.yml` references this environment.)

### GitHub repo (after first push)

- [ ] Description: copy from README's tagline.
- [ ] Topics: `mcp`, `model-context-protocol`, `harness`, `router`,
      `claude-code`, `cursor`, `codex`, `gemini`, `opencode`, `copilot`,
      `github-copilot`, `ai-agents`, `load-balancing`, `circuit-breaker`.
- [ ] Website: leave empty until the custom domain is live, then set
      to `https://<your-domain>`.
- [ ] Settings → General → Features: - Issues: ON (templates already exist) - Discussions: ON (good for "how do I add harness X" questions) - Wiki: OFF - Projects: OFF
- [ ] Settings → Branches → Branch protection on `main`: - Require a pull request before merging - Require status checks: every leg of the CI matrix
      (`Test (Node 20 / ubuntu-latest)` and the other 5 combinations)
      plus the `Coverage (Node 22 / ubuntu)` job - Require linear history - Disallow force pushes + deletions
- [ ] Settings → Pages: source is GitHub Actions (the existing
      `pages.yml`). Custom domain field is added in the Pages-DNS step
      below.

## Custom domain (when ready)

Detailed steps in `docs/CUSTOM_DOMAIN.md`. Summary:

- [ ] Register the domain.
- [ ] Add the four A records (apex) or one CNAME (subdomain).
- [ ] Wait for DNS propagation (`dig <domain>`).
- [ ] Rename `docs/CNAME.placeholder` → `docs/CNAME` with the real
      domain inside.
- [ ] Replace `fstubner.github.io/harness-router-mcp` with the new
      domain across `package.json` (`homepage`), `README.md`, and
      `docs/index.html` (og:url + twitter:url).
- [ ] Push; verify GitHub Pages picks up the CNAME.
- [ ] Settings → Pages → Enforce HTTPS once the cert provisions.

## Release day

```bash
# Sanity: tree is clean, on main, CI green
git status
git pull
gh run list --workflow=ci.yml --limit 1

# Tag and push
git tag -a v0.1.0 -m "v0.1.0 — initial public release"
git push origin v0.1.0

# Watch the publish workflow
gh run watch
```

The `publish.yml` workflow:

1. Runs `npm ci`
2. Runs `npm run check` (typecheck + lint + format + tests)
3. Runs `npm run build`
4. Calls `npm publish --provenance --access public`

Once the workflow exits 0:

- [ ] Confirm the package shows up at <https://www.npmjs.com/package/harness-router-mcp>
- [ ] Confirm the provenance badge is attached
- [ ] Confirm README renders correctly on the package page

## Post-publish smoke

```bash
# Fresh tempdir on the release-day machine
cd "$(mktemp -d)"
npm init -y >/dev/null
npm install harness-router-mcp
npx harness-router-mcp --version       # should print 0.1.0
npx harness-router-mcp init             # 6/6 ready when all installed; otherwise the
                                        # subset you have on PATH (each missing one
                                        # shows the exact npm/install command)
```

If any of those fails:

- npm publishes are immutable. Don't try to overwrite — bump to
  `0.1.1`, fix forward, tag, push.
- For a typo-only fix in README/CHANGELOG (no code change), the
  fastest patch is `npm deprecate harness-router-mcp@0.1.0 "use 0.1.1"`
  followed by 0.1.1 publish.

## GitHub release

After `v0.1.0` is on npm:

```bash
gh release create v0.1.0 --notes-from-tag --verify-tag
```

Or if you want auto-generated release notes from the CHANGELOG, copy
the `[0.1.0]` section verbatim into the release body via:

```bash
awk '/^## \[0.1.0\]/,/^## \[/' CHANGELOG.md | sed '$d' > /tmp/release-body.md
gh release create v0.1.0 --title "v0.1.0 — initial release" --notes-file /tmp/release-body.md
```
