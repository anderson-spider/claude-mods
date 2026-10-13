import assert from 'node:assert/strict'
import { test } from 'node:test'

import { Engine } from '../lib/engine.mjs'
import { RpcClient } from '../lib/rpc.mjs'
import { fakeChild, nominal, tick, until } from './fake-server.mjs'

const base = { caller: 'a1', role: 'digger', repo: '/repo', model: 'gpt-6-luna', effort: 'medium', prompt: 'do it' }

/** An engine over one fake server; `clock.t` is the engine's time. */
const world = (options = {}, limit) => {
  const fake = fakeChild(options)
  const clock = { t: 0 }
  let made = 0
  const engine = new Engine({
    createClient: () => (made++, new RpcClient(fake.child)),
    now: () => clock.t,
    resolve: nominal,
    ...(limit ? { limit } : {}),
  })

  return { fake, engine, clock, made: () => made }
}

const finish = async (engine, caller = 'a1') => {
  for (let i = 0; i < 200; i++) {
    const polled = engine.poll(caller)

    if (polled.status !== 'running') {
      return polled
    }

    await tick()
  }

  throw new Error('turn did not finish')
}

test('start then poll: one thread in the lane cwd with the fixed sandbox, and the turn answers with its text', async () => {
  const { fake, engine } = world({ autoComplete: true, text: 'all done' })

  assert.deepEqual(await engine.start({ ...base, instructions: 'be a digger' }), { status: 'started' })
  assert.deepEqual(fake.methods(), ['initialize', 'initialized', 'thread/start', 'turn/start'])
  assert.deepEqual(fake.params('thread/start')[0], {
    cwd: '/repo',
    model: 'gpt-6-luna',
    approvalPolicy: 'never',
    approvalsReviewer: 'user',
    sandbox: 'read-only',
    ephemeral: true,
    developerInstructions: 'be a digger',
  })
  assert.deepEqual(fake.params('turn/start')[0], {
    threadId: 'th-1',
    model: 'gpt-6-luna',
    effort: 'medium',
    sandboxPolicy: { type: 'readOnly', networkAccess: false },
    input: [{ type: 'text', text: 'do it', text_elements: [] }],
  })

  const result = await finish(engine)
  assert.deepEqual(result, { status: 'ok', turn: 'completed', text: 'all done', files: [], commands: [], declined: 0, error: null })
  assert.deepEqual(engine.poll('a1'), { status: 'idle' })
})

test('a follow-up for the same caller reuses its thread; a changed repository starts a new one', async () => {
  const { fake, engine } = world({ autoComplete: true })
  await engine.start(base)
  await finish(engine)
  await engine.start({ ...base, prompt: 'and then this' })
  await finish(engine)

  assert.equal(fake.params('thread/start').length, 1)
  assert.deepEqual(fake.params('turn/start').map(p => p.threadId), ['th-1', 'th-1'])

  await engine.start({ ...base, repo: '/other' })
  assert.equal(fake.params('thread/start').length, 2)
})

test('many callers share one server process, each with its own thread', async () => {
  const { fake, engine, made } = world({ autoComplete: true })
  await Promise.all(['a', 'b', 'c'].map(caller => engine.start({ ...base, caller })))

  assert.equal(made(), 1)
  assert.equal(fake.methods().filter(m => m === 'initialize').length, 1)
  assert.equal(new Set(fake.params('turn/start').map(p => p.threadId)).size, 3)
})

test('a second start for a running caller is busy, and a start past the limit is full', async () => {
  const { engine } = world({}, 2)
  assert.equal((await engine.start({ ...base, caller: 'a' })).status, 'started')
  assert.equal((await engine.start({ ...base, caller: 'a' })).status, 'busy')
  assert.equal((await engine.start({ ...base, caller: 'b' })).status, 'started')
  assert.equal((await engine.start({ ...base, caller: 'c' })).status, 'full')
  assert.deepEqual(engine.status(), { jobs: 2, threads: 2 })
  assert.equal(engine.poll('a').status, 'running')
})

test('interrupt asks the server to stop the turn and the poll then reports it interrupted', async () => {
  const { fake, engine } = world({})
  await engine.start(base)
  const answered = await engine.interrupt('a1')
  fake.emit({ method: 'turn/completed', params: { threadId: 'th-1', turn: { status: 'interrupted', error: null } } })

  assert.deepEqual(answered, { status: 'ok', interrupted: true })
  assert.deepEqual(fake.params('turn/interrupt'), [{ threadId: 'th-1', turnId: 'tn-2' }])
  assert.equal((await finish(engine)).turn, 'interrupted')
  assert.deepEqual(await engine.interrupt('a1'), { status: 'ok', interrupted: false })
})

test('a turn past its time limit is interrupted and reads as timeout; when the interrupt is refused it ends all the same', async () => {
  const w = world({})
  await w.engine.start(base)
  w.clock.t = 16 * 60_000
  await w.engine.sweep()
  w.fake.emit({ method: 'turn/completed', params: { threadId: 'th-1', turn: { status: 'interrupted', error: null } } })
  assert.equal((await finish(w.engine)).turn, 'timeout')

  const refused = world({ handlers: { 'turn/interrupt': () => new Error('no') } })
  await refused.engine.start(base)
  refused.clock.t = 16 * 60_000
  await refused.engine.sweep()
  assert.equal((await finish(refused.engine)).turn, 'timeout')
})

test('a server that exits ends the running turn as failed and the next start spawns a new server', async () => {
  const fake1 = fakeChild({ autoComplete: false })
  const fake2 = fakeChild({ autoComplete: true })
  const children = [fake1, fake2]
  const engine = new Engine({ createClient: () => new RpcClient(children.shift().child), resolve: nominal })
  await engine.start(base)
  fake1.exit()
  const lost = await finish(engine)

  assert.equal(lost.turn, 'failed')
  assert.match(lost.error, /exited/)
  assert.equal((await engine.start(base)).status, 'started')
  assert.equal((await finish(engine)).turn, 'completed')
  assert.equal(fake2.params('thread/start').length, 1)
})

