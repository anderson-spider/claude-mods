#!/usr/bin/env bash
# npm run plugins:types [-- <name>] — generate the claude-code typings one plugin's (or every plugin's) tsconfig.json extends.
# Claude Code writes plugins/*/.claude-plugin/types/ only when an interactive session loads a plugin from its folder,
# so this opens one on a pseudo-terminal with the plugin (or every plugin) and exits once each has its typings.
set -euo pipefail
name=${1:-}
if [ -n "$name" ]; then
  [[ "$name" =~ ^[a-z][a-z0-9-]*$ && -d "plugins/$name" ]] || { echo "no such plugin: $name" >&2; exit 1; }
  [ -f "plugins/$name/tsconfig.json" ] || { echo "$name ships skills only and has no typings" >&2; exit 1; }
  dirs=("plugins/$name/")
else
  dirs=()
  for d in plugins/*/; do [ -f "${d}tsconfig.json" ] && dirs+=("$d"); done
fi
args=()
for d in "${dirs[@]}"; do args+=(--plugin-dir "${d%/}"); done
ready() { for d in "${dirs[@]}"; do [ -f "${d}.claude-plugin/types/tsconfig.json" ] || return 1; done; }
# util-linux `script` (Linux) takes the command with -c; BSD `script` (macOS) takes it after the file.
pty() { if script --version >/dev/null 2>&1; then script -q -e -c "$(printf '%q ' "$@")" /dev/null; else script -q /dev/null "$@"; fi; }
{ for _ in $(seq 120); do ready && break; sleep 1; done; sleep 2; printf '/exit\r'; } | pty claude "${args[@]}" >/dev/null 2>&1 || true
ready || { echo "typings were not written for ${name:-every plugin}" >&2; exit 1; }
echo "typings written for ${name:-every plugin}"
