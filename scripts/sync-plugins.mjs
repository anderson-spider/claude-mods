// Refreshes the marketplace, then brings every plugin of it that is installed in line with it, in its own scope: a
// plugin it still lists is updated, one it no longer lists is uninstalled. Plugins it lists that are not installed are
// left out. The list comes from the refreshed marketplace, never from this checkout, which may be behind it.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const MARKETPLACE = 'spider-claude-mods'
const claude = (args, options = {}) => execFileSync('claude', args, { encoding: 'utf8', ...options })

claude(['plugin', 'marketplace', 'update', MARKETPLACE], { stdio: 'inherit' })
const market = JSON.parse(claude(['plugin', 'marketplace', 'list', '--json'])).find(m => m.name === MARKETPLACE)
if (!market?.installLocation) {
  console.error(`error: ${MARKETPLACE} has no local copy; add it with \`claude plugin marketplace add anderson-spider/claude-mods\``)
  process.exit(1)
}
const names = JSON.parse(readFileSync(join(market.installLocation, '.claude-plugin/marketplace.json'), 'utf8')).plugins.map(p => p.name)
for (const p of JSON.parse(claude(['plugin', 'list', '--json']))) {
  if (!p.id.endsWith(`@${MARKETPLACE}`)) continue
  // A project or local install is changed from its own project.
  const options = { stdio: ['ignore', 'inherit', 'inherit'], ...(p.projectPath && { cwd: p.projectPath }) }
  if (names.includes(p.id.split('@')[0])) {
    console.log(`==> ${p.id} (${p.scope})`)
    claude(['plugin', 'update', p.id, '--scope', p.scope], options)
  } else {
    console.log(`==> ${p.id} (${p.scope}): no longer in the marketplace, uninstalling`)
    claude(['plugin', 'uninstall', p.id, '--scope', p.scope], options)
  }
}
