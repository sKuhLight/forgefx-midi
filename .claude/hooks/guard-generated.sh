#!/usr/bin/env bash
# PreToolUse guard for Edit/Write: block edits to generated files.
# Exits 2 with a clear reason on stderr to block; exits 0 otherwise.
set -euo pipefail

raw="$(cat)"

if command -v jq >/dev/null 2>&1; then
  path="$(printf '%s' "$raw" | jq -r '.tool_input.file_path // ""')"
else
  # Conservative fallback: scan the whole raw payload.
  path="$raw"
fi

prot='(\.generated\.ts|src/version\.ts|(^|/)catalog/[^"[:space:]]*\.json|paramNamesGenerated\.ts)'
if printf '%s' "$path" | grep -Eq "$prot"; then
  echo "guard-generated: blocked - generated file. Edit the generator and re-run 'npm run catalog:export' / 'npm run build' instead." >&2
  exit 2
fi

exit 0
