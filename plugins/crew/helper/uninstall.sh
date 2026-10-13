#!/bin/sh
# Stops and removes the crew Codex LaunchAgent. Files under ~/.claude/mcp/crew-codex (code, isolated Codex home,
# log) stay; delete them by hand if wanted.
set -eu

LABEL=com.anderson-spider.crew-codex
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
if [ $# -gt 0 ]; then
  echo "usage: uninstall.sh" >&2
  exit 2
fi

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
rm -f "$PLIST"
echo "helper: $LABEL removed"
