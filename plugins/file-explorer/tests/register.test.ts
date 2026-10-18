import { expect, test } from 'claude-code/testing'
import { ROOT, cursor, key, pane, rows, segmentsOf, start, world } from './host'

const FILES = ['src/', 'src/app.ts', 'src/lib/', 'src/lib/util.ts', 'README.md', '.env', 'node_modules/', 'node_modules/x.js', 'docs/', 'docs/guide.md']
const TOP = ['  ▸ docs/', '  ▸ node_modules/', '  ▸ src/', '  ≡ README.md']

test('session start lists the root alone, opens the pane and draws folders first, dotfiles hidden, ignored folders dimmed', async ($, on) => {
  const w = world(on, FILES)
  await start($)
  const ui = await $.ui.mount(pane())

  expect(w.opened).toEqual(['file-explorer'])
  expect(await rows(ui)).toEqual(TOP)
  expect(await cursor(ui)).toBe('  ▸ docs/')
  expect((await segmentsOf(ui, 'node_modules'))?.find(one => one.t === 'node_modules/')?.d).toBe(true)
  // Nothing below the root is listed or indexed before it is asked for.
  expect(w.runs.some(argv => argv[1] === 'ls-files')).toBe(false)
  await ui.unmount()
})

test('keys move the cursor, open and close folders, preview a file and come back', async ($, on) => {
  world(on, FILES)
  await start($)
  const ui = await $.ui.mount(pane())

  await key(ui, 'j')
  await key(ui, 'j')
  expect(await cursor(ui)).toBe('  ▸ src/')
  await key(ui, 'l')
  expect(await rows(ui)).toEqual(['  ▸ docs/', '  ▸ node_modules/', '  ▾ src/', '    ▸ lib/', '    ◇ app.ts', '  ≡ README.md'])
  await key(ui, 'down')
  await key(ui, 'right')
  await key(ui, 'j')
  expect(await cursor(ui)).toBe('      ◇ util.ts')
  await key(ui, 'h')
  expect(await cursor(ui)).toBe('    ▾ lib/')
  await key(ui, 'h')
  expect(await cursor(ui)).toBe('    ▸ lib/')

  await key(ui, 'G')
  await key(ui, 'return')
  expect(await ui.find({ type: 'Markdown' })).toMatchObject({ props: { text: 'text of README.md\n' } })
  await ui.press({ key: 'back' })
  expect(await cursor(ui)).toBe('  ≡ README.md')
  await ui.unmount()
})

test('a click selects a row and opens a folder; a double click on a file previews it', async ($, on) => {
  const w = world(on, FILES)
  await start($)
  const ui = await $.ui.mount(pane())

  await ui.pointer({ in: 'rows', type: 'down', x: 3, y: 2, button: 'left' })
  expect((await rows(ui))[3]).toBe('    ▸ lib/')
  await ui.pointer({ in: 'rows', type: 'down', x: 3, y: 4, button: 'left' })
  expect(await cursor(ui)).toBe('    ◇ app.ts')
  await w.clock.advance(100)
  await ui.pointer({ in: 'rows', type: 'down', x: 3, y: 4, button: 'left' })
  expect(await ui.find({ type: 'Code' })).toMatchObject({ props: { path: `${ROOT}/src/app.ts` } })
  await ui.unmount()
})

test("Claude's read is marked and followed into collapsed folders; the tool's result goes on unchanged", async ($, on) => {
  world(on, FILES)
  const answer = { result: { type: 'text' }, text: 'contents' }
  on('tool.call', () => answer as never)
  await start($)
  const ui = await $.ui.mount(pane())

  const result = await $.tool.call({ tool: 'Read', file_path: `${ROOT}/src/lib/util.ts` } as never)
  expect(result).toMatchObject(answer)
  expect(await cursor(ui)).toBe('●     ◇ util.ts')
  expect(await rows(ui)).toContain('    ▾ lib/')
  expect((await segmentsOf(ui, 'util.ts'))?.find(one => one.t === 'util.ts')?.b).toBe(true)
  await ui.unmount()
})

