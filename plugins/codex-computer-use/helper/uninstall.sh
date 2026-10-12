#!/bin/sh
# Stops and removes the codex-cu LaunchAgent. Files under ~/.claude/mcp/codex-cu
# (code, approvals, log) stay; delete them by hand if wanted.
set -eu

LABEL=com.anderson-spider.codex-cu
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
if [ $# -gt 0 ]; then
  echo "usage: uninstall.sh" >&2
  exit 2
fi

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
rm -f "$PLIST"
echo "helper: $LABEL removed"
