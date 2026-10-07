// Checks that the marketplace and the plugins agree. Run: node scripts/check-consistency.mjs
import { existsSync, readFileSync } from 'node:fs'

const read = path => JSON.parse(readFileSync(path, 'utf8'))
const errors = []
const marketplace = read('.claude-plugin/marketplace.json')

for (const entry of marketplace.plugins) {
  const dir = entry.source
  const manifest = `${dir}/.claude-plugin/plugin.json`

  if (!existsSync(manifest)) {
    errors.push(`${entry.name}: ${manifest} is missing`)
    continue
  }

  const plugin = read(manifest)

  if (plugin.name !== entry.name) errors.push(`${entry.name}: plugin.json name is "${plugin.name}"`)
  if (!/^\d+\.\d+\.\d+$/.test(plugin.version ?? '')) errors.push(`${entry.name}: invalid version "${plugin.version}"`)
  if (!existsSync(`${dir}/hooks/hooks.json`)) errors.push(`${entry.name}: hooks/hooks.json is missing`)
  else read(`${dir}/hooks/hooks.json`)
}

if (errors.length) {
  console.error(errors.join('\n'))
  process.exit(1)
}

console.log(`ok: ${marketplace.plugins.length} plugins`)
