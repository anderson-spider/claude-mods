#!/bin/sh
# Installs the crew Codex helper into ~/.claude/mcp/crew-codex (the socket path the crew plugin expects) as a
# per-user LaunchAgent: started at login, restarted if it crashes. Safe to run again; `state/` (the isolated Codex
# home with its login link, the log) is kept.
#
#   install.sh          install or update
#   install.sh --check  only check the prerequisites; changes nothing
set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
TARGET="$HOME/.claude/mcp/crew-codex"
LABEL=com.anderson-spider.crew-codex
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
NODE=/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node
CHECK=

while [ $# -gt 0 ]; do
  case "$1" in
    --check) CHECK=1; shift ;;
    *) echo "usage: install.sh [--check]" >&2; exit 2 ;;
  esac
done

if [ ! -x "$NODE" ]; then
  echo "crew-codex: $NODE is missing. Install the ChatGPT desktop app first." >&2
  exit 1
fi

"$NODE" "$HERE/helper.mjs" --check >/dev/null || {
  echo "crew-codex: no codex binary or no Codex login found; install the Codex CLI and run \`codex login\`, then: $NODE $HERE/helper.mjs --check" >&2
  exit 1
}

if [ -n "$CHECK" ]; then
  echo "crew-codex: ready to install"
  exit 0
fi

mkdir -p "$TARGET/state" "$TARGET/run" "$HOME/Library/LaunchAgents"
chmod 700 "$TARGET/state" "$TARGET/run"

# From a clone or the plugin cache: copy the code over, never the state.
if [ "$HERE" != "$TARGET" ]; then
  rm -rf "$HOME/.claude/mcp/crew-codex/lib"
  cp -R "$HERE/lib" "$TARGET/"
  cp "$HERE/helper.mjs" "$HERE/install.sh" "$HERE/uninstall.sh" "$TARGET/"
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
