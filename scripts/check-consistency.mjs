// Checks that the marketplace and the plugins agree. Run: node scripts/check-consistency.mjs
import { existsSync, readdirSync, readFileSync } from 'node:fs'

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

  // Each skill is skills/<name>/SKILL.md whose frontmatter names the directory and describes it.
  // Size ceilings in bytes; skills not listed here are not measured.
  const ceilings = {}
  const skills = `${dir}/skills`

  for (const name of existsSync(skills) ? readdirSync(skills) : []) {
    const file = `${skills}/${name}/SKILL.md`
    const text = existsSync(file) ? readFileSync(file, 'utf8') : ''
    const front = /^---\nname: (.+)\ndescription: (.+)\n---\n/.exec(text)

    if (front?.[1] !== name) errors.push(`${entry.name}: ${file} is missing or its frontmatter does not name "${name}"`)

    const max = ceilings[entry.name]?.[name]
    const n = Buffer.byteLength(text)

    if (max !== undefined && n > max) errors.push(`${entry.name}: ${file} is ${n} bytes; the ceiling is ${max}`)
  }
}

if (errors.length) {
  console.error(errors.join('\n'))
  process.exit(1)
}

console.log(`ok: ${marketplace.plugins.length} plugins`)
