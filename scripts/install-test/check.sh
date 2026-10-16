#!/bin/sh
# Runs inside the install-test image as a new user would: bootstrap.sh adds the marketplace from /src and installs
# every plugin, then each one must be listed at its source version, pass its tests from the installed copy, and load in
# a session started without a login. A second bootstrap run must update cleanly.
set -eu

SRC=${SRC:-/src}
MARKET=spider-claude-mods
WAIT=${INSTALL_TEST_WAIT:-60}

say() { printf '==> %s\n' "$*"; }
fail() { printf 'install test failed: %s\n' "$*" >&2; exit 1; }

say "bootstrap (first run)"
BOOTSTRAP_SOURCE=$SRC sh "$SRC/scripts/bootstrap.sh"

# Linux leaves out codex-computer-use, which controls native Mac apps.
EXPECTED=$(node -p "require('$SRC/.claude-plugin/marketplace.json').plugins.map(p => p.name).filter(n => n !== 'codex-computer-use').join(' ')")
LISTED=$(claude plugin list --json)
field() { printf '%s' "$LISTED" | node -e "const r = JSON.parse(require('fs').readFileSync(0, 'utf8')).find(p => p.id === '$1@$MARKET'); console.log(r ? r['$2'] : '')"; }

for p in $EXPECTED; do
  say "installed $p"
  want=$(node -p "require('$SRC/plugins/$p/.claude-plugin/plugin.json').version")
  [ "$(field "$p" enabled)" = true ] || fail "$p is not installed and enabled"
  [ "$(field "$p" version)" = "$want" ] || fail "$p is at $(field "$p" version), the source is at $want"
  dir=$(field "$p" installPath)
  if [ -f "$dir/hooks/hooks.json" ]; then claude plugin test "$dir" >/dev/null || fail "$p: claude plugin test failed on the installed copy $dir"; fi
done

say "session without login"
mkdir -p "$HOME/work"
cd "$HOME/work"
node -e '
  const fs = require("fs"), file = require("os").homedir() + "/.claude.json";
  const config = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  Object.assign(config, { hasCompletedOnboarding: true, theme: "dark" });
  config.projects = { ...config.projects, [process.cwd()]: { hasTrustDialogAccepted: true } };
  fs.writeFileSync(file, JSON.stringify(config));
'
log="$HOME/session.log"
# Every plugin reports in the log once the session has started; then it is asked to exit.
loaded() { grep -q 'Loaded plugins - Enabled' "$log" 2>/dev/null && for p in $EXPECTED; do grep -q "plugin $p\|module $p@$MARKET" "$log" || return 1; done; }
{ for _ in $(seq "$WAIT"); do loaded && break; sleep 1; done; sleep 2; printf '/exit\r'; } |
  script -q -e -c "claude --debug-file $log" /dev/null >/dev/null 2>&1 || true
[ -f "$log" ] || fail "the session wrote no debug log"
grep -q 'Loaded plugins - Enabled: .*Errors: 0' "$log" || fail "plugin load errors: $(grep 'Loaded plugins - Enabled' "$log" || echo 'no summary line')"
for p in $EXPECTED; do
  if [ -f "$SRC/plugins/$p/hooks/hooks.json" ]; then
    grep -q "hooks module $p@$MARKET loaded" "$log" || fail "$p: its hooks module did not load (see 'hooks module' lines in the debug log)"
  else
    grep -q "Loaded [1-9][0-9]* skills from plugin $p " "$log" || fail "$p: no skills loaded"
  fi
  say "loaded $p"
done

cd "$HOME"
say "bootstrap (second run)"
BOOTSTRAP_SOURCE=$SRC sh "$SRC/scripts/bootstrap.sh" >/dev/null || fail "a second bootstrap run failed"

say "ok: $(printf '%s' "$EXPECTED" | wc -w | tr -d ' ') plugins installed and loaded"
