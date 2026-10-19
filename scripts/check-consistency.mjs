// The executable checklist for adding, changing or removing a plugin. Run: node scripts/check-consistency.mjs
// It prints one line per problem and exits 1, or prints `ok: N plugins` (and `, M unlisted`). `checkRepo(root)` is the pure core.
// An unlisted plugin (`.claude-plugin/unlisted.json`) is checked like any other but kept out of the marketplace, the
// root README and bootstrap.sh, so it is not offered for install while it is validated.
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const TYPES_TSCONFIG = './.claude-plugin/types/tsconfig.json'
// The SchemaFor files: each plugin path with the template file it copies byte for byte (neither has a placeholder). A
// plugin with hooks/schema.ts carries both.
const TEMPLATE_DIR = fileURLToPath(new URL('./plugin-template/', import.meta.url))
const SHARED_FILES = [
  ['hooks/schema.ts', 'hooks/schema.ts.tmpl'],
  ['tests/schema-types.ts', 'tests/schema-types.ts.tmpl'],
]
// The most words a skills' shared block may hold.
export const SHARED_BLOCK_WORDS = 1600

const readText = path => readFileSync(path, 'utf8')
const readJson = path => JSON.parse(readText(path))
const CLI_PACKAGE = '@anthropic-ai/claude-code'
const listDir = (path, keep) => (existsSync(path) ? readdirSync(path, { withFileTypes: true }).filter(keep).map(entry => entry.name) : [])
const escapeRegex = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
// True when the folder holds nothing but `.claude-plugin/types/`, the typings a loaded plugin gets.
const onlyGeneratedTypes = dir => {
  try {
    const left = name => name !== '.DS_Store'
    const entries = readdirSync(dir).filter(left)
    return entries.length === 1 && entries[0] === '.claude-plugin' && readdirSync(join(dir, '.claude-plugin')).filter(left).every(name => name === 'types')
  } catch {
    return false // `.claude-plugin` is a file, or the folder cannot be read: the plain message stands
  }
}

function unescape(literal) {
  const simple = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', 0: '\0' }
  return literal.replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|\r?\n|[\s\S])/g, (_, code) => {
    if (code[0] === 'u' && code.length > 1) return String.fromCodePoint(parseInt(code.replace(/[u{}]/g, ''), 16))
    if (code[0] === 'x' && code.length === 3) return String.fromCharCode(parseInt(code.slice(1), 16))
    if (code.includes('\n')) return ''
    return simple[code] ?? code
  })
}

/** The names a test file declares, with string escapes resolved: test('can\'t', ...) declares "can't". */
export function declaredTests(source) {
  const names = new Set()
  const declaration = /\b(?:test|it|describe)(?:\.[A-Za-z]+)*\(\s*(?:'((?:\\[\s\S]|[^'\\])*)'|"((?:\\[\s\S]|[^"\\])*)"|`((?:\\[\s\S]|[^`\\])*)`)/g
  for (const match of source.matchAll(declaration)) names.add(unescape(match[1] ?? match[2] ?? match[3]))
  return names
}

/**
 * The test names an AGENTS.md cites. Only backticked spans count, and only in two positions after a test file
 * reference (`tests/<file>.test.ts`, `helper/test/<file>.test.mjs`, or `tests/{a,b}.test.ts`, whose files are then
 * alternatives):
 *   - a parenthesised list right after the reference: (`name`, `name` and `name`)
 *   - a single span after a colon: `tests/<file>.test.ts`: `name`
 * Every other backticked span is code, not a citation. A name belongs to the nearest reference before it.
 * A span naming a support file under `tests/` or `helper/test/` (`tests/host.ts`, `helper/test/contract.mjs`) is
 * also referenced, so it must exist, but it is never an anchor and ends a list of names.
 */
