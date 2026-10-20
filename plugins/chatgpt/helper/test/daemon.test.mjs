import assert from 'node:assert/strict'
import { test } from 'node:test'

import { LOGIN_GRACE_MS, PROFILE_BUSY, STOP_TRIES, TRIES, older, start, stop } from '../lib/daemon.mjs'
import { pathsOf } from '../lib/paths.mjs'

const paths = pathsOf('/h')

/** A socket whose `/health` answers each entry of `healths` in turn (undefined: nothing listens), then the last one. */
function fakeSocket(healths) {
  const calls = []
  const call = async (socket, route) => {
    calls.push(route)
    if (route === '/stop') return { status: 'ok' }
    const health = healths.length > 1 ? healths.shift() : healths[0]
    if (!health) throw new Error('ECONNREFUSED')
    return health
  }
  return { call, calls }
}

const pause = async () => {}

/** `start` with a free profile, no login in progress and everything installed, unless `deps` says otherwise. */
const starting = (call, deps = {}) => {
  let spawned = 0
  const result = start({
    paths,
    version: '1.0.0',
    call,
    pause,
    missing: () => undefined,
    profileHolder: () => undefined,
    loginAge: () => Number.POSITIVE_INFINITY,
    spawnServe: () => spawned++,
    ...deps,
  })
  return result.then(value => ({ value, spawned }))
}

test('older compares dotted versions number by number', () => {
  assert.equal(older('0.10.4', '0.11.0'), true)
  assert.equal(older('0.11.0', '0.10.4'), false)
  assert.equal(older('0.9.10', '0.10.0'), true)
  assert.equal(older('1.0.0', '1.0.0'), false)
  assert.equal(older('1.0', '1.0.1'), true)
})

test('a daemon of this version or newer already serving is used as is', async () => {
  for (const version of ['1.0.0', '1.2.0']) {
    const { call, calls } = fakeSocket([{ status: 'ok', version }])
    const { value, spawned } = await starting(call)
    assert.deepEqual(value, { status: 'ok' })
    assert.deepEqual(calls, ['/health'])
    assert.equal(spawned, 0)
  }
})

test('an older daemon is stopped, then a new one is spawned and waited for', async () => {
  const { call, calls } = fakeSocket([{ status: 'ok', version: '0.9.0' }, { status: 'ok', version: '0.9.0' }, undefined, undefined, { status: 'ok', version: '1.0.0' }])
  const { value, spawned } = await starting(call)
  assert.deepEqual(value, { status: 'ok' })
  assert.deepEqual(calls.slice(0, 3), ['/health', '/health', '/stop'])
  assert.equal(spawned, 1)
})

test('a daemon that is stopping is waited for before a new one starts', async () => {
  const { call, calls } = fakeSocket([{ status: 'stopping', version: '1.0.0' }, { status: 'stopping', version: '1.0.0' }, { status: 'stopping', version: '1.0.0' }, undefined, undefined, { status: 'ok', version: '1.0.0' }])
  const { value, spawned } = await starting(call)
  assert.deepEqual(value, { status: 'ok' })
  assert.ok(calls.includes('/stop'))
  assert.equal(spawned, 1)
})

test('with Playwright or Chromium missing nothing is spawned, and start says what is missing', async () => {
  const { value, spawned } = await starting(fakeSocket([undefined]).call, { missing: () => 'browser' })
  assert.deepEqual(value, { status: 'not-installed', missing: 'browser' })
  assert.equal(spawned, 0)
})

test('a profile another Chromium holds, or a login that just began, keeps start from spawning', async () => {
  const held = await starting(fakeSocket([undefined]).call, { profileHolder: () => 4242 })
  assert.deepEqual(held, { value: { status: 'error', message: PROFILE_BUSY }, spawned: 0 })
  const logging = await starting(fakeSocket([undefined]).call, { loginAge: () => LOGIN_GRACE_MS - 1 })
  assert.deepEqual(logging, { value: { status: 'error', message: PROFILE_BUSY }, spawned: 0 })
  const later = await starting(fakeSocket([undefined, { status: 'ok', version: '1.0.0' }]).call, { loginAge: () => LOGIN_GRACE_MS })
  assert.deepEqual(later, { value: { status: 'ok' }, spawned: 1 })
})

test('a daemon that never answers ends start with an error naming the log, after TRIES looks', async () => {
  const { call, calls } = fakeSocket([undefined])
  const { value } = await starting(call)
  assert.deepEqual(value, { status: 'error', message: 'the helper did not start; see /h/helper.log' })
  assert.equal(calls.length, 1 + TRIES)
})

test('a home too long for a socket is refused before anything is asked', async () => {
  const { call, calls } = fakeSocket([undefined])
  const { value } = await starting(call, { paths: pathsOf(`/${'x'.repeat(100)}`) })
  assert.equal(value.status, 'error')
  assert.match(value.message, /more than a Unix socket takes \(103\)/)
  assert.deepEqual(calls, [])
})

test('stop is true at once when nothing answers, and false when the daemon will not go after STOP_TRIES looks', async () => {
  assert.equal(await stop({ paths, call: fakeSocket([undefined]).call, pause }), true)
  const stuck = fakeSocket([{ status: 'ok', version: '1' }])
  assert.equal(await stop({ paths, call: stuck.call, pause }), false)
  assert.deepEqual(stuck.calls.slice(0, 3), ['/health', '/stop', '/health'])
  assert.equal(stuck.calls.filter(route => route === '/health').length, 1 + STOP_TRIES)
})