test('an approval request from the server is refused and a declined item is counted', async () => {
  const { fake, engine } = world({})
  await engine.start(base)
  fake.emit({ id: 90, method: 'item/commandExecution/requestApproval', params: { threadId: 'th-1' } })
  fake.emit({ method: 'item/completed', params: { threadId: 'th-1', item: { type: 'commandExecution', command: 'rm', status: 'declined' } } })
  fake.emit({ method: 'turn/completed', params: { threadId: 'th-1', turn: { status: 'completed', error: null } } })

  assert.deepEqual(fake.replies[0], { id: 90, result: { decision: 'decline' } })
  assert.equal((await finish(engine)).declined, 1)
})

test('what is not a valid request is an error that names the field and starts nothing', async () => {
  const { fake, engine } = world({})
  const cases = [
    [{ ...base, role: 'designer' }, /role/],
    [{ ...base, repo: 'relative' }, /repo/],
    [{ ...base, repo: '/r/../x' }, /repo/],
    [{ ...base, model: 'a b' }, /model/],
    [{ ...base, prompt: '  ' }, /prompt/],
    [{ ...base, caller: '' }, /caller/],
    [{ ...base, instructions: 5 }, /instructions/],
    [null, /object/],
  ]

  for (const [input, pattern] of cases) {
    const answered = await engine.start(input)
    assert.equal(answered.status, 'error')
    assert.match(answered.message, pattern)
  }

  assert.deepEqual(fake.methods(), [])
})

test('reset interrupts the turn, forgets the thread and the next start makes a new one', async () => {
  const { fake, engine } = world({})
  await engine.start(base)
  assert.deepEqual(await engine.reset('a1'), { status: 'ok' })
  assert.equal(fake.params('turn/interrupt').length, 1)
  assert.deepEqual(engine.status(), { jobs: 0, threads: 0 })
  await engine.start(base)
  assert.equal(fake.params('thread/start').length, 2)
})

test('threads past the cap are dropped oldest first, never one with a turn running', async () => {
  const fake = fakeChild({ autoComplete: true })
  const engine = new Engine({ createClient: () => new RpcClient(fake.child), keepThreads: 2, resolve: nominal })
  for (const caller of ['a', 'b', 'c']) {
    await engine.start({ ...base, caller })
    await finish(engine, caller)
  }

  assert.equal(engine.status().threads, 2)
  await engine.start({ ...base, caller: 'a' })
  assert.equal(fake.params('thread/start').length, 4)
})

test('a failing thread/start is an error reply, and the caller can start again', async () => {
  let fail = true
  const fake = fakeChild({ autoComplete: true, handlers: { 'thread/start': () => (fail ? new Error('no model') : { thread: { id: 'th-9' } }) } })
  const engine = new Engine({ createClient: () => new RpcClient(fake.child), resolve: nominal })
  const first = await engine.start(base)
  fail = false

  assert.equal(first.status, 'error')
  assert.match(first.message, /no model/)
  assert.equal((await engine.start(base)).status, 'started')
  await until(() => engine.poll('a1').status === 'ok')
})

test('the lane is resolved on every start: a cwd that changed between turns gets a new thread, and a refused one starts nothing', async () => {
  let cwd = '/real/a'
  const fake = fakeChild({ autoComplete: true })
  const engine = new Engine({ createClient: () => new RpcClient(fake.child), resolve: () => (cwd === null ? { ok: false, message: 'repo contains or is inside a directory crew protects' } : { ok: true, cwd }) })
  await engine.start(base)
  await finish(engine)
  cwd = '/real/b'
  await engine.start(base)
  await finish(engine)

  assert.deepEqual(fake.params('thread/start').map(p => p.cwd), ['/real/a', '/real/b'])
  cwd = null
  const refused = await engine.start(base)
  assert.equal(refused.status, 'error')
  assert.match(refused.message, /protects/)
  assert.equal(fake.params('turn/start').length, 2)
})

test('an interrupt the server never confirms ends the turn after the grace period and drops the thread, so the slot frees', async () => {
  const w = world({}, 1)
  await w.engine.start(base)
  await w.engine.interrupt('a1')
  w.clock.t = 31_000
  await w.engine.sweep()

  const ended = await finish(w.engine)
  assert.equal(ended.turn, 'timeout')
  assert.deepEqual(w.engine.status(), { jobs: 0, threads: 0 })
  assert.equal((await w.engine.start({ ...base, caller: 'other' })).status, 'started')
})

test('a server that never answers a request rejects it, so a start is an error and not a hang', async () => {
  const fake = fakeChild({ handlers: { initialize: () => 'silent' } })
  const engine = new Engine({ createClient: () => new RpcClient(fake.child, { timeoutMs: 20 }), resolve: nominal })
  const answered = await engine.start(base)

  assert.equal(answered.status, 'error')
  assert.match(answered.message, /did not answer/)
  assert.equal(fake.ended, true, 'the server that never initialized is stopped')
})

test('a prompt or instructions past the limit is refused, and an effort that is not known is not sent', async () => {
  const { fake, engine } = world({ autoComplete: true })

  assert.equal((await engine.start({ ...base, prompt: 'x'.repeat(200_001) })).status, 'error')
  assert.equal((await engine.start({ ...base, instructions: 'x'.repeat(50_001) })).status, 'error')
  assert.equal((await engine.start({ ...base, effort: 'ultra' })).status, 'started')
  assert.equal('effort' in fake.params('turn/start')[0], false)
})