export function citedTests(markdown) {
  const spans = [...markdown.matchAll(/`([^`\n]*)`/g)].map(m => ({ text: m[1], start: m.index, end: m.index + m[0].length }))
  const gapAfter = i => markdown.slice(spans[i].end, spans[i + 1]?.start ?? markdown.length)
  const fileRef = text => {
    const single = /^((?:tests|helper\/test)\/)([\w.-]+\.test\.(?:ts|tsx|mjs))$/.exec(text)
    if (single) return [`${single[1]}${single[2]}`]
    const group = /^((?:tests|helper\/test)\/)\{([\w.,-]+)\}(\.test\.(?:ts|tsx|mjs))$/.exec(text)
    return group ? group[2].split(',').map(name => `${group[1]}${name}${group[3]}`) : undefined
  }
  // A helper beside the tests: no `.test.` in the name, and no `..` to climb out of the plugin.
  const supportRef = text => (/^(?:tests|helper\/test)\/(?!.*\.\.)[\w./-]+\.(?:ts|tsx|mjs|mts)$/.test(text) ? text : undefined)
  const isFileRef = text => fileRef(text) ?? supportRef(text)
  const referenced = new Set()
  const cites = []

  spans.forEach((span, i) => {
    const files = fileRef(span.text)
    if (!files) {
      const support = supportRef(span.text)
      if (support) referenced.add(support)
      return
    }
    files.forEach(file => referenced.add(file))
    if (/^:\s*$/.test(gapAfter(i)) && i + 1 < spans.length && !isFileRef(spans[i + 1].text)) {
      cites.push({ files, name: spans[i + 1].text })
    } else if (/^\s*\(\s*$/.test(gapAfter(i))) {
      for (let j = i + 1; j < spans.length && !isFileRef(spans[j].text); j++) {
        cites.push({ files, name: spans[j].text })
        if (!/^(?:,|,?\s+and|;)?\s*$/.test(gapAfter(j))) break
      }
    }
  })
  return { cites, referenced }
}

// package.json pins the Claude Code CLI that `npm ci` installs for the tasks and the required CI check; the README says
// which version the repository is checked with. Skipped only when neither states a version.
function checkCliPin(root, errors) {
  const manifest = join(root, 'package.json')
  const pin = existsSync(manifest) ? readJson(manifest).devDependencies?.[CLI_PACKAGE] : undefined
  const readme = join(root, 'README.md')
  const checked = existsSync(readme) ? /checked with v(\d+(?:\.\d+)*)/.exec(readText(readme))?.[1] : undefined
  if (!pin && !checked) return
  if (!pin) errors.push(`package.json: no devDependencies "${CLI_PACKAGE}" version`)
  else if (!/^\d+\.\d+\.\d+$/.test(pin)) errors.push(`package.json: "${CLI_PACKAGE}" is ${pin}; pin an exact version`)
  else if (pin !== checked) errors.push(`package.json: "${CLI_PACKAGE}" is ${pin}, but README.md says the repository is checked with ${checked ? `v${checked}` : 'no version ("checked with vX.Y.Z")'}`)
}

// scripts/bootstrap.sh runs from a bare download, so it lists the plugins itself; the list must match the marketplace.
function checkBootstrap(root, names, errors) {
  const script = join(root, 'scripts/bootstrap.sh')
  if (!existsSync(script)) return
  const all = /^ALL="([^"]*)"$/m.exec(readText(script))?.[1]
  if (all === undefined) return errors.push('scripts/bootstrap.sh: no ALL="<plugins>" line')
  const listed = all.split(/\s+/).filter(Boolean).sort().join(' ')
  const expected = [...names].sort().join(' ')
  if (listed !== expected) errors.push(`scripts/bootstrap.sh: ALL lists "${listed}", but marketplace.json has "${expected}"`)
}

// The chatgpt README names the default model by hand, while the tool schema builds the same text from DEFAULT_CHOICE
// (hooks/tool-schemas.ts): "<model> at <Effort> effort", the effort capitalized as the menu labels it.
function checkChatgptDefault(root, errors) {
  const source = join(root, 'plugins/chatgpt/hooks/conversation.ts')
  if (!existsSync(source)) return
  const choice = /DEFAULT_CHOICE = \{ model: '([^']+)', effort: '([^']+)' \}/.exec(readText(source))
  if (!choice) return errors.push("plugins/chatgpt/hooks/conversation.ts: no DEFAULT_CHOICE = { model: '…', effort: '…' } literal to check the README against")
  const [, model, effort] = choice
  const text = `${model} at ${effort[0].toUpperCase()}${effort.slice(1)} effort`
  const readme = join(root, 'plugins/chatgpt/README.md')
  if (!(existsSync(readme) && readText(readme).includes(text))) {
    errors.push(`plugins/chatgpt/README.md: does not say "${text}", the default that DEFAULT_CHOICE in hooks/conversation.ts picks`)
  }
}

// AGENTS.md pins behavior by test name; a renamed or removed test must fail here, not drift.
function checkCitedTests(dir, fail) {
  const agents = join(dir, 'AGENTS.md')
  if (!existsSync(agents)) return
  const { cites, referenced } = citedTests(readText(agents))
  const declared = new Map()
  const testsIn = file => {
    if (!declared.has(file)) declared.set(file, existsSync(join(dir, file)) ? declaredTests(readText(join(dir, file))) : undefined)
    return declared.get(file)
  }

  for (const file of referenced) if (!testsIn(file)) fail(`AGENTS.md cites ${file}, which does not exist`)
  for (const { files, name } of cites) {
    if (files.some(file => testsIn(file)) && !files.some(file => testsIn(file)?.has(name))) {
      fail(`AGENTS.md cites test "${name}", which ${files.join(' or ')} does not declare`)
    }
  }
}

function checkPlugin(root, entry, marketplace, rootDocs, errors, listed = true) {
  const name = entry.name
  const dir = join(root, entry.source)
  const fail = message => errors.push(`${name}: ${message}`)
  const manifest = `${entry.source}/.claude-plugin/plugin.json`

  if (entry.source !== `./plugins/${name}`) fail(`marketplace source is "${entry.source}", expected "./plugins/${name}"`)
  if (!existsSync(dir)) return fail(`${entry.source} is missing`)
  if (!existsSync(join(root, manifest))) return fail(`${manifest} is missing`)

  const plugin = readJson(join(root, manifest))
  if (plugin.name !== name) fail(`plugin.json name is "${plugin.name}"`)
  if (!/^\d+\.\d+\.\d+$/.test(plugin.version ?? '')) fail(`invalid version "${plugin.version}"`)
  if (typeof plugin.description !== 'string' || !plugin.description.trim()) fail('plugin.json has no description')
  else if (listed && plugin.description !== entry.description) fail('marketplace.json description differs from plugin.json (copy the plugin.json text)')
  // A plugin with neither hooks/ nor tsconfig.json ships skills only: it needs a skill, and no hooks module or typings.
  const skillsOnly = !existsSync(join(dir, 'hooks')) && !existsSync(join(dir, 'tsconfig.json'))
  if (skillsOnly) {
    if (!listDir(join(dir, 'skills'), e => e.isDirectory()).length) fail('has no hooks/hooks.json and no skill under skills/')
  } else if (!existsSync(join(dir, 'hooks/hooks.json'))) fail('hooks/hooks.json is missing')
  else {
    try {
      readJson(join(dir, 'hooks/hooks.json'))
    } catch {
      fail('hooks/hooks.json is not valid JSON')
    }
  }

  // The plugin's TypeScript checks against the typings Claude Code generates when it loads the plugin.
  if (!skillsOnly && !existsSync(join(dir, 'tsconfig.json'))) fail('tsconfig.json is missing')
  else if (!skillsOnly) {
    try {
      const config = readJson(join(dir, 'tsconfig.json'))
      if (config.extends !== TYPES_TSCONFIG) fail(`tsconfig.json must extend "${TYPES_TSCONFIG}"`)
      // Without the generated typings `tsc` would write a .js beside every .ts; the plugin's own setting forbids it.
      if (config.compilerOptions?.noEmit !== true) fail('tsconfig.json must set "compilerOptions": { "noEmit": true }')
    } catch {
      fail('tsconfig.json is not valid JSON')
    }
  }

  for (const doc of ['AGENTS.md', 'README.md']) if (!existsSync(join(dir, doc))) fail(`${doc} is missing`)
  if (existsSync(join(dir, 'CLAUDE.md'))) fail('CLAUDE.md in the plugin root draws a validation warning; keep guidance in AGENTS.md')

  if (!rootDocs.agents.includes(`\`plugins/${name}/AGENTS.md\``)) fail(`root AGENTS.md does not cite \`plugins/${name}/AGENTS.md\``)
  const row = new RegExp(`^\\| \\[${escapeRegex(name)}\\]\\(plugins/${escapeRegex(name)}(?:/README\\.md)?\\) \\|`, 'm')
  const install = rootDocs.readme.includes(`/plugin install ${name}@${marketplace.name}`)
  if (listed) {
    if (!row.test(rootDocs.readme)) fail(`root README.md has no table row whose first cell links plugins/${name}`)
    if (!install) fail(`root README.md has no "/plugin install ${name}@${marketplace.name}" line`)
  } else {
    if (row.test(rootDocs.readme)) fail('is unlisted, but the root README.md table still has its row')
    if (install) fail(`is unlisted, but the root README.md still has "/plugin install ${name}@${marketplace.name}"`)
  }

  // Each skill is skills/<name>/SKILL.md whose frontmatter names the directory and describes it. Skills of one plugin
  // may share a block between `<!-- shared: <block> -->` and `<!-- /shared: <block> -->`; every copy must match the first,
  // and the block stays within SHARED_BLOCK_WORDS, since every skill that copies it loads it on each call.
  const shared = new Map()
  for (const skill of listDir(join(dir, 'skills'), () => true).sort()) {
    const file = `${entry.source}/skills/${skill}/SKILL.md`
    const text = existsSync(join(root, file)) ? readText(join(root, file)) : ''
    // Further fields (`disable-model-invocation`) may follow the description.
    const front = /^---\nname: (.+)\ndescription: (.+)\n(?:[\w-]+: .+\n)*---\n/.exec(text)
    if (front?.[1] !== skill) fail(`${file} is missing or its frontmatter does not name "${skill}"`)
    for (const [, block] of text.matchAll(/<!-- shared: ([\w-]+) -->/g)) {
      const body = new RegExp(`<!-- shared: ${block} -->\\n([\\s\\S]*?)<!-- /shared: ${block} -->`).exec(text)
      if (!body) { fail(`skills/${skill}/SKILL.md opens shared block "${block}" without <!-- /shared: ${block} -->`); continue }
      const first = shared.get(block)
      const words = body[1].split(/\s+/).filter(Boolean).length
      if (!first && words > SHARED_BLOCK_WORDS) fail(`skills/${skill}/SKILL.md shared block "${block}" has ${words} words, over ${SHARED_BLOCK_WORDS}: move what not every run needs to a file the skill links`)
      if (!first) shared.set(block, { skill, text: body[1] })
      else if (first.text !== body[1]) fail(`skills/${skill}/SKILL.md shared block "${block}" differs from skills/${first.skill}/SKILL.md (copy it)`)
    }
  }

  // One SchemaFor everywhere: a plugin's copy may not drift from the template the scaffold writes.
  if (existsSync(join(dir, 'hooks/schema.ts'))) {
    for (const [file, template] of SHARED_FILES) {
      const source = `scripts/plugin-template/${template}`
      if (!existsSync(join(dir, file))) fail(`${file} is missing (copy ${source})`)
      else if (readText(join(dir, file)) !== readText(join(TEMPLATE_DIR, template))) fail(`${file} differs from ${source} (copy the template)`)
    }
  }

  checkCitedTests(dir, fail)
}