test('a write that creates, an edit, and a refused or failed call: only the finished ones are marked', async ($, on) => {
  const w = world(on, FILES)
  on('tool.call', (_$, e) => {
    if (e.tool === 'Write') {
      w.add('src/new.ts')
      return { result: { type: 'create', filePath: `${ROOT}/src/new.ts` } } as never
    }
    if ((e as { file_path?: string }).file_path?.endsWith('app.ts')) return { deny: 'no' } as never
    return { result: {}, isError: true } as never
  })
  await start($)
  const ui = await $.ui.mount(pane(40, 30))

  await $.tool.call({ tool: 'Write', file_path: `${ROOT}/src/new.ts`, content: 'x' } as never)
  await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/src/app.ts`, old_string: 'a', new_string: 'b' } as never)
  await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/README.md`, old_string: 'a', new_string: 'b' } as never)
  const shown = await rows(ui)
  expect(shown).toContain('●   ◇ new.ts')
  expect(shown).toContain('    ◇ app.ts')
  expect(shown).toContain('  ≡ README.md')
  await ui.unmount()
})

test('with animations off a touched name never flashes, and the mark stays', { options: { animations: false } }, async ($, on) => {
  world(on, FILES)
  on('tool.call', () => ({ result: {} }) as never)
  await start($)
  const ui = await $.ui.mount(pane())
  await $.tool.call({ tool: 'Read', file_path: `${ROOT}/README.md` } as never)
  expect((await segmentsOf(ui, 'README.md'))?.find(one => one.t === 'README.md')?.b).toBeUndefined()
  expect(await cursor(ui)).toBe('● ≡ README.md')
  await ui.unmount()
})

test('a flash ends on its own timer, with no tree or git read again', async ($, on) => {
  const w = world(on, FILES)
  on('tool.call', () => ({ result: {} }) as never)
  await start($)
  await w.clock.advance(400)
  const ui = await $.ui.mount(pane())
  await $.tool.call({ tool: 'Read', file_path: `${ROOT}/README.md` } as never)
  const runs = w.runs.length
  await w.clock.advance(2000)
  expect((await segmentsOf(ui, 'README.md'))?.find(one => one.t === 'README.md')?.b).toBeUndefined()
  expect(await cursor(ui)).toBe('● ≡ README.md')
  expect(w.runs.length).toBe(runs)
  await ui.unmount()
})

test('Grep and Glob mark the files they found without moving the tree', async ($, on) => {
  world(on, FILES)
  on('tool.call', () => ({ result: { filenames: ['src/app.ts', 'README.md'] } }) as never)
  await start($)
  const ui = await $.ui.mount(pane())
  await $.tool.call({ tool: 'Grep', pattern: 'x' } as never)
  expect(await rows(ui)).toEqual(['  ▸ docs/', '  ▸ node_modules/', '• ▸ src/', '● ≡ README.md'])
  expect(await cursor(ui)).toBe('  ▸ docs/')
  await ui.unmount()
})

test('a shell rm drops the file from its folder and the cursor stays in place; a git commit marks the committed files', async ($, on) => {
  const w = world(on, FILES, { git: { top: ROOT, status: '## main\0', show: 'README.md\0docs/guide.md\0' } })
  on('tool.call', (_$, e) => {
    if (String((e as { command?: string }).command).startsWith('rm')) w.remove('README.md')
    return { result: { stdout: '', stderr: '', interrupted: false } } as never
  })
  await start($)
  const ui = await $.ui.mount(pane())

  await key(ui, 'G')
  await $.tool.call({ tool: 'Bash', command: 'rm README.md' } as never)
  expect(await rows(ui)).toEqual(['  ▸ docs/', '  ▸ node_modules/', '  ▸ src/'])
  // The cursor stood on the removed file: it moves to the row now in its place, the last.
  expect(await cursor(ui)).toBe('  ▸ src/')
  await $.tool.call({ tool: 'Bash', command: 'git add -A && git commit -m "docs"' } as never)
  expect(w.runs.some(argv => argv[1] === 'show')).toBe(true)
  expect((await rows(ui))[0]).toBe('• ▸ docs/')
  await ui.unmount()
})

