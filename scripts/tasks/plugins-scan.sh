#!/usr/bin/env bash
# npm run plugins:scan — save each plugin's `claude plugin validate --strict` output under .scan/ for diffing.
# The output lists each hook with its event and `.catch`, plus the calls and state a plugin reads and writes, so a refactor
# PR can diff it: run this, `mv .scan .scan.before`, change the code, run it again and `diff -r .scan.before .scan`.
# The repository path is stripped so the files compare across worktrees. Neither directory is committed.
set -euo pipefail
. scripts/tasks/lib.sh
use_pinned_tools
mkdir -p .scan
status=0
for p in plugins/*/; do
  name=$(basename "$p")
  claude plugin validate --strict "${p%/}" > ".scan/$name.raw" 2>&1 || status=1
  sed "s#$PWD/##g" ".scan/$name.raw" > ".scan/$name.txt"
  rm ".scan/$name.raw"
  echo "saved .scan/$name.txt"
done
exit $status
