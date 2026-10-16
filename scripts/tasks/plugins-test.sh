#!/usr/bin/env bash
# npm run plugins:test — the scripts and hooks tests, every plugin's tests, and the codex-computer-use helper tests
# when the ChatGPT app's node is present.
set -euo pipefail
echo "==> scripts and hooks"
node --test scripts/*.test.mjs
for p in plugins/*/; do
  if [ -f "${p}hooks/hooks.json" ]; then echo "==> $(basename "$p")"; claude plugin test "${p%/}"; else echo "==> $(basename "$p"): skipped, skills only"; fi
done
cua_node=/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node
if [ -x "$cua_node" ]; then
  echo "==> codex-computer-use helper"
  "$cua_node" --test plugins/codex-computer-use/helper/test/*.test.mjs
else
  echo "==> codex-computer-use helper: skipped, $cua_node not found"
fi