test('git status draws letters, lines changed, folder counts and the branch against its upstream', async ($, on) => {
  const w = world(on, FILES, {
    git: { top: ROOT, status: '## main...origin/main [ahead 2, behind 1]\0 M src/app.ts\0?? docs/guide.md\0', numstat: '3\t1\tsrc/app.ts\0' },
  })
  await start($)
  await w.clock.advance(400)
  const ui = await $.ui.mount(pane(50))

  expect((await ui.find({ type: 'Text', text: /⎇ main/ }))?.text).toBe('▾ proj ⎇ main ↑2 ↓1 2 changed +3 -1')
  expect((await rows(ui))[0]).toMatch(/^ {2}▸ docs\/ +1\?$/)
  expect((await rows(ui))[2]).toMatch(/^ {2}▸ src\/ +1M$/)
  await key(ui, 'j')
  await key(ui, 'j')
  await key(ui, 'l')
  expect((await rows(ui)).find(row => row.includes('app.ts'))).toMatch(/◇ app\.ts +\+3 -1 M$/)
  await ui.unmount()
})

test('outside a repository there is no branch line and git runs only to ask', async ($, on) => {
  const w = world(on, FILES)
  await start($)
  await w.clock.advance(400)
  const ui = await $.ui.mount(pane())
  expect(await ui.find({ type: 'Text', text: /⎇/ })).toBeUndefined()
  expect(w.runs.filter(argv => argv[0] === 'git').map(argv => argv[1])).toEqual(['rev-parse'])
  await ui.unmount()
})

test('search finds files in folders never expanded, and Enter on the query reveals the best hit in the tree', async ($, on) => {
  const w = world(on, FILES, { git: { top: ROOT, status: '## main\0', lsFiles: 'src/app.ts\0src/lib/util.ts\0README.md\0docs/guide.md\0' } })
  await start($)
  const ui = await $.ui.mount(pane())

  await ui.press({ key: 'key-s' })
  await ui.input({ key: 'query', text: 'util', kind: 'change' })
  expect(await rows(ui)).toEqual(['  ◇ src/lib/util.ts'])
  // Opening the search and typing share one index: git lists the files once.
  expect(w.runs.filter(argv => argv[1] === 'ls-files')).toHaveLength(1)
  await ui.input({ key: 'query', text: 'util' })
  expect(await cursor(ui)).toBe('      ◇ util.ts')
  expect(await rows(ui)).toContain('    ▾ lib/')
  await ui.unmount()
})

test('a search outside a repository walks the folders, skipping ignored names and links', async ($, on) => {
  const w = world(on, [...FILES, 'loop -> src'])
  await start($)
  const ui = await $.ui.mount(pane())
  await ui.input({ key: 'query', text: 'x.js', kind: 'change' })
  expect(await rows(ui)).toEqual([' No match.'])
  await ui.input({ key: 'query', text: 'guide', kind: 'change' })
  expect(await rows(ui)).toEqual(['  ≡ docs/guide.md'])
  expect(w.runs.some(argv => argv[1] === 'ls-files')).toBe(false)
  await ui.unmount()
})

