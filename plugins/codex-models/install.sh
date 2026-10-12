#!/bin/sh
# Installs the codex-models proxy (ccmproxy) for this user and points Claude Code at it. Safe to run again.
#
#   install.sh                builds ccmproxy into ~/.claude/codex-models/bin, writes its config (random loopback
#                             port, new secret) under ~/.claude/codex-models/home, loads the LaunchAgent, checks the
#                             running proxy, then adds the base URL, the secret header, tool search and the /model
#                             rows to ~/.claude/settings.json (a timestamped backup beside it)
#   install.sh --check        only checks the prerequisites; changes nothing
#   install.sh --dry-run      prints the settings.json diff it would write (secret masked); changes nothing
#
# The settings are written only after the proxy answered as this install's: every Claude Code session on the
# machine reads them, so a proxy that is down or not ours would take them all down. uninstall.sh undoes it.
set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
TARGET="$HOME/.claude/codex-models"
PROXY_HOME="$TARGET/home"
BIN="$TARGET/bin/ccmproxy"
SETTINGS="$HOME/.claude/settings.json"
LABEL=com.anderson-spider.codex-models
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
# Keep in step with the root mise.toml (tests/scripts/install.test.mjs checks it). The plugin cache has no
# mise.toml, so the versions are named here rather than read from a config mise would have to trust.
GO_VERSION=1.27.1
NODE_VERSION=24

CHECK=
DRY_RUN=

usage() {
  echo "usage: install.sh [--check | --dry-run]" >&2
  exit 2
}

while [ $# -gt 0 ]; do
  case "$1" in
    --check) CHECK=1 ;;
    --dry-run) DRY_RUN=1 ;;
    *) usage ;;
  esac
  shift
done
[ -n "$CHECK" ] && [ -n "$DRY_RUN" ] && usage

say() { echo "codex-models: $*"; }
die() {
  echo "codex-models: $*" >&2
  exit 1
}

# mise runs from / so no project's mise.toml (and its trust prompt) applies; every path passed is absolute.
tool() { (cd / && mise exec "$@"); }
run_node() { tool "node@$NODE_VERSION" -- node "$@"; }

# --- Prerequisites ---

[ "$(uname -s)" = Darwin ] || die "macOS only: the proxy runs as a LaunchAgent"
command -v launchctl >/dev/null 2>&1 || die "launchctl is missing"
command -v mise >/dev/null 2>&1 || die "mise is missing (https://mise.jdx.dev); it provides Go $GO_VERSION and Node $NODE_VERSION"
(cd / && mise where "node@$NODE_VERSION") >/dev/null 2>&1 || die "Node $NODE_VERSION is not installed: run mise install node@$NODE_VERSION"

if [ -d "$HERE/proxy" ]; then
  (cd / && mise where "go@$GO_VERSION") >/dev/null 2>&1 || die "Go $GO_VERSION is not installed: run mise install go@$GO_VERSION"
  VERSION=$(run_node "$HERE/install/cli.mjs" version-of "$HERE/.claude-plugin/plugin.json")
else
  # The copy in ~/.claude/codex-models has no source: it reuses the binary it was installed with.
  [ -x "$BIN" ] && [ -f "$HERE/VERSION" ] || die "no proxy source in $HERE and no built proxy in $BIN: run install.sh from the plugin"
  VERSION=$(cat "$HERE/VERSION")
fi

# The settings are checked before anything is built, copied or loaded: a refusal later would leave a running proxy
# behind that nothing points at.
run_node "$HERE/install/cli.mjs" precheck --settings "$SETTINGS" --config "$PROXY_HOME/config.json" ||
  die "nothing was changed"

if [ -n "$CHECK" ]; then
  say "ready to install $VERSION"
  exit 0
fi

TMP=$(mktemp -d "${TMPDIR:-/tmp}/codex-models.XXXXXX")
AGENT_LOADED=
# Once the LaunchAgent is loaded, any failure says how to remove it.
on_exit() {
  code=$?
  rm -rf "$TMP"
  if [ "$code" -ne 0 ] && [ -n "$AGENT_LOADED" ]; then
    echo "codex-models: the proxy's LaunchAgent is loaded; $TARGET/uninstall.sh removes it" >&2
  fi
}
trap on_exit EXIT
trap 'exit 130' INT TERM

