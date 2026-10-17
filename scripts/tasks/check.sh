#!/usr/bin/env bash
# npm run check [-- <name>] — the required CI checks, for every plugin or one: the version bump of committed changes
# against origin/main as last fetched (always every plugin), plugins:validate, plugins:test and typecheck.
# Every step runs; the task fails at the end and names the steps that failed.
set -euo pipefail
. scripts/tasks/lib.sh
use_pinned_tools
name=${1:-}
[ -z "$name" ] || require_plugin "$name"
failed=()
step() {
  local label=$1
  shift
  echo "=== $label"
  "$@" || failed+=("$label")
}
step "version bump" node scripts/check-version-bump.mjs origin/main
step validate bash scripts/tasks/plugins-validate.sh ${name:+"$name"}
step test bash scripts/tasks/plugins-test.sh ${name:+"$name"}
if [ -z "$name" ] || [ -f "plugins/$name/tsconfig.json" ]; then
  step typecheck bash scripts/tasks/typecheck.sh ${name:+"$name"}
else
  echo "=== typecheck: skipped, $name ships skills only"
fi
if [ "${#failed[@]}" -gt 0 ]; then echo "check failed: ${failed[*]}" >&2; exit 1; fi
echo "check passed"