test('a writes @path at the prompt once, and y copies the relative path; nothing of the file is read', async ($, on) => {
  const w = world(on, [...FILES, 'my notes.md'])
  await start($)
  const ui = await $.ui.mount(pane())
  await key(ui, 'G')
  await key(ui, 'k')
  expect(await cursor(ui)).toBe('  ≡ my notes.md')
  await key(ui, 'a')
  await key(ui, 'a')
  expect(w.fills).toEqual(['@"my notes.md" '])
  expect(await ui.find({ type: 'Text', text: /already in the prompt/ })).toBeDefined()
  await key(ui, 'j')
  await key(ui, 'y')
  expect(w.copies).toEqual(['README.md'])
  expect(w.reads).toEqual([])
  await ui.unmount()
})

test('an @path mention in a prompt reveals the file and is attached as the engine decided', async ($, on) => {
  world(on, FILES)
  const attached = { type: 'file' }
  on('prompt.mention', () => attached as never)
  await start($)
  const ui = await $.ui.mount(pane())
  const result = await $.prompt.mention({ mention: 'src/lib/util.ts', path: `${ROOT}/src/lib/util.ts` } as never)
  expect(result).toMatchObject(attached)
  expect(await cursor(ui)).toBe('      ◇ util.ts')
  await ui.unmount()
})

test('a link to a folder opens as a folder; a folder that went away leaves the tree on refresh', async ($, on) => {
  const w = world(on, [...FILES, 'linked -> docs'])
  await start($)
  const ui = await $.ui.mount(pane())
  expect(await rows(ui)).toContain('  ▸ linked/ ↪')
  await key(ui, 'j')
  await key(ui, 'l')
  expect(await rows(ui)).toContain('    ≡ guide.md')
  w.remove('src')
  await key(ui, 'r')
  expect(await rows(ui)).not.toContain('  ▸ src/')
  await ui.unmount()
})

test('a folder of 2500 files draws its first 2000 and a row for the rest, and the pane stays within its rows', async ($, on) => {
  world(on, ['big/', ...Array.from({ length: 2500 }, (_, i) => `big/f${i}.txt`)])
  await start($)
  const ui = await $.ui.mount(pane(40, 12))
  await key(ui, 'l')
  await key(ui, 'G')
  expect(await cursor(ui)).toBe('    … 500 more')
  expect((await rows(ui)).length).toBeLessThanOrEqual(12)
  await ui.unmount()
})

test('a cwd change moves an unpinned root; /file-explorer <folder> pins one', async ($, on) => {
  world(on, FILES)
  await start($)
  const ui = await $.ui.mount(pane())
  await $.classic.CwdChanged({ old_cwd: ROOT, new_cwd: `${ROOT}/src` } as never)
  expect(await rows(ui)).toEqual(['  ▸ lib/', '  ◇ app.ts'])
  await $.command.run({ command: 'file-explorer', args: ROOT } as never)
  await $.classic.CwdChanged({ old_cwd: ROOT, new_cwd: `${ROOT}/docs` } as never)
  expect(await rows(ui)).toEqual(TOP)
  await ui.unmount()
})

test('git index changes reread the status once after a pause; the session end stops every timer', async ($, on) => {
  const w = world(on, FILES, { git: { top: ROOT, status: '## main\0' } })
  await start($)
  await $.classic.SessionStart({ source: 'startup' } as never)
  await w.clock.advance(400)
  const status = () => w.runs.filter(argv => argv[1] === 'status').length
  const before = status()
  await $.classic.FileChanged({ file_path: `${ROOT}/.git/index`, event: 'change' } as never)
  await $.classic.FileChanged({ file_path: `${ROOT}/.git/HEAD`, event: 'change' } as never)
  await w.clock.advance(400)
  expect(status()).toBe(before + 1)
  await $.session.end({ reason: 'exit' } as never)
  const after = w.runs.length
  await w.clock.advance(60_000)
  expect(w.runs.length).toBe(after)
})

test('a settings value outside its choices reads as the default', { options: { sort: 'size', icons: 'emoji' } as never }, async ($, on) => {
  world(on, FILES)
  await start($)
  const ui = await $.ui.mount(pane())
  expect(await rows(ui)).toEqual(TOP)
  await ui.unmount()
})

