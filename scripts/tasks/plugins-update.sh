#!/usr/bin/env bash
# npm run plugins:update — refresh the marketplace and update every installed plugin from it, in its own scope, with
# your own claude.
set -euo pipefail
. scripts/tasks/lib.sh
use_own_claude
node scripts/update-plugins.mjs
