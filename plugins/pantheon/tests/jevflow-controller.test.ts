import { expect, test } from 'claude-code/testing'
import * as flow from '../hooks/jevflow/controller'
import type { Io } from '../hooks/jevflow/controller'
import type { Answers, AskFn } from '../hooks/jevflow/questions'

// The hook entry points of the port (JevFlow hooks.py, auto.py) over an in-memory folder: shell checks pass or fail by
// the table `exits`, git is absent, and the clock moves one second per read.

const ROOT = '/repo'

function folder(exits: Record<string, number> = {}, ask?: AskFn) {
  const files = new Map<string, string>()
  let clock = 1_000_000
  const ran: string[] = []
  const isDir = (path: string) => [...files.keys()].some(f => f.startsWith(`${path}/`))
  const io: Io = {
    read: async path => files.get(path),
    write: async (path, text) => { files.set(path, text) },
    exists: async path => files.has(path) || isDir(path),
    list: async dir => {
      const names = new Map<string, string>()
      for (const f of files.keys()) {
        if (!f.startsWith(`${dir}/`)) continue
        const [name, ...rest] = f.slice(dir.length + 1).split('/')
        names.set(name!, rest.length ? 'dir' : 'file')
      }
      if (!names.size && !files.has(dir)) throw new Error(`ENOENT: ${dir}`)
      return [...names].map(([name, kind]) => ({ name, kind, mtimeMs: clock * 1000 }))
    },
    remove: async path => { files.delete(path) },
    move: async (from, to) => {
      for (const [f, text] of [...files]) if (f.startsWith(`${from}/`)) { files.delete(f); files.set(to + f.slice(from.length), text) }
    },
    run: async argv => {
      if (argv[0] === 'git') return { exitCode: 128, stdout: '', stderr: 'not a git repository' }
      const cmd = argv[2] ?? ''
      ran.push(cmd)
      const code = exits[cmd] ?? 0
      return { exitCode: code, stdout: code ? `${cmd}: failed\n` : '', stderr: '' }
    },
    now: async () => ++clock,
    ...(ask ? { ask } : {}),
  }
  return { io, files, exits, ran }
}

const FLOW = {
  schema_version: 1, title: 'Two files', goal: 'Create a.txt then b.txt',
  phases: [
    { id: 'a', name: 'Make a', done_when: 'a.txt exists', check: 'test -f a.txt' },
    { id: 'b', name: 'Make b', done_when: 'b.txt exists', check: 'test -f b.txt' },
  ],
}