test('Nerd Font icons draw in the terminal alone; the desktop app, with a font of its own, gets the Unicode set', { options: { icons: 'nerd' } }, async ($, on) => {
  world(on, FILES)
  await start($)
  const terminal = await $.ui.mount(pane())
  expect(await rows(terminal)).not.toEqual(TOP)
  await terminal.unmount()
  const desktop = await $.ui.mount({ ...pane(), surface: 'desktop' } as never)
  expect(await rows(desktop as never)).toEqual(TOP)
  await desktop.unmount()
})

test('on a surface without a rows module the rows are text and the hotkeys still move', async ($, on) => {
  world(on, FILES)
  await start($)
  const ui = await $.ui.mount({ ...pane(), surface: 'vscode' } as never)
  expect(await ui.find({ type: 'Client' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /README\.md/ })).toBeDefined()
  await ui.press({ key: 'key-j' })
  expect((await ui.find({ type: 'Text', text: /node_modules/ }))?.text).toBeDefined()
  await ui.unmount()
})

test('git runs with no optional locks, no fsmonitor and no external diff or textconv', async ($, on) => {
  const w = world(on, FILES, { git: { top: ROOT, status: '## main\0', show: 'README.md\0' } })
  on('tool.call', () => ({ result: { stdout: '', stderr: '', interrupted: false } }) as never)
  await start($)
  await w.clock.advance(400)
  await $.tool.call({ tool: 'Bash', command: 'git commit -m x' } as never)
  const git = w.gitRuns.filter(argv => argv[0] === 'git')
  expect(git.length).toBeGreaterThan(2)
  for (const argv of git) expect(argv.slice(0, 4)).toEqual(['git', '--no-optional-locks', '-c', 'core.fsmonitor=false'])
  for (const argv of git.filter(one => one.includes('diff') || one.includes('show'))) expect(argv).toEqual(expect.arrayContaining(['--no-ext-diff', '--no-textconv']))
})

test('a command that only names git commit marks no commit', async ($, on) => {
  const w = world(on, FILES, { git: { top: ROOT, status: '## main\0', show: 'README.md\0' } })
  on('tool.call', () => ({ result: { stdout: '', stderr: '', interrupted: false } }) as never)
  await start($)
  await $.tool.call({ tool: 'Bash', command: 'echo git commit && git log --grep=commit' } as never)
  expect(w.runs.some(argv => argv[1] === 'show')).toBe(false)
})

test('a note goes with the next key, and keys held with ctrl or meta move nothing', async ($, on) => {
  world(on, FILES)
  await start($)
  const ui = await $.ui.mount(pane())
  await key(ui, 'y')
  expect(await ui.find({ type: 'Text', text: /Copied docs/ })).toBeDefined()
  await key(ui, 'j')
  expect(await ui.find({ type: 'Text', text: /Copied/ })).toBeUndefined()
  expect(await cursor(ui)).toBe('  ▸ node_modules/')
  await ui.key({ key: 'j', ctrl: true, in: 'rows' })
  await ui.key({ key: 'e', meta: true, in: 'rows' })
  expect(await cursor(ui)).toBe('  ▸ node_modules/')
  await ui.unmount()
})

test('a /clear keeps the background check running; a subagent mention moves nothing', async ($, on) => {
  const w = world(on, FILES)
  on('prompt.mention', () => ({ type: 'file' }) as never)
  await start($)
  const ui = await $.ui.mount(pane())
  await $.session.end({ reason: 'clear' } as never)
  w.add('later.md')
  await w.clock.advance(6000)
  expect(await rows(ui)).toContain('  ≡ later.md')
  await $.prompt.mention({ mention: 'src/app.ts', path: `${ROOT}/src/app.ts`, agentId: 'agent-1' } as never)
  expect(await cursor(ui)).toBe('  ▸ docs/')
  await ui.unmount()
})
