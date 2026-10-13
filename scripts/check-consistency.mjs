// The executable checklist for adding, changing or removing a plugin. Run: node scripts/check-consistency.mjs
// It prints one line per problem and exits 1, or prints `ok: N plugins`. `checkRepo(root)` is the pure core.
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const TYPES_TSCONFIG = './.claude-plugin/types/tsconfig.json'
const HOOK_COMMAND = file => `node "$CLAUDE_PROJECT_DIR/.claude/hooks/${file}"`
// A project hook script declares its event and matcher on its first line: `// PreToolUse (Edit|Write): why`.
const HOOK_HEADER = /^\/\/ (\w+)(?: \(([^)]*)\))?:/

const readText = path => readFileSync(path, 'utf8')
const readJson = path => JSON.parse(readText(path))
const listDir = (path, keep) => (existsSync(path) ? readdirSync(path, { withFileTypes: true }).filter(keep).map(entry => entry.name) : [])
const escapeRegex = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const sameSet = (a, b) => a.length === b.length && a.every(item => b.includes(item))
const alternatives = matcher => (matcher ?? '').split('|').filter(item => item && item !== '*').sort()

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
 * reference (`tests/<file>.test.ts`, or `tests/{a,b}.test.ts`, whose files are then alternatives):
 *   - a parenthesised list right after the reference: (`name`, `name` and `name`)
 *   - a single span after a colon: `tests/<file>.test.ts`: `name`
 * Every other backticked span is code, not a citation. A name belongs to the nearest reference before it.
 */
export function citedTests(markdown) {
  const spans = [...markdown.matchAll(/`([^`\n]*)`/g)].map(m => ({ text: m[1], start: m.index, end: m.index + m[0].length }))
  const gapAfter = i => markdown.slice(spans[i].end, spans[i + 1]?.start ?? markdown.length)
  const fileRef = text => {
    const single = /^tests\/([\w.-]+\.test\.(?:ts|tsx|mjs))$/.exec(text)
    if (single) return [`tests/${single[1]}`]
    const group = /^tests\/\{([\w.,-]+)\}(\.test\.(?:ts|tsx|mjs))$/.exec(text)
    return group ? group[1].split(',').map(name => `tests/${name}${group[2]}`) : undefined
  }
  const referenced = new Set()
  const cites = []

  spans.forEach((span, i) => {
    const files = fileRef(span.text)
    if (!files) return
    files.forEach(file => referenced.add(file))
    if (/^:\s*$/.test(gapAfter(i)) && i + 1 < spans.length && !fileRef(spans[i + 1].text)) {
      cites.push({ files, name: spans[i + 1].text })
    } else if (/^\s*\(\s*$/.test(gapAfter(i))) {
      for (let j = i + 1; j < spans.length && !fileRef(spans[j].text); j++) {
        cites.push({ files, name: spans[j].text })
        if (!/^(?:,|,?\s+and|;)?\s*$/.test(gapAfter(j))) break
      }
    }
  })
  return { cites, referenced }
}

// Each project hook script is wired under the event and matcher its header declares, with its exact command.
function checkHooks(root, errors) {
  const settingsPath = join(root, '.claude/settings.json')
  const settings = existsSync(settingsPath) ? readJson(settingsPath) : {}
  if (settings.disableAllHooks) errors.push('.claude/settings.json: disableAllHooks turns every project hook off')

  for (const file of listDir(join(root, '.claude/hooks'), e => e.isFile() && e.name.endsWith('.mjs') && !e.name.endsWith('.test.mjs'))) {
    const header = HOOK_HEADER.exec(readText(join(root, '.claude/hooks', file)).split('\n', 1)[0])
    if (!header) {
      errors.push(`.claude/hooks/${file}: first line must declare its event and matcher, like "// PreToolUse (Edit|Write): why"`)
      continue
    }
    const [, event, matcher] = header
    const wired = (settings.hooks?.[event] ?? []).some(
      group =>
        sameSet(alternatives(group.matcher), alternatives(matcher)) &&
        (group.hooks ?? []).some(hook => hook.type === 'command' && hook.command === HOOK_COMMAND(file))
    )
    if (!wired) errors.push(`.claude/hooks/${file}: not wired under ${event}${matcher ? ` (${matcher})` : ''} in .claude/settings.json as ${HOOK_COMMAND(file)}`)
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

function checkPlugin(root, entry, marketplace, rootDocs, errors) {
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
  if (plugin.description !== entry.description) fail('marketplace.json description differs from plugin.json (copy the plugin.json text)')
  if (!existsSync(join(dir, 'hooks/hooks.json'))) fail('hooks/hooks.json is missing')
  else readJson(join(dir, 'hooks/hooks.json'))

  // The plugin's TypeScript checks against the typings Claude Code generates when it loads the plugin.
  if (!existsSync(join(dir, 'tsconfig.json'))) fail('tsconfig.json is missing')
  else {
    try {
      if (readJson(join(dir, 'tsconfig.json')).extends !== TYPES_TSCONFIG) fail(`tsconfig.json must extend "${TYPES_TSCONFIG}"`)
    } catch {
      fail('tsconfig.json is not valid JSON')
    }
  }

  for (const doc of ['AGENTS.md', 'README.md']) if (!existsSync(join(dir, doc))) fail(`${doc} is missing`)
  if (existsSync(join(dir, 'CLAUDE.md'))) fail('CLAUDE.md in the plugin root draws a validation warning; keep guidance in AGENTS.md')

  const rule = join(root, `.claude/rules/${name}.md`)
  if (!existsSync(rule)) fail(`.claude/rules/${name}.md is missing`)
  else if (!readText(rule).split('\n').includes(`@../../plugins/${name}/AGENTS.md`)) fail(`.claude/rules/${name}.md does not import @../../plugins/${name}/AGENTS.md`)

  if (!rootDocs.agents.includes(`\`plugins/${name}/AGENTS.md\``)) fail(`root AGENTS.md does not cite \`plugins/${name}/AGENTS.md\``)
  const row = new RegExp(`^\\| \\[${escapeRegex(name)}\\]\\(plugins/${escapeRegex(name)}(?:/README\\.md)?\\) \\|`, 'm')
  if (!row.test(rootDocs.readme)) fail(`root README.md has no table row whose first cell links plugins/${name}`)
  if (!rootDocs.readme.includes(`/plugin install ${name}@${marketplace.name}`)) fail(`root README.md has no "/plugin install ${name}@${marketplace.name}" line`)

  // Each skill is skills/<name>/SKILL.md whose frontmatter names the directory and describes it.
  for (const skill of listDir(join(dir, 'skills'), () => true)) {
    const file = `${entry.source}/skills/${skill}/SKILL.md`
    const text = existsSync(join(root, file)) ? readText(join(root, file)) : ''
    const front = /^---\nname: (.+)\ndescription: (.+)\n---\n/.exec(text)
    if (front?.[1] !== skill) fail(`${file} is missing or its frontmatter does not name "${skill}"`)
  }

  checkCitedTests(dir, fail)
}

