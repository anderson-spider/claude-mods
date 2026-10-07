// Fails when a plugin's code changed against a base ref without a `version` bump in its plugin.json.
// Run: node scripts/check-version-bump.mjs <base-ref>   (CI passes origin/<base branch>)
import { execFileSync } from 'node:child_process'

const base = process.argv[2]

if (!base) {
  console.error('usage: node scripts/check-version-bump.mjs <base-ref>')
  process.exit(2)
}

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' })
const changed = git('diff', '--name-only', `${base}...HEAD`).split('\n').filter(Boolean)

// Behavior lives in hooks/ and helper/; tests and docs do not change it.
const isCode = file => /^plugins\/[^/]+\/(hooks|helper)\//.test(file) && !/^plugins\/[^/]+\/helper\/test\//.test(file)
const versionOf = text => JSON.parse(text).version

const errors = []

for (const name of new Set(changed.filter(isCode).map(file => file.split('/')[1]))) {
  const manifest = `plugins/${name}/.claude-plugin/plugin.json`
  let before

  try {
    before = versionOf(git('show', `${base}:${manifest}`))
  } catch {
    continue // a new plugin has nothing to bump from
  }

  const after = versionOf(git('show', `HEAD:${manifest}`))

  if (before === after) errors.push(`${name}: code changed but version is still ${after} (bump it in ${manifest})`)
}

if (errors.length) {
  console.error(errors.join('\n'))
  process.exit(1)
}

console.log('ok: every plugin with code changes bumped its version')
