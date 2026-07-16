# Releasing forgefx-midi

forgefx-midi is **stage 1** (the chain root) of the cross-repo release chain:

```
forgefx-midi  →  ForgeFX  →  Axis  →  axisapp.live
```

Protocol facts land here first; a release gates them, publishes the tarball, and notifies
ForgeFX so the rest of the stack ripples the change. Releases are **zero-touch**: merging a
PR to `master` is the only manual step in the normal case.

## Normal path (just merge a PR)

`master` is **PR-only** now (branch ruleset — no direct commits). To ship:

1. Open a PR, get CI green (`ci.yml`: build + full test suite, plus the advisory
   downstream-ForgeFX job), and merge it.
2. That's it. When CI passes on `master`, **`release-on-main.yml`** computes the next version
   from the last tag + the PR's `release:*` label and pushes the tag, which runs
   **`release.yml`**: full gate → inject the tag version into `package.json` → `npm pack` →
   publish the GitHub release (tarball + `release-manifest.json`) → `codec-released` dispatch
   to ForgeFX (opens its pin-bump PR).

**No manual version bump, tag, or publish.** Feature PRs never touch `package.json` — the
version is derived from tags at release time.

### Choosing the bump (labels)

The version bump comes from a single `release:*` label on the merged PR (default: **patch**):

| label | effect |
|---|---|
| _(none)_ | patch — unless the PR touches only `docs/`, `.github/`, or `*.md` → **no release** |
| `release:patch` | patch |
| `release:minor` | minor |
| `release:major` | major |
| `release:none` | skip the release (changes ride the next one) |
| `release:hold` | skip for now (hold the release deliberately) |

`release:hold` / `release:none` always win over a co-present bump label; more than one *bump* label
(`release:patch`/`minor`/`major`) fails `release-on-main` (it refuses to guess between bumps). This
repo's version channel has **no suffix** (plain `X.Y.Z`). `pr-labels.yml` (advisory, not required)
echoes the effective classification on every PR.

## Recovery / manual paths

The old manual mechanism still works as the recovery path:

- **Re-run / force a version:** run **`release-on-main`** via *workflow_dispatch* with an
  explicit `version` (no leading `v`), or `dry_run: true` to just print the computed
  label/version without tagging.
- **Classic manual tag:** `npm version X.Y.Z --no-git-tag-version` (optional) then
  `git tag vX.Y.Z && git push origin vX.Y.Z` still triggers `release.yml` unchanged. The tag
  is the source of truth; `release.yml` injects that version before building.
- **Emergency stop:** set the repo Actions variable **`RELEASE_AUTOMATION_ENABLED=false`** to
  halt `release-on-main` (and every downstream auto-gate). Unset/any-other value = enabled.

## Downstream pinning

Downstream repos (ForgeFX, Axis) pin this repo's git ref in their `stack.lock.json` for
**release builds only** — their CI keeps tracking default-branch HEAD. After a release,
ForgeFX automatically receives a pin-bump PR (its `codec-bump.yml` reacts to the
`codec-released` dispatch); merging it adopts the new codec pin. Do **not** hand-edit
downstream `stack.lock.json`.

## Secrets & variables

- **`STACK_DISPATCH_TOKEN`** — PAT with `repo` scope on `sKuhLight/ForgeFX`. Used to push the
  auto-tag (GITHUB_TOKEN-pushed tags do **not** trigger `release.yml`) and to send the
  `codec-released` dispatch. If missing, `release-on-main` skips with a notice and the release
  chain simply stalls (recover with a manual tag once restored).
- **`RELEASE_AUTOMATION_ENABLED`** (variable) — emergency stop; `false` halts automation.