/** Every problem found in the repository at `root`, one line each, plus the number of marketplace plugins. */
export function checkRepo(root = '.') {
  const errors = []
  const marketplace = readJson(join(root, '.claude-plugin/marketplace.json'))
  const rootDocs = {
    agents: existsSync(join(root, 'AGENTS.md')) ? readText(join(root, 'AGENTS.md')) : '',
    readme: existsSync(join(root, 'README.md')) ? readText(join(root, 'README.md')) : '',
  }
  const listed = new Set(marketplace.plugins.map(entry => entry.name))

  for (const entry of marketplace.plugins) checkPlugin(root, entry, marketplace, rootDocs, errors)

  // The reverse direction: whatever the globs in mise would validate must be listed, and a rule needs its plugin.
  for (const dir of listDir(join(root, 'plugins'), e => e.isDirectory())) {
    if (!listed.has(dir)) errors.push(`plugins/${dir}: no marketplace.json entry`)
  }
  for (const file of listDir(join(root, '.claude/rules'), e => e.isFile() && e.name.endsWith('.md'))) {
    const rule = file.slice(0, -3)
    if (!listed.has(rule)) errors.push(`.claude/rules/${file}: no marketplace.json entry for plugin "${rule}"`)
  }

  checkHooks(root, errors)
  return { errors, count: marketplace.plugins.length }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { errors, count } = checkRepo('.')
  if (errors.length) {
    console.error(errors.join('\n'))
    process.exit(1)
  }
  console.log(`ok: ${count} plugins`)
}
