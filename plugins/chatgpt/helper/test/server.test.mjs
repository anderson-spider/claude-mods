import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { post } from '../lib/daemon.mjs'
import { pathsOf } from '../lib/paths.mjs'
import { ROUTE_TABLE, answer, serve } from '../lib/server.mjs'

// A short home in the system temp folder: a Unix socket path holds about 100 bytes.
const home = t => {
  const dir = mkdtempSync(join(tmpdir(), 'cgpt-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return pathsOf(dir)
}

function fakeDriver(overrides = {}) {
  const calls = []
  const driver = {
    tabs: async () => (calls.push(['tabs']), ['1']),
    open: async url => (calls.push(['open', url]), '2'),
    wait: async (tab, fn, timeoutMs) => (calls.push(['wait', tab, fn, timeoutMs]), true),
    eval: async (tab, body) => (calls.push(['eval', tab, body]), '{"a":1}'),
    upload: async (tab, selector, files) => calls.push(['upload', tab, selector, files]),
    close: async () => calls.push(['close']),
    ...overrides,
  }
  return { driver, calls }
}

test('the route table holds exactly the routes the hooks call', () => {
  assert.deepEqual(Object.keys(ROUTE_TABLE), ['/health', '/tabs', '/open', '/wait', '/eval', '/upload'])
  assert.ok(Object.isFrozen(ROUTE_TABLE))
})

test('each route passes its body to the driver and answers with status ok', async () => {
  const { driver, calls } = fakeDriver()
  assert.deepEqual(await answer(driver, '/health', {}, '1.2.3'), { status: 'ok', version: '1.2.3' })
  assert.deepEqual(await answer(driver, '/tabs', {}), { status: 'ok', tabs: ['1'] })
  assert.deepEqual(await answer(driver, '/open', { url: 'https://chatgpt.com/' }), { status: 'ok', tab: '2' })
  assert.deepEqual(await answer(driver, '/wait', { tab: '2', fn: 'true', timeoutMs: 100 }), { status: 'ok', ok: true })
  assert.deepEqual(await answer(driver, '/eval', { tab: '2', body: 'return 1' }), { status: 'ok', value: '{"a":1}' })
  const files = [{ name: 'a.txt', type: 'text/plain', path: '/a.txt' }]
  assert.deepEqual(await answer(driver, '/upload', { tab: '2', selector: 'input', files }), { status: 'ok' })
  assert.deepEqual(calls, [['tabs'], ['open', 'https://chatgpt.com/'], ['wait', '2', 'true', 100], ['eval', '2', 'return 1'], ['upload', '2', 'input', files]])
})

test('a page value of undefined crosses as null; a driver that throws and an unknown route answer status error', async () => {
  const { driver } = fakeDriver({ eval: async () => undefined, tabs: async () => Promise.reject(new Error('the login window is open\nstack')) })
  assert.deepEqual(await answer(driver, '/eval', { tab: '1', body: '' }), { status: 'ok', value: null })
  assert.deepEqual(await answer(driver, '/tabs', {}), { status: 'error', message: 'the login window is open' })
  assert.deepEqual(await answer(driver, '/stop', {}), { status: 'error', message: 'no route /stop' })
  assert.deepEqual(await answer(driver, 'constructor', {}), { status: 'error', message: 'no route constructor' })
})

test('serve answers over a socket only this user can reach, and /stop closes the browser, removes the socket and exits', async t => {
  const paths = home(t)
  const { driver, calls } = fakeDriver()
  const exits = []
  let exited
  const done = new Promise(resolve => (exited = resolve))
  await serve({ driver, paths, version: '9.9.9', idleMs: 60_000, exit: code => (exits.push(code), exited()), log: () => {} })

  assert.equal(statSync(paths.run).mode & 0o777, 0o700)
  assert.equal(statSync(paths.socket).mode & 0o777, 0o600)
  assert.deepEqual(await post(paths.socket, '/health'), { status: 'ok', version: '9.9.9' })
  assert.deepEqual(await post(paths.socket, '/open', { url: 'https://chatgpt.com/' }), { status: 'ok', tab: '2' })
  assert.deepEqual(await post(paths.socket, '/stop'), { status: 'ok' })
  await done
  assert.deepEqual(exits, [0])
  assert.deepEqual(calls.at(-1), ['close'])
  assert.equal(existsSync(paths.socket), false)
})

test('a body that is not JSON answers status error and the daemon keeps serving', async t => {
  const paths = home(t)
  const { driver } = fakeDriver()
  const { shutdown } = await serve({ driver, paths, version: '1', idleMs: 60_000, exit: () => {}, log: () => {} })
  t.after(() => shutdown('test'))
  const reply = await new Promise((resolve, reject) => {
    import('node:http').then(({ request }) => {
      const req = request({ socketPath: paths.socket, path: '/tabs', method: 'POST' }, res => {
        let text = ''
        res.on('data', chunk => (text += chunk))
        res.on('end', () => resolve(JSON.parse(text)))
      })
      req.on('error', reject)
      req.end('{not json')
    })
  })
  assert.equal(reply.status, 'error')
  assert.deepEqual(await post(paths.socket, '/tabs'), { status: 'ok', tabs: ['1'] })
})

test('with no request for idleMs the daemon stops by itself; a request in flight holds it', async t => {
  const paths = home(t)
  let release
  const held = new Promise(resolve => (release = resolve))
  const { driver, calls } = fakeDriver({ wait: async () => (await held, true) })
  let exited
  const done = new Promise(resolve => (exited = resolve))
  await serve({ driver, paths, version: '1', idleMs: 50, exit: () => exited(), log: () => {} })

  const waiting = post(paths.socket, '/wait', { tab: '1', fn: 'true', timeoutMs: 1000 })
  await new Promise(resolve => setTimeout(resolve, 150))
  assert.equal(existsSync(paths.socket), true)
  release()
  assert.deepEqual(await waiting, { status: 'ok', ok: true })
  await done
  assert.deepEqual(calls.at(-1), ['close'])
  assert.equal(existsSync(paths.socket), false)
})

test('serve refuses while another daemon answers on the socket, and clears a stale socket file', async t => {
  const paths = home(t)
  const first = await serve({ driver: fakeDriver().driver, paths, version: '1', idleMs: 60_000, exit: () => {}, log: () => {} })
  await assert.rejects(serve({ driver: fakeDriver().driver, paths, version: '2', idleMs: 60_000, exit: () => {}, log: () => {} }), /already answers/)
  await first.shutdown('test')

  mkdirSync(paths.run, { recursive: true })
  writeFileSync(paths.socket, '')
  const second = await serve({ driver: fakeDriver().driver, paths, version: '2', idleMs: 60_000, exit: () => {}, log: () => {} })
  assert.deepEqual(await post(paths.socket, '/health'), { status: 'ok', version: '2' })
  await second.shutdown('test')
})

test('a home too long for a Unix socket is refused before listening', async () => {
  const paths = pathsOf(`/${'x'.repeat(100)}`)
  await assert.rejects(serve({ driver: fakeDriver().driver, paths, version: '1', idleMs: 1, exit: () => {}, log: () => {} }), /more than a Unix socket takes/)
})
