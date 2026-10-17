#!/usr/bin/env bash
# npm run plugins:validate [-- <name>] — validate the marketplace and every plugin (or one plugin), then check that the
# manifests agree. A failure does not stop the rest; the task fails at the end and names what failed.
set -euo pipefail
. scripts/tasks/lib.sh
use_pinned_tools
name=${1:-}
failed=()
if [ -n "$name" ]; then
  require_plugin "$name"
  dirs=("plugins/$name/")
else
  echo "==> marketplace"
  claude plugin validate --strict . || failed+=(marketplace)
  dirs=(plugins/*/)
fi
for p in "${dirs[@]}"; do
  echo "==> $(basename "$p")"
  claude plugin validate --strict "${p%/}" || failed+=("$(basename "$p")")
done
echo "==> consistency"
node scripts/check-consistency.mjs || failed+=(consistency)
if [ "${#failed[@]}" -gt 0 ]; then echo "validate failed: ${failed[*]}" >&2; exit 1; fi
