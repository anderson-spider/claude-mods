# Sourced by the task scripts: which `claude` and `tsc` a task runs.

# The node_modules/.bin that holds the pinned tools: this checkout's, else the main checkout's, since a fresh worktree
# has no node_modules until `npm ci` runs in it. Empty when neither has them.
pinned_bin() {
  local main
  main=$(git worktree list --porcelain 2>/dev/null | sed -n '1s/^worktree //p')
  for dir in "$PWD" ${main:+"$main"}; do
    if [ -x "$dir/node_modules/.bin/claude" ] && [ -x "$dir/node_modules/.bin/tsc" ]; then echo "$dir/node_modules/.bin"; return 0; fi
  done
  return 0
}

# Checks run with the CLI and TypeScript package.json pins, as CI does; without them the task stops rather than
# silently using another claude.
use_pinned_tools() {
  local bin
  bin=$(pinned_bin)
  [ -n "$bin" ] || { echo "the pinned tools are not installed: run npm ci" >&2; exit 1; }
  PATH="$bin:$PATH"
}

# Typings and installed plugins belong to the Claude Code you run sessions with, so these tasks use that claude, not
# the pinned one `npm run` puts first on PATH.
use_own_claude() {
  PATH=$(printf '%s' "$PATH" | tr ':' '\n' | grep -v '/node_modules/\.bin$' | paste -sd: -)
  command -v claude >/dev/null || { echo "claude is not on PATH outside node_modules: install Claude Code" >&2; exit 1; }
}