# GOFLAGS is replaced, not emptied: Go reads an empty GOFLAGS as unset and falls back to the one `go env -w` saved, so a
# stray -tags=contract (or -race, or -buildvcs=false) there or in the environment would shape the installed binary.
# GOTOOLCHAIN=local keeps the pinned Go: a GOTOOLCHAIN saved by `go env -w` or set in the environment would otherwise
# download and build with another release.
build() {
  say "building ccmproxy $VERSION with Go $GO_VERSION"
  tool "go@$GO_VERSION" -- env GOFLAGS=-tags= GOTOOLCHAIN=local go -C "$HERE/proxy" build -trimpath -ldflags "-X main.version=$VERSION" -o "$1" ./cmd/ccmproxy
}

# --- Dry run: the same steps on copies under $TMP ---

if [ -n "$DRY_RUN" ]; then
  if [ -d "$HERE/proxy" ]; then
    build "$TMP/ccmproxy"
    PROXY="$TMP/ccmproxy"
  else
    PROXY="$BIN"
  fi
  mkdir -p "$TMP/home"
  [ -f "$PROXY_HOME/config.json" ] && cp -p "$PROXY_HOME/config.json" "$TMP/home/config.json"
  CCMPROXY_HOME="$TMP/home" "$PROXY" config init >/dev/null
  CCMPROXY_HOME="$TMP/home" "$PROXY" env --shell json >"$TMP/env.json"
  CCMPROXY_HOME="$TMP/home" "$PROXY" models --json >"$TMP/models.json"
  say "dry run: would install ccmproxy $VERSION into $BIN and load $LABEL from $PLIST"
  [ -f "$PROXY_HOME/config.json" ] || say "dry run: no config yet, so the port and secret below are examples"
  run_node "$HERE/install/cli.mjs" merge --dry-run --settings "$SETTINGS" --env "$TMP/env.json" --models "$TMP/models.json"
  exit 0
fi

# --- Binary, scripts and config ---

mkdir -p "$TARGET/bin" "$PROXY_HOME/log" "$HOME/Library/LaunchAgents"
chmod 700 "$TARGET" "$PROXY_HOME"

if [ -d "$HERE/proxy" ]; then
  # Built beside and renamed over, so a running proxy keeps its own file until it restarts.
  build "$TARGET/bin/.ccmproxy.new"
  mv -f "$TARGET/bin/.ccmproxy.new" "$BIN"
fi

# A copy outside the plugin cache, so uninstall.sh runs once the plugin is gone or updated.
if [ "$HERE" != "$TARGET" ]; then
  rm -rf "$TARGET/install"
  cp -R "$HERE/install" "$TARGET/install"
  cp "$HERE/install.sh" "$HERE/uninstall.sh" "$TARGET/"
  chmod +x "$TARGET/install.sh" "$TARGET/uninstall.sh"
  printf '%s\n' "$VERSION" >"$TARGET/VERSION"
fi

cat >"$TARGET/ccmproxy" <<EOF
#!/bin/sh
# ccmproxy on this install's config and login, e.g. ~/.claude/codex-models/ccmproxy login codex
CCMPROXY_HOME="$PROXY_HOME" exec "$BIN" "\$@"
EOF
chmod +x "$TARGET/ccmproxy"

CCMPROXY_HOME="$PROXY_HOME" "$BIN" config init

# --- LaunchAgent ---

cat >"$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$BIN</string>
    <string>serve</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>CCMPROXY_HOME</key><string>$PROXY_HOME</string>
  </dict>
  <key>WorkingDirectory</key><string>$PROXY_HOME</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>$PROXY_HOME/log/ccmproxy.log</string>
  <key>StandardErrorPath</key><string>$PROXY_HOME/log/ccmproxy.log</string>
</dict>
</plist>
EOF

DOMAIN="gui/$(id -u)"

# bootout returns before a running proxy has exited, and a bootstrap in that window fails with
# "5: Input/output error": wait for the old one to go.
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
AGENT_LOADED=1
say "$LABEL loaded from $PLIST"

# --- Preflight, then settings ---

CCMPROXY_HOME="$PROXY_HOME" "$BIN" env --shell json >"$TMP/env.json"
run_node "$HERE/install/cli.mjs" preflight --env "$TMP/env.json" --version "$VERSION" ||
  die "the proxy did not pass its checks, so settings.json was left alone"

CCMPROXY_HOME="$PROXY_HOME" "$BIN" models --json >"$TMP/models.json"
mkdir -p "$HOME/.claude"
run_node "$HERE/install/cli.mjs" merge --settings "$SETTINGS" --env "$TMP/env.json" --models "$TMP/models.json"

say "installed $VERSION. New Claude Code sessions go through the proxy; running ones keep their settings until restarted."
say "sign in to Codex once: $TARGET/ccmproxy login codex (inside Claude Code: ! $TARGET/ccmproxy login codex)"
say "to undo: $TARGET/uninstall.sh"
