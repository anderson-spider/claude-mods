#!/bin/sh
# Installs the codex-cu helper into ~/.claude/mcp/codex-cu (the socket path the
# codex-computer-use plugin expects) as a per-user LaunchAgent: started at login,
# restarted if it crashes. Safe to run again; `state/` (approvals, log) is kept.
#
#   install.sh                     helper only (plugin installed from the marketplace)
#   install.sh --plugin-dir <dir>  also load the plugin from <dir> through
#                                  CLAUDE_CODE_PLUGIN_DIRS in ~/.claude/settings.json
set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
TARGET="$HOME/.claude/mcp/codex-cu"
LABEL=com.anderson-spider.codex-cu
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
NODE=/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node
PLUGIN_DIR=

while [ $# -gt 0 ]; do
  case "$1" in
    --plugin-dir) PLUGIN_DIR=$(cd "$2" && pwd); shift 2 ;;
    *) echo "usage: install.sh [--plugin-dir <dir>]" >&2; exit 2 ;;
  esac
done

if [ ! -x "$NODE" ]; then
  echo "codex-cu: $NODE is missing. Install the ChatGPT desktop app and turn on Computer Use in Codex first." >&2
  exit 1
fi

"$NODE" "$HERE/launch.mjs" --check >/dev/null || {
  echo "codex-cu: the Codex computer-use configuration failed its check; run: $NODE $HERE/launch.mjs --check" >&2
  exit 1
}

mkdir -p "$TARGET/state" "$TARGET/run" "$HOME/Library/LaunchAgents"
chmod 700 "$TARGET/state" "$TARGET/run"

# From a clone or the plugin cache: copy the code over, never the state.
if [ "$HERE" != "$TARGET" ]; then
  rm -rf "$TARGET/lib" "$TARGET/test"
  cp -R "$HERE/lib" "$HERE/test" "$TARGET/"
  cp "$HERE/launch.mjs" "$HERE/helper.mjs" "$HERE/install.sh" "$HERE/uninstall.sh" "$TARGET/"
  chmod +x "$TARGET"/*.sh "$TARGET"/*.mjs
  echo "helper: code copied to $TARGET"
fi

cat >"$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>$TARGET/helper.mjs</string>
  </array>
  <key>WorkingDirectory</key><string>$TARGET</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>$TARGET/state/helper.log</string>
  <key>StandardErrorPath</key><string>$TARGET/state/helper.log</string>
</dict>
</plist>
EOF

DOMAIN="gui/$(id -u)"

# bootout returns before a running helper has exited, and a bootstrap in that
# window fails with "5: Input/output error": wait for the old one to go.
launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
tries=0
while launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1 && [ $tries -lt 50 ]; do
  sleep 0.2
  tries=$((tries + 1))
done

tries=0
until launchctl bootstrap "$DOMAIN" "$PLIST" 2>/dev/null; do
  tries=$((tries + 1))

  # The last try shows launchctl's error, and `set -e` stops on it.
  if [ $tries -ge 5 ]; then
    launchctl bootstrap "$DOMAIN" "$PLIST"
    break
  fi

  sleep 1
done
echo "helper: $LABEL loaded from $PLIST"

[ -n "$PLUGIN_DIR" ] || exit 0

# Optional: CLAUDE_CODE_PLUGIN_DIRS in the env block of ~/.claude/settings.json.
"$NODE" - "$HOME/.claude/settings.json" "$PLUGIN_DIR" <<'EOF'
const fs = require('node:fs')
const [file, dir] = process.argv.slice(2)
const settings = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {}
settings.env = settings.env ?? {}
const dirs = (settings.env.CLAUDE_CODE_PLUGIN_DIRS ?? '').split(':').filter(Boolean)
if (!dirs.includes(dir)) {
  dirs.push(dir)
  settings.env.CLAUDE_CODE_PLUGIN_DIRS = dirs.join(':')
  if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak-codex-cu`)
  fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`)
  console.log(`plugin: added ${dir} to CLAUDE_CODE_PLUGIN_DIRS in ${file}`)
} else {
  console.log(`plugin: ${dir} already in CLAUDE_CODE_PLUGIN_DIRS`)
}
EOF
