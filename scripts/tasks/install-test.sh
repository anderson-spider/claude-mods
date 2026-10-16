#!/usr/bin/env bash
# npm run install:test — install the marketplace from this checkout on a clean Linux machine (a Docker image), as a
# new user would, and check that every plugin is installed and loads. Needs Docker; no login and no network once built.
set -euo pipefail
image=claude-mods-install-test
docker build --quiet -f scripts/install-test/Dockerfile -t "$image" . >/dev/null
docker run --rm "$image"
