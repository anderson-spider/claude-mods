import { mock, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'
import { faithfulBody } from './fixtures/jev'

// The flow as the engine drives it: the mcp__pantheon__flow tool, the classic SessionStart and Stop hooks and the
// /pantheon flow command, over an in-memory repository whose shell checks pass or fail by the table `exits`.

const ROOT = '/repo'
const HOME = '/home/u'
const SID = 'sess-1'
const FLOW = 'mcp__pantheon__flow'

// The test runtime has timers, but the typings this plugin checks against do not declare them.
const timers = globalThis as unknown as { setTimeout: (run: () => void, ms: number) => unknown }
const pause = (ms: number) => new Promise<void>(resolve => timers.setTimeout(resolve, ms))

// Jev has a key and agrees with the checks unless a test passes `OPENROUTER_API_KEY: undefined` (no key) or sets `jevStatus`.
function flowWorld(on: On, store: Record<string, unknown> = {}, env: Record<string, string | undefined> = {}) {
  const files = new Map<string, string>([[`${HOME}/.claude/pantheon.json`, '{}']])
  const exits: Record<string, number> = {}
  const toasts: string[] = []
  const ran: string[] = []
  // What Claude Code's permission rules answer for a check's Bash command (tool.check); allow unless a test says otherwise.
  const rules: { decision: 'allow' | 'ask' | 'deny'; reason?: string } = { decision: 'allow' }
  const isDir = (path: string) => [...files.keys()].some(f => f.startsWith(`${path}/`))
  const clock = mock.clock(on)
  mock.env(on, Object.fromEntries(Object.entries({ HOME, OPENROUTER_API_KEY: 'test-key', ...env }).filter(([, v]) => v !== undefined)) as Record<string, string>)
  // Each settings source's contents (project and local are the repository's); `{}` for any other.
  const settings: Record<string, Record<string, unknown>> = {}
  on('settings.read', async (_$, e) => ({ value: (e.source ? settings[e.source] : undefined) ?? {} }))
  // Jev's requests: their Authorization header; answered by a Jev that agrees with the checks, or with `jevStatus`.
  const jevAuth: string[] = []
  const jev: { status?: number } = {}
  on('http.fetch', async (_$, e) => {
    jevAuth.push(String((e.init?.headers as Record<string, string> | undefined)?.Authorization))
    if (jev.status !== undefined) return { value: { status: jev.status, ok: false, headers: {}, text: '{}' } }
    return { value: { status: 200, ok: true, headers: {}, text: faithfulBody(String(e.init?.body)) } }
  })
  // The plugin's store, in memory and readable by the test (the test's own engine has no store handle).
  const kv = new Map<string, unknown>(Object.entries(store))
  on('store.get', async (_$, e) => ({ value: kv.get(e.key) }))
  on('store.set', async (_$, e) => { kv.set(e.key, e.value); return { value: undefined } })
  on('store.delete', async (_$, e) => { kv.delete(e.key); return { value: undefined } })
  on('store.keys', async () => ({ value: [...kv.keys()] }))
  on('tool.check', async () => rules)
  on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'Text', children: ['idle'] }))
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
    // A real wait: the held box polls, and a microtask-only loop would starve the timers the tests use.
    if (argv[0] === 'sleep') { await pause(5); return done() }
    if (argv[0] === '/bin/sh') {
      ran.push(argv[2]!)
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
  on('classic.UserPromptSubmit', async () => ({}))
  return { files, exits, toasts, ran, rules, store: kv, clock, settings, jevAuth, jev }
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

test('a session with no flow is never told to start one', async ($, on) => {
  flowWorld(on)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  const out = await $.classic.SessionStart({ session_id: SID, source: 'startup' } as never) as { additionalContext?: string[] }
  expect(out.additionalContext).toBeUndefined()
  const prompt = await $.classic.UserPromptSubmit({ session_id: SID, prompt: 'Add a dark mode toggle, cover it with tests and document it in the README' } as never) as { additionalContext?: string[] }
  expect(prompt.additionalContext).toBeUndefined()
})

test('the Stop is not evaluated while a subagent runs in the background; a shell task does not hold it back', async ($, on) => {
  const w = flowWorld(on)
  w.exits['test -f a.txt'] = 1
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await layOut($, w)
  const stopWith = (type: string) => $.classic.Stop({
    session_id: SID, stop_hook_active: false, last_assistant_message: 'Done.',
    background_tasks: [{ id: 't1', type, status: 'running', description: 'x', command: 'x' }], session_crons: [],
  } as never) as Promise<{ block?: string }>
  const ranBefore = w.ran.length
  expect((await stopWith('subagent')).block).toBeUndefined()
  expect(w.ran.length).toBe(ranBefore)
  expect((await stopWith('shell')).block).toContain('test -f a.txt')
})

test('without a key the flow tool refuses to start and writes nothing', async ($, on) => {
  const w = flowWorld(on, {}, { OPENROUTER_API_KEY: undefined })
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  const refused = await call($, { action: 'start', goal: 'Create a.txt then b.txt', name: 'two files' })
  expect(refused).toContain('Flow not started: the flow needs Jev, and neither the judgeKey option nor OPENROUTER_API_KEY is set.')
  expect([...w.files.keys()].some(path => path.includes('/.pantheon/'))).toBe(false)
})

test('when Jev fails, the Stop is held once with a toast telling the person, and the next stop goes through', async ($, on) => {
  const w = flowWorld(on)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await layOut($, w)
  w.exits['test -f a.txt'] = 0
  w.jev.status = 401
  const held = await stop($)
  expect(held.block).toContain('Jev did not judge this Stop')
  expect(held.block).toContain('disable the pantheon plugin')
  expect(w.toasts.some(t => t.startsWith('[Pantheon flow] Jev did not judge this Stop'))).toBe(true)
  const relayed = await stop($, true)
  expect(relayed.block).toBeUndefined()
})

test('a spawned docs-reader whose Agent description starts with a phase id claims that phase; without the prefix it claims nothing', async ($, on) => {
  const w = flowWorld(on)
  let agentId = 'native-1'
  on('agent.spawn', async () => ({ model: 'model-1', agentId }))
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  const started = await call($, { action: 'start', goal: 'Create a.txt then b.txt', name: 'two files' })
  const id = /tracked flow `([^`]+)`/.exec(started)?.[1]
  expect(id).toBeDefined()
  w.files.set(`${ROOT}/.pantheon/flow/flows/${id}/flow.json`, JSON.stringify(PHASES))
  expect(await call($, { action: 'validate' })).toContain('is valid: 2 phases')

  const spawn = (description: string) => $.agent.spawn({
    tool_use_id: `spawn-${agentId}`, prompt: 'Read the docs', description, subagentType: 'pantheon:docs-reader',
    provider: { plugin: 'pantheon', tier: 'user' }, parentModel: 'parent', permissionMode: 'default',
  } as never)
  const agents = () => JSON.parse(w.files.get(`${ROOT}/.pantheon/flow/flows/${id}/state.json`)!).agents

  await spawn('[a] Read the docs')
  expect(agents()['agent:native-1']).toMatchObject({ phase: 'a', role: 'docs-reader', claimed: true })

  agentId = 'native-2'
  await spawn('Read the docs')
  expect(agents()['agent:native-2']).toBeUndefined()
})

/** Starts a flow through the tool and lays its phases out, as the model does; the flow's phases are PHASES. */
async function layOut($: Engine, w: { files: Map<string, string> }) {
  const started = await call($, { action: 'start', goal: 'Create a.txt then b.txt', name: 'two files' })
  const id = /tracked flow `([^`]+)`/.exec(started)?.[1]
  expect(id).toBeDefined()
  w.files.set(`${ROOT}/.pantheon/flow/flows/${id}/flow.json`, JSON.stringify(PHASES))
  expect(await call($, { action: 'validate' })).toContain('is valid: 2 phases')
}

test('a check the permission rules deny is not run, and the Stop holds with the reason', async ($, on) => {
  const w = flowWorld(on)
  w.rules.decision = 'deny'
  w.rules.reason = 'Bash(test:*) is denied'
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await layOut($, w)
  const held = await stop($)
  expect(w.ran).toEqual([])
  expect(held.block).toContain("not run: Claude Code's permission rules deny it: Bash(test:*) is denied")
})

test('a check the rules ask about is not run when no one can answer, and the Stop says so', async ($, on) => {
  const w = flowWorld(on)
  w.rules.decision = 'ask'
  await $.session.start({ cwd: ROOT, surface: null, isInteractive: false })
  await layOut($, w)
  const held = await stop($)
  expect(w.ran).toEqual([])
  expect(held.block).toContain('it needs permission and there is no one to ask')
})

test('a check the person approved in this repository before runs without asking again', async ($, on) => {
  const w = flowWorld(on, { flowCheckApprovals: { [ROOT]: ['test -f a.txt'] } })
  w.rules.decision = 'ask'
  await $.session.start({ cwd: ROOT, surface: null, isInteractive: false })
  await layOut($, w)
  const advanced = await stop($)
  expect(w.ran).toEqual(['test -f a.txt'])
  expect(advanced.block).toContain("Now work on phase 'b'")
})

for (const decision of ['proceed', 'cancel'] as const) {
  test(`an ask in an interactive session holds the flow check box; ${decision} decides it (${decision === 'proceed' ? 'and is remembered' : 'and nothing is remembered'})`, async ($, on) => {
    const w = flowWorld(on)
    w.rules.decision = 'ask'
    await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
    await layOut($, w)
    const ui = await $.ui.mount({ plugin: 'pantheon', component: 'AbovePrompt', surface: 'terminal', props: { hasSurvey: false, isWorking: false, maxRows: 12, bodyColumns: 120 } as never })
    const pending = stop($)
    try {
      // Wait for the Stop to reach the hold and draw the box (bounded, so a missing box fails rather than hangs).
      let texts = ''
      for (let i = 0; i < 100 && !texts.includes('Pantheon flow check'); i++) {
        await pause(10)
        texts = (await ui.findAll({ type: 'Text' })).map(node => String(node.text)).join('|')
      }
      expect(texts).toContain('Pantheon flow check')
      expect(texts).toContain('Run the check of phase `a`?')
      expect(w.ran).toEqual([])
      await ui.press({ key: decision })
      const out = await pending
      if (decision === 'proceed') {
        expect(w.ran).toEqual(['test -f a.txt'])
        expect(out.block).toContain("Now work on phase 'b'")
        expect(w.store.get('flowCheckApprovals')).toEqual({ [ROOT]: ['test -f a.txt'] })
      } else {
        expect(w.ran).toEqual([])
        expect(out.block).toContain('the person cancelled it')
        expect(w.store.has('flowCheckApprovals')).toBe(false)
      }
    } finally {
      // A pending hold that never got a press must not keep polling after the test.
      await ui.press({ key: 'cancel' }).catch(() => undefined)
      await pending.catch(() => undefined)
      await ui.unmount()
    }
  })
}

test('a flow check box left unanswered gives up after 2 minutes: the Stop goes through unjudged and the next one asks again', async ($, on) => {
  const w = flowWorld(on)
  w.rules.decision = 'ask'
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await layOut($, w)
  const ui = await $.ui.mount({ plugin: 'pantheon', component: 'AbovePrompt', surface: 'terminal', props: { hasSurvey: false, isWorking: false, maxRows: 12, bodyColumns: 120 } as never })
  const boxShown = async () => {
    let texts = ''
    for (let i = 0; i < 100 && !texts.includes('Pantheon flow check'); i++) {
      await pause(10)
      texts = (await ui.findAll({ type: 'Text' })).map(node => String(node.text)).join('|')
    }
    return texts
  }
  let pending = stop($)
  try {
    const texts = await boxShown()
    expect(texts).toContain('Without an answer in 2 minutes, this Stop goes through unjudged.')
    await w.clock.advance(119_000)
    await pause(20)
    expect(await ui.findAll({ type: 'Text' }).then(n => n.some(t => String(t.text).includes('Pantheon flow check')))).toBe(true)
    await w.clock.advance(1_000)
    const out = await pending
    expect(out.block).toBeUndefined()
    expect(w.ran).toEqual([])
    expect(w.toasts.some(t => t.includes('Check not run (no answer within 2 minutes)'))).toBe(true)
    // Nothing was judged or recorded: the flow is where it was, and the next Stop asks again.
    const state = JSON.parse([...w.files].find(([path]) => path.endsWith('/state.json'))![1])
    expect(state.current_phase).toBe('a')
    expect(state.blocks_this_session).toBe(0)
    expect(state.history.some((h: { event: string }) => h.event === 'stop')).toBe(false)
    expect(w.store.has('flowCheckApprovals')).toBe(false)
    pending = stop($)
    expect(await boxShown()).toContain('Run the check of phase `a`?')
    await ui.press({ key: 'proceed' })
    expect((await pending).block).toContain("Now work on phase 'b'")
  } finally {
    await ui.press({ key: 'cancel' }).catch(() => undefined)
    await pending.catch(() => undefined)
    await ui.unmount()
  }
})

// A flow whose phases have no check: every Stop is degraded_* and asks Jev.
async function layOutNoChecks($: Engine) {
  const started = await call($, { action: 'start', goal: 'Create a.txt then b.txt', name: 'two files' })
  const id = /tracked flow `([^`]+)`/.exec(started)?.[1]
  expect(id).toBeDefined()
  return id!
}

test('without the judgeKey option, OPENROUTER_API_KEY from the environment turns Jev on', async ($, on) => {
  const w = flowWorld(on, {}, { OPENROUTER_API_KEY: ' env-key ' })
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  const id = await layOutNoChecks($)
  w.files.set(`${ROOT}/.pantheon/flow/flows/${id}/flow.json`, JSON.stringify({ ...PHASES, phases: PHASES.phases.map(({ check: _drop, ...rest }) => rest) }))
  expect(await call($, { action: 'validate' })).toContain('is valid: 2 phases')
  expect(await call($, { action: 'status' })).toContain('Jev: on (OPENROUTER_API_KEY).')
  await stop($)
  expect(w.jevAuth[0]).toBe('Bearer env-key')
  expect(w.toasts.some(t => t.includes('Jev is off'))).toBe(false)
})

test('the judgeKey option wins over OPENROUTER_API_KEY', { options: { judgeKey: 'option-key' } }, async ($, on) => {
  const w = flowWorld(on, {}, { OPENROUTER_API_KEY: 'env-key' })
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  const id = await layOutNoChecks($)
  w.files.set(`${ROOT}/.pantheon/flow/flows/${id}/flow.json`, JSON.stringify({ ...PHASES, phases: PHASES.phases.map(({ check: _drop, ...rest }) => rest) }))
  expect(await call($, { action: 'validate' })).toContain('is valid: 2 phases')
  expect(await call($, { action: 'status' })).toContain('Jev: on (judgeKey option).')
  await stop($)
  expect(w.jevAuth[0]).toBe('Bearer option-key')
})

for (const source of ['project', 'local'] as const) {
  test(`OPENROUTER_API_KEY that the repository's ${source} settings declare is ignored, and no flow starts`, async ($, on) => {
    const w = flowWorld(on, {}, { OPENROUTER_API_KEY: 'repo-key' })
    w.settings[source] = { env: { OPENROUTER_API_KEY: 'repo-key' } }
    await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
    const refused = await call($, { action: 'start', goal: 'Create a.txt then b.txt', name: 'two files' })
    expect(refused).toContain("Flow not started: the flow needs Jev, and OPENROUTER_API_KEY comes from this repository's settings and is ignored; set the judgeKey option.")
    expect(w.jevAuth).toEqual([])
  })
}
