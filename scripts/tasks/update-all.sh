#!/usr/bin/env bash
# npm run update:all — from the main checkout: pull main and update every installed plugin.
set -euo pipefail
if [ "$(git rev-parse --path-format=absolute --git-dir)" != "$(git rev-parse --path-format=absolute --git-common-dir)" ]; then
  echo "run update:all from the main checkout, not a worktree" >&2
  exit 1
fi
if [ -n "$(git status --porcelain)" ]; then
  echo "the working tree has changes; commit or stash them first" >&2
  exit 1
fi
echo "==> main"
git switch main
git pull --ff-only
echo "==> tools"
npm ci
echo "==> plugins"
node scripts/update-plugins.mjs
claude plugin list --json | node -e '
  const rows = JSON.parse(require("fs").readFileSync(0, "utf8")).filter(p => p.id.endsWith("@spider-claude-mods"))
  for (const p of rows) console.error(`${p.id} ${p.version} (${p.scope}${p.enabled ? "" : ", disabled"})`)
'
echo "done: run /reload-plugins in running sessions, or start a new one"
