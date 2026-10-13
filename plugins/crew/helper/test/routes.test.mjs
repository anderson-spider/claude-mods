import assert from 'node:assert/strict'
import { test } from 'node:test'

import { send, stubEngine } from './support.mjs'

// The checks run in this order: /status (any method), POST only, the JSON body, the caller, then the route.

test('/status answers any method with no body and no caller, and reports the binary and login the process found', async () => {
  const get = await send('/status', undefined, { engine: stubEngine(), method: 'GET' })
  assert.equal(get.status, 200)
  assert.deepEqual({ codex: get.body.codex, login: get.body.login, jobs: get.body.jobs }, { codex: true, login: true, jobs: 0 })

  const none = await send('/status', {}, { engine: stubEngine(), env: { codex: () => undefined, login: () => false } })
  assert.deepEqual({ codex: none.body.codex, login: none.body.login }, { codex: false, login: false })
})

test('a route that is not /status takes POST only, then a JSON object, then a valid caller, then it is looked up', async () => {
  const engine = stubEngine()

  assert.equal((await send('/start', { caller: 'a' }, { engine, method: 'GET' })).status, 405)
  assert.equal((await send('/start', undefined, { engine, raw: '{not json' })).status, 500)
  assert.equal((await send('/start', undefined, { engine, raw: 'null' })).status, 400)
  assert.equal((await send('/poll', { caller: '../x' }, { engine })).status, 400)
  assert.equal((await send('/nope', { caller: 'a' }, { engine })).status, 404)
  assert.equal((await send('/nope', { caller: '' }, { engine })).status, 400, 'a bad caller answers before the 404')
  assert.deepEqual(engine.seen, [])
})

test('each route reaches its own engine method once, with the caller or the body', async () => {
  const engine = stubEngine()
  const body = { caller: 'a1', role: 'developer' }

  await send('/start', body, { engine })
  await send('/poll', { caller: 'a1' }, { engine })
  await send('/interrupt', { caller: 'a1' }, { engine })
  await send('/reset', { caller: 'a1' }, { engine })

  assert.deepEqual(engine.seen, [['start', body], ['poll', 'a1'], ['interrupt', 'a1'], ['reset', 'a1']])
})

test('a start the engine refuses as invalid is a 400 with its message; a busy or full one is a 200 the caller reads', async () => {
  const engine = { start: async () => ({ status: 'error', message: 'role must be developer or architect' }) }
  const refused = await send('/start', { caller: 'a1', role: 'x' }, { engine })

  assert.equal(refused.status, 400)
  assert.equal(refused.body.message, 'role must be developer or architect')
  assert.equal((await send('/start', { caller: 'a1' }, { engine: { start: async () => ({ status: 'busy' }) } })).status, 200)
})

test('an engine that throws answers 500 with the message and no stack', async () => {
  const engine = { poll: () => { throw new Error('boom') } }
  const answered = await send('/poll', { caller: 'a1' }, { engine })

  assert.deepEqual([answered.status, answered.body], [500, { status: 'error', message: 'boom' }])
})

test('a body over the size limit is refused before the engine sees it', async () => {
  const engine = stubEngine()
  const answered = await send('/start', undefined, { engine, raw: JSON.stringify({ caller: 'a1', prompt: 'x'.repeat(1_100_000) }) })

  assert.equal(answered.status, 500)
  assert.match(answered.body.message, /too large/)
  assert.deepEqual(engine.seen, [])
})