async function started(f: ReturnType<typeof folder>, sid = 's1') {
  const text = await flow.startFlow(f.io, ROOT, sid, 'Create a.txt then b.txt', 'two files')
  const id = /tracked flow `([^`]+)`/.exec(text)?.[1]
  if (!id) throw new Error(`no flow id in: ${text}`)
  return flow.pathsOf(ROOT, id)
}

test('a session with no flow gets the start hint; a task-like first prompt gets the nudge', async () => {
  const f = folder()
  expect(await flow.onSessionStart(f.io, ROOT, { session_id: 's1', source: 'startup' })).toContain('`action: "start"`')
  expect(await flow.onUserPrompt(f.io, ROOT, { session_id: 's1', prompt: 'add a dark mode toggle' }, true)).toContain('[Pantheon flow] This request looks like a multi-step task')
  expect(await flow.onUserPrompt(f.io, ROOT, { session_id: 's1', prompt: 'what is this?' }, false)).toBeUndefined()
})

test('start writes a draft bound to the session, and the Stop is held until the flow is laid out, then archived as abandoned', async () => {
  const f = folder()
  const p = await started(f)
  expect(p.id).toMatch(/^\d{8}-\d{6}-two-files$/)
  expect(JSON.parse(f.files.get(p.draft)!)).toMatchObject({ goal: 'Create a.txt then b.txt', session_id: 's1', plan_blocks: 0 })
  expect(f.files.get(`${ROOT}/.pantheon/flow/sessions/s1`)).toBe(`${p.id}\n`)
  expect(f.files.get(`${ROOT}/.pantheon/flow/.gitignore`)).toBe('sessions/\n*.tmp\n')
  for (const n of [1, 2, 3]) {
    const out = await flow.onStop(f.io, ROOT, { session_id: 's1', stop_hook_active: n > 1 })
    expect(out.block).toContain(`Lay out the flow before stopping (${n}/3)`)
  }
  const last = await flow.onStop(f.io, ROOT, { session_id: 's1', stop_hook_active: true })
  expect(last.block).toBeUndefined()
  expect(last.message).toContain('archived as abandoned')
  expect(f.files.get(`${ROOT}/.pantheon/flow/done/${p.id}/SUMMARY.md`)).toContain('abandoned (no flow laid out)')
})

test('without Jev the checks decide: a failing check holds the stop, a passing one advances, and the last completes and archives', async () => {
  const f = folder({ 'test -f a.txt': 1, 'test -f b.txt': 1 })
  const p = await started(f)
  f.files.set(p.flow, JSON.stringify(FLOW))
  expect(await flow.validateFlow(f.io, ROOT, 's1')).toContain('is valid: 2 phases')

  const held = await flow.onStop(f.io, ROOT, { session_id: 's1', stop_hook_active: false, last_assistant_message: 'done' })
  expect(held.block).toContain('[Pantheon flow]')
  expect(held.block).toContain('test -f a.txt')
  expect(f.files.has(p.draft)).toBe(false)

  f.exits['test -f a.txt'] = 0
  const advanced = await flow.onStop(f.io, ROOT, { session_id: 's1', stop_hook_active: true })
  expect(advanced.block).toContain("Now work on phase 'b'")
  expect(advanced.message).toContain('✓ a → b (1/2 done)')
  const state = JSON.parse(f.files.get(p.state)!)
  expect(state.phase_status).toEqual({ a: 'done', b: 'active' })
  expect(state.history.at(-1)).toMatchObject({ event: 'stop', decision: 'ADVANCE', enforced: true, to_phase: 'b' })
  expect(state.last_jev_error.error).toContain('judgeKey')

  f.exits['test -f b.txt'] = 0
  const done = await flow.onStop(f.io, ROOT, { session_id: 's1', stop_hook_active: true })
  expect(done.block).toBeUndefined()
  expect(done.message).toContain('Goal complete. Flow archived to .pantheon/flow/done/')
  expect(f.files.get(`${ROOT}/.pantheon/flow/done/${p.id}/SUMMARY.md`)).toContain('Outcome: **complete**')
  expect(await flow.onStop(f.io, ROOT, { session_id: 's1', stop_hook_active: false })).toEqual({})
})

test('a claim names the phase and a Pantheon role, shows in the status, and refuses a role that is not one', async () => {
  const f = folder({ 'test -f a.txt': 1 })
  const p = await started(f)
  f.files.set(p.flow, JSON.stringify(FLOW))
  await flow.onSessionStart(f.io, ROOT, { session_id: 's1', source: 'startup' })
  expect(await flow.claimFlow(f.io, ROOT, { sessionId: 's1', agentId: 'ag1' }, 'b', 'docs-reader')).toBe('Claimed b as docs-reader.')
  expect(await flow.claimFlow(f.io, ROOT, { sessionId: 's1' }, 'a', 'lead')).toBe('Claimed a as lead.')
  expect(await flow.claimFlow(f.io, ROOT, { sessionId: 's1' }, 'a', 'writer')).toContain("unknown role 'writer'")
  expect(await flow.claimFlow(f.io, ROOT, { sessionId: 's1' }, 'z', 'lead')).toContain("unknown phase 'z'")
  const status = await flow.statusText(f.io, ROOT, 's1')
  expect(status).toMatch(/>\s+a\s+active\s+yes\s+lead/)
  expect(status).toMatch(/\s+b\s+pending\s+yes\s+docs-reader/)
  // The lead's claim ends with its turn; a subagent's stays.
  await flow.onStop(f.io, ROOT, { session_id: 's1', stop_hook_active: false })
  const agents = JSON.parse(f.files.get(p.state)!).agents
  expect(agents['session:s1'].claimed).toBeUndefined()
  expect(agents['agent:ag1']).toMatchObject({ phase: 'b', role: 'docs-reader', claimed: true })
})

test('another session sees the running flow and joins it', async () => {
  const f = folder()
  const p = await started(f)
  f.files.set(p.flow, JSON.stringify(FLOW))
  await flow.onSessionStart(f.io, ROOT, { session_id: 's1', source: 'startup' })
  const hint = await flow.onSessionStart(f.io, ROOT, { session_id: 's2', source: 'startup' })
  expect(hint).toContain(`\`${p.id}\`: Two files, at phase \`a\``)
  expect(await flow.joinFlow(f.io, ROOT, 's2', p.id)).toContain(`Joined flow ${p.id}`)
  expect(await flow.onSessionStart(f.io, ROOT, { session_id: 's2', source: 'startup' })).toContain('Goal: Create a.txt then b.txt')
})

test('a person prompt refills the block budget of a held flow', async () => {
  const f = folder({ 'test -f a.txt': 1 })
  const p = await started(f)
  f.files.set(p.flow, JSON.stringify(FLOW))
  await flow.onStop(f.io, ROOT, { session_id: 's1', stop_hook_active: false })
  expect(JSON.parse(f.files.get(p.state)!).blocks_this_session).toBe(1)
  await flow.onUserPrompt(f.io, ROOT, { session_id: 's1', prompt: 'keep going' }, false)
  const state = JSON.parse(f.files.get(p.state)!)
  expect(state.blocks_this_session).toBe(0)
  expect(state.history.at(-1)).toMatchObject({ event: 'budget_refill', used: 1 })
})

test('with Jev, a phase it calls done and verifies advances even without a check', async () => {
  const answers = (verify: boolean): Answers => verify
    ? { verify: { noul: 0.95 } }
    : {
      current_phase: { choice: 'a', confidence: 0.9, probabilities: { a: 0.9, b: 0.05, unclear: 0.05 } },
      next_action: { choice: 'advance_phase', confidence: 0.9 },
      stuck: { noul: 0.05 }, off_goal: { noul: 0.05 }, claims_done: { noul: 0.6 }, 'phase_done__a': { noul: 0.95 }, 'phase_done__b': { noul: 0.05 },
    }
  const ask: AskFn = async questions => answers('verify' in questions)
  const f = folder({}, ask)
  const p = await started(f)
  f.files.set(p.flow, JSON.stringify({ ...FLOW, phases: FLOW.phases.map(({ check: _drop, ...rest }) => rest) }))
  const out = await flow.onStop(f.io, ROOT, { session_id: 's1', stop_hook_active: false, last_assistant_message: 'a.txt written' })
  expect(out.block).toContain("Now work on phase 'b'")
  const state = JSON.parse(f.files.get(p.state)!)
  expect(state.jev_calls).toBe(2)
  expect(state.history.at(-1).probs.verify).toEqual(['a', 0.95])
})
