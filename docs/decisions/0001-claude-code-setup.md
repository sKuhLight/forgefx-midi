# ADR-0001: Claude Code baseline setup for forgefx-midi

- **Status:** Accepted
- **Date:** 2026-07-07
- **Owners:** maintainer

## Context

forgefx-midi is a pure-TypeScript ESM codec and catalog library for Fractal
Audio devices. It has several properties that make unassisted automated edits
risky:

- **Generated-file footgun.** Large parts of the tree are machine-generated
  (`src/**/*.generated.ts`, `src/am4/paramNamesGenerated.ts`, `src/version.ts`,
  `catalog/*.json`). Hand-editing them produces changes that are silently lost on
  the next build and mask the real source of a value.
- **Non-standard test runner.** Tests run through a custom harness
  (`npm run build && npm test`), where the build step is mandatory because a
  smoke suite reads from `dist/`. A naive "just run the tests" approach yields
  false failures.
- **Browser-safety invariant.** Browser-relevant entry points must not import
  `node:*` modules or other Node-only code, and the package deliberately carries
  zero runtime dependencies.

Separately, the project family that includes this repo adopted a single central
task tracker so that active and planned work — goals, rationale, and status — is
recorded in one place rather than scattered across chat context and TODO
comments.

## Decision

Adopt the family-wide Claude Code baseline for this repo:

- A shared `.claude/settings.json` with conservative permissions and a deny-list
  covering the generated files above (and `dist/`), so edits to them are blocked.
- `PreToolUse` guard hooks that enforce the same invariants at execution time.
- Two subagents: `reviewer` (read-only diff review for generated-file edits,
  browser-safety, new dependencies, codec/table correctness, and table hygiene)
  and `test-runner` (encodes the build-first runner knowledge and reports only
  failures with a diagnosis).
- A `/plan-feature` slash command that plans changes without editing code and
  enforces the task-tracking step.
- An ADR log under `docs/decisions/` (this file and the template).
- Mandatory task tracking in Plane (see CLAUDE.md, "Task tracking" section).
  Server and project identifiers live only in the local-only CLAUDE.md and are
  deliberately kept out of this public-facing repo.

## Alternatives

- **No tooling (status quo).** Rejected: the generated-file and build-first
  footguns keep recurring, with no guardrail to catch them.
- **README-only conventions.** Rejected: documented conventions are not enforced,
  so automated and human edits still violate them.

## Consequences

- Agents operate with enforced guardrails (permissions plus hooks), not just
  advice, reducing generated-file and browser-safety mistakes.
- Contributors get the conventions written down and reviewable.
- Some files are intentionally local-only and gitignored (`CLAUDE.md`,
  `.mcp.json`). They must be recreated per clone from the private family-wide
  setup guide; a fresh clone will not have task-tracking wiring until that is
  done.
