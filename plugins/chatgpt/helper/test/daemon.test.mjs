import assert from 'node:assert/strict'
import { test } from 'node:test'

import { TRIES, start, stop } from '../lib/daemon.mjs'
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

test('a daemon of this version already serving is left alone', async () => {
  const { call, calls } = fakeSocket([{ status: 'ok', version: '1.0.0' }])
  let spawned = 0
  const result = await start({ paths, version: '1.0.0', call, pause, missing: () => undefined, spawnServe: () => spawned++ })
  assert.deepEqual(result, { status: 'ok' })
  assert.deepEqual(calls, ['/health'])
  assert.equal(spawned, 0)
})

test('a daemon of another version is stopped, then a new one is spawned and waited for', async () => {
  const { call, calls } = fakeSocket([{ status: 'ok', version: '0.9.0' }, { status: 'ok', version: '0.9.0' }, undefined, undefined, { status: 'ok', version: '1.0.0' }])
  let spawned = 0
  const result = await start({ paths, version: '1.0.0', call, pause, missing: () => undefined, spawnServe: () => spawned++ })
  assert.deepEqual(result, { status: 'ok' })
  assert.deepEqual(calls, ['/health', '/health', '/stop', '/health', '/health', '/health'])
  assert.equal(spawned, 1)
})

test('with Playwright or Chromium missing nothing is spawned, and start says what is missing', async () => {
  const { call } = fakeSocket([undefined])
  let spawned = 0
  const result = await start({ paths, version: '1', call, pause, missing: () => 'browser', spawnServe: () => spawned++ })
  assert.deepEqual(result, { status: 'not-installed', missing: 'browser' })
  assert.equal(spawned, 0)
})

test('a daemon that never answers ends start with an error naming the log, after TRIES looks', async () => {
  const { call, calls } = fakeSocket([undefined])
  const result = await start({ paths, version: '1', call, pause, missing: () => undefined, spawnServe: () => {} })
  assert.deepEqual(result, { status: 'error', message: 'the helper did not start; see /h/helper.log' })
  assert.equal(calls.length, 1 + TRIES)
})

test('a home too long for a socket is refused before anything is asked', async () => {
  const { call, calls } = fakeSocket([undefined])
  const result = await start({ paths: pathsOf(`/${'x'.repeat(100)}`), version: '1', call, pause, missing: () => undefined, spawnServe: () => {} })
  assert.equal(result.status, 'error')
  assert.match(result.message, /more than a Unix socket takes \(103\)/)
  assert.deepEqual(calls, [])
})

test('stop is true at once when nothing answers, and false when the daemon will not go', async () => {
  assert.equal(await stop({ paths, call: fakeSocket([undefined]).call, pause }), true)
  const stuck = fakeSocket([{ status: 'ok', version: '1' }])
  assert.equal(await stop({ paths, call: stuck.call, pause }), false)
  assert.deepEqual(stuck.calls.slice(0, 3), ['/health', '/stop', '/health'])
})
