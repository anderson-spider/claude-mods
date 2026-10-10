// Refreshes the marketplace, then updates every plugin from it that is installed, in its own scope.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const MARKETPLACE = 'spider-claude-mods'
const claude = (args, options = {}) => execFileSync('claude', args, { encoding: 'utf8', ...options })

claude(['plugin', 'marketplace', 'update', MARKETPLACE], { stdio: 'inherit' })
const names = JSON.parse(readFileSync('.claude-plugin/marketplace.json', 'utf8')).plugins.map(p => p.name)
for (const p of JSON.parse(claude(['plugin', 'list', '--json']))) {
  if (!p.id.endsWith(`@${MARKETPLACE}`)) continue
  if (!names.includes(p.id.split('@')[0])) {
    console.error(`skip: ${p.id} is no longer in the marketplace; uninstall it`)
    continue
  }
  console.log(`==> ${p.id} (${p.scope})`)
  claude(['plugin', 'update', p.id, '--scope', p.scope], { stdio: ['ignore', 'inherit', 'inherit'] })
}
