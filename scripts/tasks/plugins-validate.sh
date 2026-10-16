#!/usr/bin/env bash
# npm run plugins:validate — validate the marketplace and every plugin, then check that the manifests agree.
set -euo pipefail
claude plugin validate --strict .
for p in plugins/*/; do echo "==> $(basename "$p")"; claude plugin validate --strict "${p%/}"; done
node scripts/check-consistency.mjs
