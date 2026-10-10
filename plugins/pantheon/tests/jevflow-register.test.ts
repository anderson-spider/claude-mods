import { mock, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

// The flow as the engine drives it: the mcp__pantheon__flow tool, the classic SessionStart and Stop hooks and the
// /pantheon flow command, over an in-memory repository whose shell checks pass or fail by the table `exits`.

const ROOT = '/repo'
const HOME = '/home/u'
const SID = 'sess-1'
const FLOW = 'mcp__pantheon__flow'

function flowWorld(on: On) {
  const files = new Map<string, string>([[`${HOME}/.claude/pantheon.json`, '{}']])
  const exits: Record<string, number> = {}
  const toasts: string[] = []
  const isDir = (path: string) => [...files.keys()].some(f => f.startsWith(`${path}/`))
  mock.clock(on)
  mock.env(on, { HOME })
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('session.cwd', async () => ({ value: ROOT }))
  on('session.id', async () => ({ value: SID }))
  on('fs.exists', async (_$, e) => ({ value: files.has(e.path) || isDir(e.path) }))
  on('fs.read', async (_$, e) => {
    const text = files.get(e.path)
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: text }
  })
  on('fs.write', async (_$, e) => { files.set(e.path, e.text); return { value: undefined } })
  on('fs.list', async (_$, e) => {
    const names = new Map<string, 'file' | 'dir'>()
    for (const f of files.keys()) {
      if (!f.startsWith(`${e.path}/`)) continue
      const [name, ...rest] = f.slice(e.path.length + 1).split('/')
      names.set(name!, rest.length ? 'dir' : 'file')
    }
    return { value: [...names].map(([name, kind]) => ({ name, kind, size: 0, mtimeMs: 0, isLink: false })) }
  })
  on('fs.stat', async (_$, e) => ({ value: { kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false, realPath: e.path } }))
  on('process.run', async (_$, e) => {
    const done = (stdout = '', exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    const argv = [...e.argv]
    if (argv[0] === 'git') return argv.includes('--show-toplevel') ? done(`${ROOT}\n`) : done('', 128)
    if (argv[0] === 'rm') { files.delete(argv[3]!); return done() }
    if (argv[0] === 'mv') {
      const [from, to] = [argv[2]!, argv[3]!]
      for (const [f, text] of [...files]) if (f.startsWith(`${from}/`)) { files.delete(f); files.set(to + f.slice(from.length), text) }
      return done()
    }
    if (argv[0] === '/bin/sh') {
      const code = exits[argv[2]!] ?? 0
      return done(code ? `${argv[2]}: failed\n` : '', code)
    }
    return done()
  })
  on('agent.register', async (_$, e) => ({ value: { agent: `pantheon:${e.name}` } }))
  on('tool.register', async (_$, e) => ({ value: { tool: `mcp__pantheon__${e.name}` } }))
  on('command.register', async (_$, e) => ({ value: { command: e.name } }))
  on('ui.toast', async (_$, e) => { toasts.push(e.text); return { value: undefined } })
  on('ui.open', async () => ({ value: { isPlaced: false } }) as never)
  on('ui.invalidate', async () => ({ value: undefined }))
  on('classic.SessionStart', async () => ({}))
  on('classic.Stop', async () => ({}))
  return { files, exits, toasts }
}

const call = async ($: Engine, input: Record<string, unknown>) => String((await $.tool.call({ tool: FLOW, ...input } as never) as { result?: unknown }).result)
const stop = ($: Engine, active = false) =>
  $.classic.Stop({ session_id: SID, stop_hook_active: active, last_assistant_message: 'Done.', background_tasks: [], session_crons: [] } as never) as Promise<{ block?: string }>

const PHASES = {
  schema_version: 1, title: 'Two files', goal: 'Create a.txt then b.txt',
  phases: [
    { id: 'a', name: 'Make a', done_when: 'a.txt exists', check: 'test -f a.txt' },
    { id: 'b', name: 'Make b', done_when: 'b.txt exists', check: 'test -f b.txt' },
  ],
}

test('the flow tool starts, validates and claims, the Stop holds and advances on the checks, and /pantheon flow shows it', async ($, on) => {
  const w = flowWorld(on)
  w.exits['test -f a.txt'] = 1
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })

  const started = await call($, { action: 'start', goal: 'Create a.txt then b.txt', name: 'two files' })
  const id = /tracked flow `([^`]+)`/.exec(started)?.[1]
  expect(id).toBeDefined()
  expect(w.files.get(`${ROOT}/.pantheon/flow/sessions/${SID}`)).toBe(`${id}\n`)

  const held = await stop($)
  expect(held.block).toContain('Lay out the flow before stopping (1/3)')

  w.files.set(`${ROOT}/.pantheon/flow/flows/${id}/flow.json`, JSON.stringify(PHASES))
  expect(await call($, { action: 'validate' })).toContain('is valid: 2 phases')
  expect(await call($, { action: 'claim', phase: 'a', as: 'developer' })).toBe('Claimed a as developer.')
  expect(await call($, { action: 'claim', phase: 'a', as: 'wizard' })).toContain("unknown role 'wizard'")
  expect(await call($, { action: 'nope' })).toContain('Unknown action')

  expect((await stop($)).block).toContain('test -f a.txt')
  w.exits['test -f a.txt'] = 0
  const advanced = await stop($, true)
  expect(advanced.block).toContain("Now work on phase 'b'")
  expect(w.toasts.some(t => t.includes('✓ a → b (1/2 done)'))).toBe(true)

  const status = (await $.command.run({ command: 'pantheon', args: 'flow', origin: { kind: 'composer' } } as never) as { text?: string }).text
  expect(status).toContain(`Flow ${id}`)
  expect(status).toMatch(/>\s+b\s+active/)

  expect((await stop($, true)).block).toBeUndefined()
  expect(w.files.has(`${ROOT}/.pantheon/flow/done/${id}/SUMMARY.md`)).toBe(true)
})

test('a session with no flow is told it may start one', async ($, on) => {
  flowWorld(on)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  const out = await $.classic.SessionStart({ session_id: SID, source: 'startup' } as never) as { additionalContext?: string[] }
  expect(out.additionalContext?.join('\n')).toContain('`mcp__pantheon__flow` tool with `action: "start"`')
})
