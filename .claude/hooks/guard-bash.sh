#!/usr/bin/env bash
# PreToolUse guard for Bash: block destructive or generated-file-clobbering commands.
# Exits 2 with a one-line reason on stderr to block; exits 0 otherwise.
set -euo pipefail

raw="$(cat)"

if command -v jq >/dev/null 2>&1; then
  cmd="$(printf '%s' "$raw" | jq -r '.tool_input.command // ""')"
else
  # Conservative fallback: scan the whole raw payload.
  cmd="$raw"
fi

block() { echo "guard-bash: blocked - $1" >&2; exit 2; }

# rm -rf targeting / or ~ (root or home)
if printf '%s' "$cmd" | grep -Eq 'rm[[:space:]]+(-[A-Za-z]*[[:space:]]+)*-?[A-Za-z]*[rR][A-Za-z]*f|rm[[:space:]]+-[A-Za-z]*f[A-Za-z]*[rR]'; then
  if printf '%s' "$cmd" | grep -Eq 'rm[[:space:]]+.*[[:space:]](/|~|\$HOME)([[:space:]]|/|$)'; then
    block "rm -rf targeting / or home"
  fi
fi

# git force push (--force, --force-with-lease, or short -f flag)
if printf '%s' "$cmd" | grep -Eq 'git[[:space:]]+push' \
   && printf '%s' "$cmd" | grep -Eq '(--force([[:space:]=]|$)|[[:space:]]-[A-Za-z]*f[A-Za-z]*([[:space:]]|$))'; then
  block "git push --force is not allowed"
fi

# In-place writes onto protected/generated files (sed -i, tee, >, >>)
prot='(\.generated\.ts|src/version\.ts|(^|[[:space:]])catalog/[^[:space:]]*\.json|paramNamesGenerated\.ts)'
if printf '%s' "$cmd" | grep -Eq "(sed[[:space:]]+-i|tee)[^|]*$prot"; then
  block "in-place write to a generated file - edit the generator and re-run the export/build"
fi
if printf '%s' "$cmd" | grep -Eq '(>>?)[[:space:]]*[^|&>]*'"$prot"; then
  block "redirect onto a generated file - edit the generator and re-run the export/build"
fi

exit 0
