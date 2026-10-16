// Creates a plugin that passes scripts/check-consistency.mjs, so the only edits left are the text to fill in.
// Run: npm run plugin:new -- <name> [description]   (or: node scripts/new-plugin.mjs <name> [description])
// `scaffoldPlugin(root, name, description)` is the pure core. It checks everything, then writes, so a refusal leaves no file.
// What it writes: plugins/<name>/ from scripts/plugin-template/, the marketplace entry, .claude/rules/<name>.md, the
// plugin's line in the root AGENTS.md "Where to look" list, the root README table row and install line, and the plugin
// list of scripts/bootstrap.sh when the repository has one.
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ruleLine } from './check-consistency.mjs'

const TEMPLATE_DIR = fileURLToPath(new URL('./plugin-template/', import.meta.url))
// Lowercase words joined by single hyphens, starting with a letter. The name is also the middle of `mcp__<name>__<tool>`.
const NAME_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
// The sample tool is `<name with underscores>_echo`, so `mcp__<name>__<tool>` is 5 + n + 2 + n + 5 = 2n + 12 characters: 26 keeps it within the 64 of a tool name.
const MAX_NAME = 26

const readText = path => readFileSync(path, 'utf8')

/** Why `name` cannot be a plugin name, or undefined when it can. */
export function invalidName(name) {
  if (typeof name !== 'string' || !name) return 'a plugin name is required'
  if (name.length > MAX_NAME) return `"${name}" is longer than ${MAX_NAME} characters, so its tool name mcp__${name}__${name.replaceAll('-', '_')}_echo would pass 64`
  if (!NAME_PATTERN.test(name)) return `"${name}" is not a valid plugin name (lowercase letters and digits in words joined by single hyphens, starting with a letter)`
  return undefined
}

// Files under a directory, as paths relative to it, sorted.
function filesUnder(dir, base = dir) {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap(entry => (entry.isDirectory() ? filesUnder(join(dir, entry.name), base) : [relative(base, join(dir, entry.name))]))
    .sort()
}

function render(text, values, file) {
  return text.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    if (!(key in values)) throw new Error(`plugin-template/${file}: unknown placeholder ${match}`)
    return values[key]
  })
}

// Inserts `line` among the consecutive-or-not lines `pattern` matches (capture 1 is the plugin name), keeping them sorted by name.
function insertSorted(text, pattern, name, line, where) {
  const lines = text.split('\n')
  const found = lines.flatMap((current, index) => {
    const match = pattern.exec(current)
    return match ? [{ index, name: match[1] }] : []
  })
  if (!found.length) throw new Error(`${where}: no existing plugin line to place the new one among`)
  const after = found.find(item => item.name > name)
  lines.splice(after ? after.index : found[found.length - 1].index + 1, 0, line)
  return lines.join('\n')
}

/**
 * Scaffolds plugin `name` in the repository at `root`. Throws an Error with the reason, before writing anything, for an
 * invalid or existing name or a root file the entries cannot be placed in. Returns the paths written and edited.
 */
export function scaffoldPlugin(root, name, description) {
  const reason = invalidName(name)
  if (reason) throw new Error(reason)
  const summary = (description ?? `Describe what ${name} does.`).trim()
  if (!summary || /[\r\n]/.test(summary)) throw new Error('the description must be one non-empty line')

  const pluginDir = join(root, 'plugins', name)
  const rulePath = join(root, '.claude/rules', `${name}.md`)
  const marketplacePath = join(root, '.claude-plugin/marketplace.json')
  const marketplace = JSON.parse(readText(marketplacePath))
  if (existsSync(pluginDir)) throw new Error(`plugins/${name} already exists`)
  if (marketplace.plugins.some(entry => entry.name === name)) throw new Error(`${name} is already in .claude-plugin/marketplace.json`)
  if (existsSync(rulePath)) throw new Error(`.claude/rules/${name}.md already exists`)

  const values = { name, id: name.replaceAll('-', '_'), description: summary }
  const created = {
    [join('plugins', name, '.claude-plugin/plugin.json')]: `${JSON.stringify({ name, version: '0.1.0', description: summary, author: { name: 'anderson-spider' }, license: 'MIT' }, null, 2)}\n`,
    [join('.claude/rules', `${name}.md`)]: `---\npaths:\n  - "plugins/${name}/**"\n---\n\n${ruleLine(name)}\n`,
  }
  for (const file of filesUnder(TEMPLATE_DIR)) {
    created[join('plugins', name, file.replace(/\.tmpl$/, ''))] = render(readText(join(TEMPLATE_DIR, file)), values, file)
  }

  marketplace.plugins.push({ name, source: `./plugins/${name}`, description: summary })
  marketplace.plugins.sort((a, b) => (a.name < b.name ? -1 : 1))
  const agentsPath = join(root, 'AGENTS.md')
  const readmePath = join(root, 'README.md')
  const market = marketplace.name
  const edited = {
    '.claude-plugin/marketplace.json': `${JSON.stringify(marketplace, null, 2)}\n`,
    'AGENTS.md': insertSorted(readText(agentsPath), /^- [^\n]*`plugins\/([a-z0-9-]+)\/AGENTS\.md`\.$/, name, `- ${name}: \`plugins/${name}/AGENTS.md\`.`, 'AGENTS.md "Where to look"'),
  }
  const withRow = insertSorted(readText(readmePath), /^\| \[([a-z0-9-]+)\]\(plugins\/[^)]*\) \|/, name, `| [${name}](plugins/${name}/README.md) | ${summary.replaceAll('|', '\\|')} |`, 'README.md plugin table')
  edited['README.md'] = insertSorted(withRow, new RegExp(`^/plugin install ([a-z0-9-]+)@${market.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`), name, `/plugin install ${name}@${market}`, 'README.md install block')

  const bootstrapPath = join(root, 'scripts/bootstrap.sh')
  if (existsSync(bootstrapPath)) {
    const text = readText(bootstrapPath)
    if (!/^ALL="[^"]*"$/m.test(text)) throw new Error('scripts/bootstrap.sh: no ALL="<plugins>" line')
    edited['scripts/bootstrap.sh'] = text.replace(/^ALL="[^"]*"$/m, `ALL="${marketplace.plugins.map(entry => entry.name).join(' ')}"`)
  }

  for (const [path, text] of Object.entries({ ...created, ...edited })) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  return { created: Object.keys(created).sort(), edited: Object.keys(edited).sort() }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [name, description, ...extra] = process.argv.slice(2)
  // NEW_PLUGIN_ROOT is read only here, by the CLI: the tests point it at a temporary repository. Unset, it is this checkout.
  const root = process.env.NEW_PLUGIN_ROOT || fileURLToPath(new URL('..', import.meta.url))
  try {
    if (extra.length) throw new Error('usage: node scripts/new-plugin.mjs <name> [description]')
    const { created, edited } = scaffoldPlugin(root, name, description)
    console.log(`created ${created.length} files for plugins/${name} and edited ${edited.join(', ')}`)
    console.log(`next: replace the sample tool; fill in the description (a placeholder when none was given), the README text, and the "Where to look" label in AGENTS.md (the scaffold uses the plugin name there); then make sure plugins/${name}/.claude-plugin/types exists (npm run plugins:types -- ${name})`)
  } catch (error) {
    console.error(`plugin:new: ${error.message}`)
    process.exit(1)
  }
}
