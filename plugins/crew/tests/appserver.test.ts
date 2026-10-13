import { expect, test } from 'claude-code/testing'
import { handedBackMessage, LABEL, MAX_POLLS, POLL, ROUTES, answerText, callerOf, helperReady, helperRole, kickstart, lastUserText, post, postStarting, runTurn, socketOf } from '../hooks/appserver'
import type { Probe, TurnRequest } from '../hooks/appserver'

type Call = { route: string; body: Record<string, unknown>; socketPath?: string }

/** A helper behind the probe: each route answers from `routes`, in order for a list; `run` records its argv. */
function world(routes: Record<string, unknown | unknown[] | (() => unknown)>, opts: { startsAfterKick?: boolean; runExit?: number } = {}) {
  const calls: Call[] = []
  const runs: string[][] = []
  const queues = new Map<string, unknown[]>()
  let kicked = false
  const probe: Probe = {
    fetch: async (url, init) => {
      const route = url.replace('http://crew-codex', '')
      calls.push({ route, body: JSON.parse(String(init.body ?? '{}')), socketPath: init.socketPath })
      if (opts.startsAfterKick && !kicked) throw new Error('connect ENOENT')
      const entry = routes[route]
      if (entry === undefined) throw new Error('connect ENOENT')
      let value: unknown = entry
      if (typeof entry === 'function') value = (entry as () => unknown)()
      else if (Array.isArray(entry)) {
        const queue = queues.get(route) ?? [...entry]
        queues.set(route, queue)
        value = queue.length > 1 ? queue.shift() : queue[0]
      }
      return { status: 200, ok: true, headers: {}, text: typeof value === 'string' ? value : JSON.stringify(value) }
    },
    run: async argv => {
      runs.push(argv)
      if (argv[0] === '/bin/launchctl') kicked = true
      return { exitCode: argv[0] === '/bin/launchctl' ? (opts.runExit ?? 0) : 0, stdout: argv[0] === '/usr/bin/id' ? '501\n' : '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
    },
  }
  return { probe, calls, runs }
}

const SOCKET = socketOf('/home/u')
const REQUEST: TurnRequest = { caller: 'a1', role: 'digger', repo: '/repo', model: 'gpt-6-luna', effort: 'high', instructions: 'be a digger', prompt: 'look it up' }
const DONE = { status: 'ok', turn: 'completed', text: 'all done', files: [], commands: [], declined: 0, error: null }
const never = () => false

test('the socket and label are fixed beside the installed helper', () => {
  expect(socketOf('/home/u')).toBe('/home/u/.claude/mcp/crew-codex/run/helper.sock')
  expect(LABEL).toBe('com.anderson-spider.crew-codex')
  expect(Object.values(ROUTES)).toEqual(['/start', '/poll', '/interrupt', '/reset', '/status'])
})

test('the digger, planner and challenger run on the helper; a caller is made safe for the helper\'s grammar', () => {
  expect(['digger-codex', 'digger', 'planner-codex', 'planner', 'challenger-codex', 'challenger'].map(helperRole)).toEqual([true, true, true, true, true, true])
  expect(['developer-codex', 'architect-codex', 'auditor', ''].map(helperRole)).toEqual([false, false, false, false])
  expect(callerOf('agent id/1')).toBe('agent_id_1')
  expect(callerOf('___')).toBe('x')
  expect(callerOf('a'.repeat(300)).length).toBe(128)
})

test('post sends JSON over the socket, answers the helper\'s reply and never rejects', async () => {
  const w = world({ '/status': { status: 'ok', version: '1' } })
  expect(await post(w.probe, SOCKET, '/status', { a: 1 })).toEqual({ status: 'ok', version: '1' })
  expect(w.calls).toEqual([{ route: '/status', body: { a: 1 }, socketPath: SOCKET }])
  expect(await post(world({}).probe, SOCKET, '/start', {})).toMatchObject({ status: 'unreachable' })
  expect(await post(world({ '/start': 'not json' }).probe, SOCKET, '/start', {})).toMatchObject({ status: 'error' })
  expect(await post(world({ '/start': { nope: 1 } }).probe, SOCKET, '/start', {})).toMatchObject({ status: 'error' })
})

test('postStarting asks launchd once when nothing listens, then polls until the helper answers', async () => {
  const w = world({ '/start': { status: 'started' } }, { startsAfterKick: true })
  expect(await postStarting(w.probe, SOCKET, '/start', REQUEST)).toEqual({ status: 'started' })
  expect(w.runs.filter(argv => argv[0] === '/bin/launchctl')).toEqual([['/bin/launchctl', 'kickstart', `gui/501/${LABEL}`]])
  const failed = world({}, { runExit: 1 })
  expect(await postStarting(failed.probe, SOCKET, '/start', REQUEST)).toMatchObject({ status: 'unreachable' })
  expect(await kickstart(failed.probe)).toBe(false)
})

test('the helper is ready only when it runs and found a binary and a login; each lack has its own reason', async () => {
  const status = (over: Record<string, unknown>) => world({ '/status': { status: 'ok', version: '1', pid: 1, jobs: 0, threads: 0, codex: true, login: true, ...over } }).probe
  expect(await helperReady(status({}), SOCKET)).toEqual({ ready: true })
  expect(await helperReady(status({ codex: false }), SOCKET)).toEqual({ ready: false, reason: 'the crew Codex helper found no codex binary' })
  expect(await helperReady(status({ login: false }), SOCKET)).toMatchObject({ ready: false, reason: expect.stringContaining('codex login') })
  expect(await helperReady(world({}).probe, SOCKET)).toMatchObject({ ready: false, reason: expect.stringContaining('install.sh') })
  expect(await helperReady(world({ '/status': { status: 'error', message: 'x' } }).probe, SOCKET)).toMatchObject({ ready: false })
})

test('a completed turn is its text, with the files it changed and what the sandbox refused noted after it', () => {
  const done = (over: Record<string, unknown>) => ({ ...DONE, ...over }) as never
  expect(answerText(done({}))).toBe('all done')
  expect(answerText(done({ text: '  ' }))).toBe('The Codex turn ended without a message.')
  expect(answerText(done({ files: [{ status: 'completed', paths: ['/repo/a.ts'] }, { status: 'declined', paths: ['/x'] }], declined: 2 }))).toBe(
    "all done\n\n(crew: files changed: /repo/a.ts; 2 actions were refused outside this role's lane)",
  )
  expect(answerText(done({ declined: 1 }))).toContain('1 action was refused')
  expect(answerText(done({ files: [{ status: 'completed', paths: ['/repo/a.ts'] }, { status: 'completed', paths: ['/repo/a.ts'] }] }))).toBe('all done\n\n(crew: files changed: /repo/a.ts)')
})

test('a turn starts with the request, polls until it ends and answers its text', async () => {
  const w = world({ '/start': { status: 'started' }, '/poll': [{ status: 'running', seconds: 1 }, { status: 'running', seconds: 2 }, DONE] })
  expect(await runTurn(w.probe, SOCKET, REQUEST, never)).toEqual({ kind: 'text', text: 'all done' })
  expect(w.calls[0]).toEqual({ route: '/start', body: REQUEST, socketPath: SOCKET })
  expect(w.calls.filter(call => call.route === '/poll').map(call => call.body)).toEqual([{ caller: 'a1' }, { caller: 'a1' }, { caller: 'a1' }])
  expect(w.runs.filter(argv => argv[0] === 'sleep')).toEqual([POLL, POLL])
})

test('a turn that does not complete, a busy or full helper and a lost turn each fail with a reason', async () => {
  const run = (routes: Record<string, unknown>) => runTurn(world(routes).probe, SOCKET, REQUEST, never)
  expect(await run({ '/start': { status: 'started' }, '/poll': { ...DONE, turn: 'timeout' } })).toEqual({ kind: 'failed', reason: 'the Codex turn timeout' })
  expect(await run({ '/start': { status: 'started' }, '/poll': { ...DONE, turn: 'failed', error: 'boom' } })).toEqual({ kind: 'failed', reason: 'the Codex turn failed: boom' })
  expect(await run({ '/start': { status: 'busy' } })).toMatchObject({ kind: 'failed', reason: expect.stringContaining('already has a Codex turn') })
  expect(await run({ '/start': { status: 'full', message: '4 turns are already running' } })).toMatchObject({ kind: 'failed', reason: expect.stringContaining('full: 4 turns') })
  expect(await run({ '/start': { status: 'error', message: 'role must be digger' } })).toMatchObject({ kind: 'failed', reason: expect.stringContaining('role must be') })
  expect(await run({ '/start': { status: 'started' }, '/poll': { status: 'idle' } })).toMatchObject({ kind: 'failed', reason: expect.stringContaining('lost the turn') })
  expect(await run({})).toMatchObject({ kind: 'failed', reason: expect.stringContaining('install.sh') })
})

test('an abort interrupts the helper\'s turn and ends the wait', async () => {
  const w = world({ '/start': { status: 'started' }, '/poll': { status: 'running', seconds: 0 }, '/interrupt': { status: 'ok', interrupted: true } })
  let polls = 0
  const aborted = () => polls++ > 1
  expect(await runTurn(w.probe, SOCKET, REQUEST, aborted)).toEqual({ kind: 'aborted' })
  expect(w.calls.at(-1)).toEqual({ route: '/interrupt', body: { caller: 'a1' }, socketPath: SOCKET })
})

test('a turn that outlasts the wait is interrupted and fails', async () => {
  const w = world({ '/start': { status: 'started' }, '/poll': { status: 'running', seconds: 0 }, '/interrupt': { status: 'ok', interrupted: true } })

  expect(await runTurn(w.probe, SOCKET, REQUEST, never, 3)).toEqual({ kind: 'failed', reason: 'the Codex turn took too long' })
  expect(w.calls.filter(call => call.route === '/poll')).toHaveLength(3)
  expect(w.calls.at(-1)?.route).toBe('/interrupt')
  expect(MAX_POLLS).toBeGreaterThan(600)
})

test('the next request is the last user message\'s text; tool results and empty messages are skipped', () => {
  const user = (...content: Record<string, unknown>[]) => ({ role: 'user', content }) as never
  expect(lastUserText([user({ type: 'text', text: 'first' }), { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }, user({ type: 'text', text: 'second' }, { type: 'text', text: 'more' })])).toBe('second\nmore')
  expect(lastUserText([user({ type: 'text', text: 'asked' }), user({ type: 'tool_result', tool_use_id: 'x', content: 'r' })])).toBe('asked')
  expect(lastUserText([])).toBeUndefined()
})

test('an abort before the start asks the helper nothing', async () => {
  const w = world({ '/start': { status: 'started' } })

  expect(await runTurn(w.probe, SOCKET, REQUEST, () => true)).toEqual({ kind: 'aborted' })
  expect(w.calls).toEqual([])
})

test('the host\'s system reminders are not the request', () => {
  const user = (...content: Record<string, unknown>[]) => ({ role: 'user', content }) as never
  expect(lastUserText([user({ type: 'text', text: 'do it\n<system-reminder>SubagentHandback: report</system-reminder>' })])).toBe('do it')
})

test('a conversation that ends with the result of crew\'s own handback gives its message back, and new text after it is new work', () => {
  const call = { role: 'assistant', content: [{ type: 'tool_use', id: 'crew_handback_t1_0', name: 'SubagentHandback', input: { message: 'the report' } }] } as never
  const result = { type: 'tool_result', tool_use_id: 'crew_handback_t1_0', content: 'refused' }
  const user = (...content: Record<string, unknown>[]) => ({ role: 'user', content }) as never

  expect(handedBackMessage([user({ type: 'text', text: 'x' }), call, user(result)])).toBe('the report')
  expect(handedBackMessage([call, user(result, { type: 'text', text: '<system-reminder>r</system-reminder>' })])).toBe('the report')
  // The engine may merge a SendMessage into the result's message: that is a request, and runs.
  expect(handedBackMessage([call, user(result, { type: 'text', text: 'and what did you change?' })])).toBeUndefined()
  expect(handedBackMessage([user({ type: 'tool_result', tool_use_id: 'toolu_1', content: 'r' })])).toBeUndefined()
  expect(handedBackMessage([])).toBeUndefined()
})
