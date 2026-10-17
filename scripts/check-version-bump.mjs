// Fails when a plugin's shipped files changed against a base ref without a `version` bump in its plugin.json.
// Run: node scripts/check-version-bump.mjs <base-ref> [--worktree]   (CI passes origin/<base branch>)
// --worktree also counts uncommitted and untracked files and reads the head version from disk, for checks before a commit.
// NOT_SHIPPED is the one definition of which plugin files ship; docs and skills point here instead of restating it.
// `pluginsNeedingBump(files)` and `missingBumps(changed, versionAt)` are the pure core.
import { execFileSync } from 'node:child_process'
import { readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Inside a plugin everything ships (hooks, helper, skills, types, manifests, config) except tests and docs.
const NOT_SHIPPED = [
  /^(?:tests|helper\/test|docs)\//, // test suites and docs folders
  /^[^/]+\.md$/, // README.md, AGENTS.md, CHANGELOG.md at the plugin root; a skill's SKILL.md sits deeper and counts
  /\.test\.[cm]?[jt]sx?$/, // a test file beside its module
]

/** The plugins with at least one changed file that ships, sorted. `files` are repository-relative paths. */
export function pluginsNeedingBump(files) {
  const names = new Set()

  for (const file of files) {
    const match = /^plugins\/([^/]+)\/(.+)$/.exec(file)
    if (match && !NOT_SHIPPED.some(pattern => pattern.test(match[2]))) names.add(match[1])
  }

  return [...names].sort()
}

/**
 * One line per plugin whose shipped files changed but whose version did not.
 * `versionAt(side, name)` returns the plugin.json version on the `'base'` or `'head'` side, or undefined when the
 * manifest is not there: a new plugin has nothing to bump from, and a removed one never has the same version.
 */
export function missingBumps(changed, versionAt) {
  const errors = []

  for (const name of pluginsNeedingBump(changed)) {
    const before = versionAt('base', name)
    const after = versionAt('head', name)
    if (before !== undefined && before === after) errors.push(`${name}: shipped files changed but version is still ${after} (bump it in plugins/${name}/.claude-plugin/plugin.json)`)
  }

  return errors
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [base, mode] = process.argv.slice(2)
  const worktree = mode === '--worktree'

  if (!base || base.startsWith('-') || (mode !== undefined && !worktree)) {
    console.error('usage: node scripts/check-version-bump.mjs <base-ref> [--worktree]')
    process.exit(2)
  }

  // stderr is dropped: `git show` of a new plugin's manifest at the base says `fatal`, which is expected there.
  // Run from the top level: `ls-files` lists only below the current directory, and paths are read relative to the root.
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  // --no-renames lists both paths of a move, so a file leaving the shipped set (to docs/ or tests/) or the plugin counts.
  const lines = text => text.split('\n').filter(Boolean)
  // The working tree is compared with the merge base, as `base...HEAD` does for commits.
  const changed = worktree
    ? [...lines(git('diff', '--name-only', '--no-renames', git('merge-base', base, 'HEAD').trim())), ...lines(git('ls-files', '--others', '--exclude-standard'))]
    : lines(git('diff', '--name-only', '--no-renames', `${base}...HEAD`))
  const manifest = name => `plugins/${name}/.claude-plugin/plugin.json`
  const versionAt = (side, name) => {
    try {
      if (side === 'head' && worktree) return JSON.parse(readFileSync(join(root, manifest(name)), 'utf8')).version
      return JSON.parse(git('show', `${side === 'base' ? base : 'HEAD'}:${manifest(name)}`)).version
    } catch {
      return undefined
    }
  }
  const errors = missingBumps(changed, versionAt)

  if (errors.length) {
    console.error(errors.join('\n'))
    process.exit(1)
  }

  console.log('ok: every plugin with changed shipped files bumped its version')
}
