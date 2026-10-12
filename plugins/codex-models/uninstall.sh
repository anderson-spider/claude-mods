#!/bin/sh
# Undoes install.sh: first takes exactly what it added out of ~/.claude/settings.json (a timestamped backup beside
# it), then stops and removes the LaunchAgent. The order matters: a session started in between reaches Anthropic
# directly instead of a proxy that is gone. The config (with the remote and its key) and the binary under ~/.claude/codex-models
# stay for inspection and reinstall.
#
#   uninstall.sh            settings, then the LaunchAgent; installed files and backups stay
set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
TARGET="$HOME/.claude/codex-models"
SETTINGS="$HOME/.claude/settings.json"
LABEL=com.anderson-spider.codex-models
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
NODE_VERSION=24

if [ $# -ne 0 ]; then
  echo "usage: uninstall.sh" >&2
  exit 2
fi

say() { echo "codex-models: $*"; }
die() {
  echo "codex-models: $*" >&2
  exit 1
}

# Node from mise, as install.sh runs it (from / so no project config applies); a plain node on PATH otherwise.
if command -v mise >/dev/null 2>&1 && (cd / && mise where "node@$NODE_VERSION") >/dev/null 2>&1; then
  run_node() { (cd / && mise exec "node@$NODE_VERSION" -- node "$@"); }
elif command -v node >/dev/null 2>&1; then
  run_node() { node "$@"; }
else
  die "no Node found (mise node@$NODE_VERSION or node on PATH); nothing was changed"
fi

CLI="$HERE/install/cli.mjs"
[ -f "$CLI" ] || CLI="$TARGET/install/cli.mjs"
[ -f "$CLI" ] || die "$CLI is missing; nothing was changed"

# Settings first: if they cannot be put back, the proxy keeps running so open sessions keep working.
run_node "$CLI" unmerge --settings "$SETTINGS" ||
  die "settings.json was not changed, so the LaunchAgent stays loaded"

DOMAIN="gui/$(id -u)"
launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
tries=0
while launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1 && [ $tries -lt 50 ]; do
  sleep 0.2
  tries=$((tries + 1))
done
rm -f "$PLIST"
say "$LABEL stopped and removed"
say "running Claude Code sessions still point at the stopped proxy: restart them"

say "kept $TARGET (config, logs, binary and scripts)"
