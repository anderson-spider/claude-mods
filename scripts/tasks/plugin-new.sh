#!/usr/bin/env bash
# npm run plugin:new -- <name> [description] — scaffold a plugin that passes the consistency checks, then generate its typings.
# Everything check-consistency requires is written, so the plugin passes it with only the text left to fill in.
set -euo pipefail
name=${1:?usage: npm run plugin:new -- <name> [description]}
node scripts/new-plugin.mjs "$name" ${2:+"$2"}
bash scripts/tasks/plugins-types.sh "$name" || { echo "scaffolded, but the typings were not written: run npm run plugins:types -- $name" >&2; exit 1; }
