#!/usr/bin/env bash
# npm run plugins:test [-- <name>] — the scripts and hooks tests, every plugin's tests and the codex-computer-use helper
# tests when the ChatGPT app's node is present; with a name, only that plugin's tests (and its helper's).
# A failure does not stop the rest; the task fails at the end and names what failed.
set -euo pipefail
. scripts/tasks/lib.sh
use_pinned_tools
name=${1:-}
failed=()
if [ -n "$name" ]; then
  require_plugin "$name"
  dirs=("plugins/$name/")
else
  echo "==> scripts and hooks"
  node --test scripts/*.test.mjs || failed+=(scripts)
  dirs=(plugins/*/)
fi
for p in "${dirs[@]}"; do
  n=$(basename "$p")
  if [ -f "${p}hooks/hooks.json" ]; then
    echo "==> $n"
    claude plugin test "${p%/}" || failed+=("$n")
  else
    echo "==> $n: skipped, skills only"
  fi
done
if [ -z "$name" ] || [ "$name" = codex-computer-use ]; then
  cua_node=/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node
  if [ -x "$cua_node" ]; then
    echo "==> codex-computer-use helper"
    "$cua_node" --test plugins/codex-computer-use/helper/test/*.test.mjs || failed+=(codex-computer-use-helper)
  else
    echo "==> codex-computer-use helper: skipped, $cua_node not found"
  fi
fi
if [ "${#failed[@]}" -gt 0 ]; then echo "tests failed: ${failed[*]}" >&2; exit 1; fi
