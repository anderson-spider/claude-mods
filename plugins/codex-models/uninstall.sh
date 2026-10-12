#!/bin/sh
# Undoes install.sh: first takes exactly what it added out of ~/.claude/settings.json (a timestamped backup beside
# it), then stops and removes the LaunchAgent. The order matters: a session started in between reaches Anthropic
# directly instead of a proxy that is gone. The Codex login, the config and the binary under ~/.claude/codex-models
# stay unless --purge.
#
#   uninstall.sh            settings, then the LaunchAgent
#   uninstall.sh --dry-run  prints the settings.json diff it would write (secret masked); changes nothing
#   uninstall.sh --purge    also deletes ~/.claude/codex-models (the login, the config, the binary, these scripts)
set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
TARGET="$HOME/.claude/codex-models"
STATE="$TARGET/settings-state.json"
SETTINGS="$HOME/.claude/settings.json"
LABEL=com.anderson-spider.codex-models
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
NODE_VERSION=24

DRY_RUN=
PURGE=

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --purge) PURGE=1 ;;
    *)
      echo "usage: uninstall.sh [--dry-run | --purge]" >&2
      exit 2
      ;;
  esac
  shift
done
if [ -n "$DRY_RUN" ] && [ -n "$PURGE" ]; then
  echo "usage: uninstall.sh [--dry-run | --purge]" >&2
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

if [ -n "$DRY_RUN" ]; then
  run_node "$CLI" unmerge --dry-run --settings "$SETTINGS" --state "$STATE"
  say "dry run: would then stop $LABEL and remove $PLIST"
  exit 0
fi

# Settings first: if they cannot be put back, the proxy keeps running so open sessions keep working.
run_node "$CLI" unmerge --settings "$SETTINGS" --state "$STATE" ||
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

if [ -n "$PURGE" ]; then
  rm -rf "$TARGET"
  say "deleted $TARGET (the Codex login, the config and the binary)"
else
  say "kept $TARGET (the Codex login and config); uninstall.sh --purge deletes it"
fi
