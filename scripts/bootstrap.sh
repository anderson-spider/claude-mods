#!/bin/sh
# One-step setup of this marketplace on a Mac: adds the marketplace, installs or updates the plugins and installs
# the two Codex helpers (LaunchAgents) from the installed plugins. Safe to run again.
#
#   bootstrap.sh                     everything below
#   bootstrap.sh --only crew,chatgpt only those plugins (and their helpers)
#   bootstrap.sh --check             prints what it would do and checks the prerequisites; changes nothing
#
# The repository is private, so fetch it with the GitHub token of `gh`:
#   curl -fsSL -H "Authorization: Bearer $(gh auth token)" -H 'Accept: application/vnd.github.raw' \
#     https://api.github.com/repos/anderson-spider/claude-mods/contents/scripts/bootstrap.sh | sh
# Arguments go after `sh -s --`.
#
# Secrets are never handled here: set `jevKey` or `apiKey` yourself with `claude plugin configure <plugin>`.
set -eu

MARKET=spider-claude-mods
REPO=anderson-spider/claude-mods
ALL="crew chatgpt codex-computer-use tailscale"
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

[ "$(uname -s)" = Darwin ] || fail "macOS only: the helpers are launchd LaunchAgents"
command -v claude >/dev/null 2>&1 || fail "claude is not on PATH; install Claude Code first"

if [ -n "$ONLY" ]; then
  PLUGINS=$(printf '%s' "$ONLY" | tr ',' ' ')
  for p in $PLUGINS; do
    case " $ALL " in *" $p "*) ;; *) fail "unknown plugin '$p' (one of: $ALL)" ;; esac
  done
else
  PLUGINS=$ALL
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
  need=$2
  [ -x "$NODE" ] || { warn "$name helper skipped: $NODE is missing (install the ChatGPT desktop app)"; return 0; }
  if [ "$need" = codex-login ]; then
    command -v codex >/dev/null 2>&1 && [ -f "$HOME/.codex/auth.json" ] ||
      { warn "$name helper skipped: no codex binary or no Codex login (install the Codex CLI and run \`codex login\`)"; return 0; }
  fi
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
    crew) helper crew codex-login ;;
    codex-computer-use) helper codex-computer-use none ;;
  esac
done

cat <<'EOF'

done. Next:
  - start a new Claude Code session (the crew twins register only at session start), or run /reload-plugins
  - optional crew options: `claude plugin configure crew` (codexLogin, mode, jevKey)
  - tailscale needs its apiKey: `claude plugin configure tailscale`
EOF
