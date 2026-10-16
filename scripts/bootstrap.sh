#!/bin/sh
# One-step setup of this marketplace: adds it, installs or updates every plugin and, on macOS, installs the
# codex-computer-use helper (a LaunchAgent) from the installed plugin. Elsewhere codex-computer-use, which controls
# native Mac apps, is left out. Safe to run again.
#
#   bootstrap.sh                     everything below
#   bootstrap.sh --only tailscale,chatgpt only those plugins
#   bootstrap.sh --check             prints what it would do and checks the prerequisites; changes nothing
#
# BOOTSTRAP_SOURCE replaces the GitHub repository as the marketplace source (a local checkout, for a test install).
#
# Run it straight from GitHub:
#   curl -fsSL https://raw.githubusercontent.com/anderson-spider/claude-mods/main/scripts/bootstrap.sh | sh
# Arguments go after `sh -s --`.
#
# Secrets are never handled here: set them yourself with `claude plugin configure <plugin>`.
set -eu

MARKET=spider-claude-mods
REPO=${BOOTSTRAP_SOURCE:-anderson-spider/claude-mods}
# Every plugin of the marketplace; check-consistency keeps this list equal to marketplace.json.
ALL="chatgpt codex-computer-use coolify gitlab session-hud spider-team tailscale"
NODE=${BOOTSTRAP_NODE:-/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node}
ONLY=
CHECK=

while [ $# -gt 0 ]; do
  case "$1" in
    --check) CHECK=1; shift ;;
    --only) [ $# -ge 2 ] || { echo "usage: bootstrap.sh [--check] [--only a,b]" >&2; exit 2; }; ONLY=$2; shift 2 ;;
    *) echo "usage: bootstrap.sh [--check] [--only a,b]" >&2; exit 2 ;;
  esac
done

say() { printf '==> %s\n' "$*"; }
warn() { printf 'warn: %s\n' "$*" >&2; }
fail() { printf 'error: %s\n' "$*" >&2; exit 1; }

# A step that changes something: printed alone under --check.
act() {
  if [ -n "$CHECK" ]; then printf 'would: %s\n' "$*"; else "$@"; fi
}

command -v claude >/dev/null 2>&1 || fail "claude is not on PATH; install Claude Code first"
MAC=
[ "$(uname -s)" = Darwin ] && MAC=1

if [ -n "$ONLY" ]; then
  PLUGINS=$(printf '%s' "$ONLY" | tr ',' ' ')
  for p in $PLUGINS; do
    case " $ALL " in *" $p "*) ;; *) fail "unknown plugin '$p' (one of: $ALL)" ;; esac
    [ -n "$MAC" ] || [ "$p" != codex-computer-use ] || fail "codex-computer-use controls native Mac apps: macOS only"
  done
elif [ -n "$MAC" ]; then
  PLUGINS=$ALL
else
  PLUGINS=$(printf '%s' "$ALL" | sed 's/ *codex-computer-use//')
  say "codex-computer-use left out: it controls native Mac apps"
fi

say "marketplace $MARKET"
if claude plugin marketplace list --json 2>/dev/null | grep -q "\"name\": *\"$MARKET\""; then
  act claude plugin marketplace update "$MARKET"
else
  act claude plugin marketplace add "$REPO"
fi

LISTED=$(claude plugin list --json 2>/dev/null || true)
for p in $PLUGINS; do
  say "plugin $p"
  if printf '%s' "$LISTED" | grep -q "\"$p@$MARKET\""; then
    act claude plugin update "$p@$MARKET" --scope user
  else
    act claude plugin install "$p@$MARKET" --scope user
  fi
done

# The plugin's own folder holds its helper: the installer copies the code to ~/.claude/mcp and loads the LaunchAgent.
helper() {
  name=$1
  [ -x "$NODE" ] || { warn "$name helper skipped: $NODE is missing (install the ChatGPT desktop app)"; return 0; }
  if [ -n "$CHECK" ] && ! claude plugin list --json 2>/dev/null | grep -q "\"$name@$MARKET\""; then
    printf 'would: install the %s helper from the plugin once it is installed\n' "$name"
    return 0
  fi
  dir=$(claude plugin list --json 2>/dev/null |
    sed -n "s|.*\"installPath\": *\"\\([^\"]*/$MARKET/$name/[^\"]*\\)\".*|\\1|p" | head -1)
  [ -n "$dir" ] && [ -f "$dir/helper/install.sh" ] || fail "$name: no helper/install.sh in the installed plugin"
  say "helper $name"
  if [ -n "$CHECK" ]; then sh "$dir/helper/install.sh" --check; else sh "$dir/helper/install.sh"; fi
}

for p in $PLUGINS; do
  case "$p" in
    codex-computer-use) helper codex-computer-use ;;
  esac
done

printf '\ndone. Next:\n  - start a new Claude Code session, or run /reload-plugins\n'
for p in $PLUGINS; do
  case "$p" in
    codex-computer-use) echo '  - codex-computer-use: `/codex-cu status` should report the helper running' ;;
    coolify) echo '  - coolify needs its url and apiKey: `claude plugin configure coolify`' ;;
    gitlab) echo '  - gitlab needs its tokens (host=token pairs): `claude plugin configure gitlab`' ;;
    tailscale) echo '  - tailscale needs its apiKey: `claude plugin configure tailscale`' ;;
  esac
done
