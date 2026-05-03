<!--
Thanks for the PR. A few quick checks before requesting review will speed things up.
-->

## What this changes

<!-- One or two sentences. What's different after this PR? -->

## Why

<!-- The problem or use case. Link to the related issue if there is one (e.g. "Closes #123"). -->

## How

<!-- Briefly: the approach, any important trade-offs, and the alternatives you ruled out. -->

## Verification

- [ ] `npm run check` passes locally (typecheck + 243 tests)
- [ ] `npm run build` succeeds
- [ ] If you touched a dispatcher or the router: `HARNESS_ROUTER_LIVE_DISPATCH=1 npm run smoke` passes for at least one harness
- [ ] If you touched user-facing strings or the README: a stranger could understand the change without reading the diff

## Risk / blast radius

<!-- Honest assessment: what could break? What did you specifically *not* change to keep this PR small? -->

## Notes for the reviewer

<!-- Anything they'd otherwise have to dig into the diff to find. -->
