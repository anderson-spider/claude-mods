#!/usr/bin/env bash
# npm run plugins:sync — refresh the marketplace, then update every installed plugin it lists and uninstall those it no
# longer lists, each in its own scope, with your own claude.
set -euo pipefail
. scripts/tasks/lib.sh
use_own_claude
node scripts/sync-plugins.mjs
