# v0.3.0 release checklist

Use this checklist for the `harness-router` npm package release from the
existing `fstubner/harness-router-mcp` repository. If the GitHub repository is
renamed later, update `package.json`, README, CHANGELOG links, and Pages URLs
in the same change.

## Local pre-flight

- [ ] Worktree clean and on the intended release branch.
- [ ] `npm ci`
- [ ] `npm run check`
- [ ] `npm run test:coverage`
- [ ] `npm run build`
- [ ] `npm run smoke`
- [ ] `npm audit --omit=dev`
- [ ] `npm pack --dry-run`
- [ ] Verify `package.json` and `package-lock.json` both say
      `harness-router@0.3.0`.
- [ ] Verify `config.example.yaml` parses:
      `harness-router list-services --config config.example.yaml`.
- [ ] Verify npm name availability before first publish:
      `npm view harness-router version` should return 404 until published.

## Optional live validation

These checks consume real quota and require local CLI/API auth.

- [ ] `HARNESS_ROUTER_CONFIG=<real-config> npm run smoke -- --live`
- [ ] `harness-router doctor`
- [ ] `harness-router doctor --probe-routes`
- [ ] Fresh temp install from tarball:
      `npm pack && npm install -g ./harness-router-0.3.0.tgz`
- [ ] `npx harness-router --version` prints `harness-router 0.3.0`.
- [ ] Add/remove one MCP host with `harness-router install --print`,
      then inspect the generated snippet before writing host configs.

## Account-bound setup

- [ ] npm 2FA enabled.
- [ ] GitHub Actions `release` environment has publish-scoped `NPM_TOKEN`.
- [ ] Branch protection/status checks configured on `main`.
- [ ] GitHub Pages URL and package homepage are intentional.

## Release day

```bash
git status
git pull --ff-only
npm ci
npm run check
npm run test:coverage
npm run build
npm run smoke
npm audit --omit=dev
npm pack --dry-run

git tag -a v0.3.0 -m "v0.3.0"
git push harness v0.3.0
gh run watch
```

The publish workflow runs on `v*` tags and publishes with npm provenance.

## Post-publish smoke

```bash
cd "$(mktemp -d)"
npm init -y >/dev/null
npm install harness-router
npx harness-router --version
npx harness-router --help
npx harness-router onboard
```

If the package needs a fix after publication, publish a new patch version.
npm package versions are immutable.
