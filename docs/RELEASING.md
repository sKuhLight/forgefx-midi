# Releasing forgefx-midi

forgefx-midi is **stage 1** of the cross-repo release chain:

```
forgefx-midi  →  ForgeFX  →  Axis  →  axisapp.live
```

Protocol facts land here first; the tag build gates them and notifies ForgeFX so the
rest of the stack can ripple the change.

## Release steps

1. Merge your change to `master` and confirm CI is green (`ci.yml`: build + full test
   suite, plus the advisory downstream-ForgeFX job).
2. Bump the version: `npm version X.Y.Z --no-git-tag-version`, commit.
3. Tag it: `git tag vX.Y.Z && git push origin master --tags`.
4. Pushing the tag runs `release.yml`, which:
   - runs the full gate (**build first**, then `npm test` — the smoke suite reads `dist/`),
   - `npm pack`s the tarball and publishes a GitHub release (`forgefx-midi vX.Y.Z`) with
     auto-generated notes and the `*.tgz` attached,
   - sends a `codec-released` `repository_dispatch` to `sKuhLight/ForgeFX` so its CI
     re-validates the server against the new codec release.

## Downstream pinning

Downstream repos (ForgeFX, Axis) pin this repo's git ref in their `stack.lock.json` for
**release builds only** — their CI keeps tracking default-branch HEAD. Bumping those pins
is part of *their* release checklists, not this one.

## Secrets

- `STACK_DISPATCH_TOKEN` — a PAT with `repo` scope on `sKuhLight/ForgeFX`, used by the
  notify step. If unset, the notify step prints a notice and succeeds (the release still
  publishes).

## Automation

- **version-guard** (`ci.yml`) enforces a version bump on every non-docs PR: unless the PR
  touches only `*.md`, `package.json`'s version must be greater than the base branch's
  (`npm version X.Y.Z --no-git-tag-version` — bump the lockfile too). Docs-only PRs pass
  without a bump.
- **After a release**, ForgeFX automatically receives a pin-bump PR (its `codec-bump.yml`
  reacts to our `codec-released` dispatch and bumps `stack.lock.json → forgefx-midi.ref`).
  Merging that PR adopts the new codec pin; whether it also becomes a ForgeFX *release* is
  a human decision — see the decision rule in ForgeFX's `docs/RELEASING.md` (wire/API- or
  catalog-affecting change → release; internal-only → the pin rides the next release).
