#!/bin/sh
# Stops and removes the codex-cu LaunchAgent. With --plugin-dir <dir>, also
# takes <dir> out of CLAUDE_CODE_PLUGIN_DIRS. Files under ~/.claude/mcp/codex-cu
# (code, approvals, log) stay; delete them by hand if wanted.
set -eu

LABEL=com.anderson-spider.codex-cu
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
NODE=/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node
PLUGIN_DIR=

while [ $# -gt 0 ]; do
  case "$1" in
    --plugin-dir) PLUGIN_DIR=$(cd "$2" && pwd); shift 2 ;;
    *) echo "usage: uninstall.sh [--plugin-dir <dir>]" >&2; exit 2 ;;
  esac
done

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
rm -f "$PLIST"
echo "helper: $LABEL removed"

[ -n "$PLUGIN_DIR" ] || exit 0

"$NODE" - "$HOME/.claude/settings.json" "$PLUGIN_DIR" <<'EOF'
const fs = require('node:fs')
const [file, dir] = process.argv.slice(2)
const settings = JSON.parse(fs.readFileSync(file, 'utf8'))
const dirs = (settings.env?.CLAUDE_CODE_PLUGIN_DIRS ?? '').split(':').filter(one => one !== '' && one !== dir)
if (dirs.length === 0) delete settings.env.CLAUDE_CODE_PLUGIN_DIRS
else settings.env.CLAUDE_CODE_PLUGIN_DIRS = dirs.join(':')
fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`)
console.log(`plugin: ${dir} removed from CLAUDE_CODE_PLUGIN_DIRS`)
EOF