// The plugins kept out of the marketplace while they are validated: a JSON array of names, the file optional.
function readUnlisted(root, errors) {
  const file = join(root, '.claude-plugin/unlisted.json')
  if (!existsSync(file)) return []
  let names
  try {
    names = readJson(file)
  } catch {
    errors.push('.claude-plugin/unlisted.json is not valid JSON')
    return []
  }
  if (!Array.isArray(names) || !names.every(name => typeof name === 'string' && /^[a-z][a-z0-9-]*$/.test(name))) {
    errors.push('.claude-plugin/unlisted.json must be an array of plugin names')
    return []
  }
  return [...new Set(names)]
}

/** Every problem found in the repository at `root`, one line each, plus the number of marketplace and unlisted plugins. */
export function checkRepo(root = '.') {
  const errors = []
  const marketplace = readJson(join(root, '.claude-plugin/marketplace.json'))
  const rootDocs = {
    agents: existsSync(join(root, 'AGENTS.md')) ? readText(join(root, 'AGENTS.md')) : '',
    readme: existsSync(join(root, 'README.md')) ? readText(join(root, 'README.md')) : '',
  }
  const listed = new Set(marketplace.plugins.map(entry => entry.name))
  const unlisted = readUnlisted(root, errors)
  const known = new Set([...listed, ...unlisted])

  for (const entry of marketplace.plugins) checkPlugin(root, entry, marketplace, rootDocs, errors)
  for (const name of unlisted) {
    if (listed.has(name)) errors.push(`.claude-plugin/unlisted.json: ${name} is also in marketplace.json; keep it in one of them`)
    else checkPlugin(root, { name, source: `./plugins/${name}` }, marketplace, rootDocs, errors, false)
  }

  // The reverse direction: every plugin directory the tasks would validate must be listed.
  for (const dir of listDir(join(root, 'plugins'), e => e.isDirectory())) {
    if (known.has(dir)) continue
    // Claude Code writes the git-ignored typings into a plugin that is loaded, and they outlive its removal.
    const leftover = onlyGeneratedTypes(join(root, 'plugins', dir))
    errors.push(`plugins/${dir}: no marketplace.json entry${leftover ? ' (only the generated .claude-plugin/types/ is left; delete the directory)' : ''}`)
  }

  checkCliPin(root, errors)
  checkBootstrap(root, listed, errors)
  checkChatgptDefault(root, errors)
  return { errors, count: marketplace.plugins.length, unlisted: unlisted.length }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { errors, count, unlisted } = checkRepo('.')
  if (errors.length) {
    console.error(errors.join('\n'))
    process.exit(1)
  }
  console.log(`ok: ${count} plugins${unlisted ? `, ${unlisted} unlisted` : ''}`)
}
