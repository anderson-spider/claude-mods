import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { handler, ROUTE_TABLE, ROUTES } from '../helper.mjs'
import { LANES } from '../lib/lanes.mjs'
import { contract } from './contract.mjs'
import { engineWith, envWith, send, stubEngine } from './support.mjs'

// The helper's half of the contract with hooks/appserver.ts, over the examples in contract.mjs; the plugin's half is
// tests/contract.test.ts.
const HERE = dirname(fileURLToPath(import.meta.url))
const keys = value => Object.keys(value).sort()

test('the helper serves exactly the routes the shared contract lists, each from the frozen table', async () => {
  assert.deepEqual(ROUTES, contract.routes)
  assert.deepEqual(Object.keys(ROUTE_TABLE).sort(), Object.values(contract.routes).sort())
  assert.ok(Object.isFrozen(ROUTE_TABLE))
  assert.ok(Object.values(ROUTE_TABLE).every(Object.isFrozen))
  assert.equal(typeof handler(stubEngine(), envWith()), 'function')
})

test('the helper accepts every caller the examples name, up to the limit, and refuses every shape marked as not one', async () => {
  for (const { caller } of contract.callers) {
    assert.equal((await send('/poll', { caller }, { engine: stubEngine() })).status, 200, JSON.stringify(caller))
  }

  assert.equal((await send('/poll', { caller: 'a'.repeat(contract.maxPart) }, { engine: stubEngine() })).status, 200)
  assert.equal((await send('/poll', { caller: 'a'.repeat(contract.maxPart + 1) }, { engine: stubEngine() })).status, 400)

  for (const refused of [...contract.notCallers, undefined, null, 7, ['a']]) {
    const answered = await send('/poll', { caller: refused }, { engine: stubEngine() })
    assert.equal(answered.status, 400, JSON.stringify(refused))
    assert.equal(answered.body.status, 'error')
  }
})

test('the roles the helper has a lane for are the roles the contract lists', () => {
  assert.deepEqual(Object.keys(LANES).sort(), [...contract.roles].sort())
})

test('every reply has the key set the contract lists', async () => {
  const { engine } = engineWith()
  const body = { caller: 'a1', role: 'developer', repo: '/repo', model: 'gpt-6-sol', effort: 'low', instructions: 'i', prompt: 'p' }

  assert.deepEqual(keys(body), [...contract.startRequest].sort())
  const started = await send('/start', body, { engine })
  assert.deepEqual(keys(started.body), contract.replies.start.started)
  assert.deepEqual(keys((await send('/start', body, { engine })).body), contract.replies.start.busy)
  assert.deepEqual(keys((await send('/start', { ...body, caller: 'a2', role: 'x' }, { engine })).body), contract.replies.start.error)
  assert.deepEqual(keys((await send('/poll', { caller: 'a1' }, { engine })).body), contract.replies.poll.running)
  assert.deepEqual(keys((await send('/poll', { caller: 'nobody' }, { engine })).body), contract.replies.poll.idle)

  // The real engine's turn ends by itself: poll it until it has.
  let finished
  for (let i = 0; i < 100 && finished === undefined; i++) {
    const polled = (await send('/poll', { caller: 'a1' }, { engine })).body
    finished = polled.status === 'ok' ? polled : undefined
    await new Promise(resolve => setImmediate(resolve))
  }
  assert.deepEqual(keys(finished), contract.replies.poll.ok)

  assert.deepEqual(keys((await send('/interrupt', { caller: 'a1' }, { engine })).body), contract.replies.interrupt.ok)
  assert.deepEqual(keys((await send('/reset', { caller: 'a1' }, { engine })).body), contract.replies.reset.ok)
  assert.deepEqual(keys((await send('/status', undefined, { engine, method: 'GET' })).body), contract.replies.status.ok)
  assert.deepEqual(keys(contract.examples.pollOk), contract.replies.poll.ok)
  assert.deepEqual(keys(contract.examples.status), contract.replies.status.ok)
})

test('a full helper answers with its message and the full key set', async () => {
  const { engine } = engineWith({ autoComplete: false })
  const body = { role: 'developer', repo: '/repo', model: 'gpt-6-sol', prompt: 'p' }

  for (const caller of ['a', 'b', 'c', 'd']) {
    assert.equal((await send('/start', { ...body, caller }, { engine })).body.status, 'started')
  }

  const full = await send('/start', { ...body, caller: 'e' }, { engine })
  assert.deepEqual(keys(full.body), contract.replies.start.full)
  assert.equal(full.body.status, 'full')
})

// Static, so nothing is started: where install.sh installs the helper plus where helper.mjs puts its socket beside itself.
test('install.sh and helper.mjs place the socket where the shared socket path says', () => {
  const install = readFileSync(join(HERE, '..', 'install.sh'), 'utf8')
  const installedUnder = dirname(dirname(contract.socketUnderHome))

  assert.match(install, new RegExp(`^TARGET="\\$HOME/${installedUnder.replaceAll('.', '\\.')}"$`, 'm'))
  assert.match(install, /mkdir -p "\$TARGET\/state" "\$TARGET\/run"/)

  const source = readFileSync(join(HERE, '..', 'helper.mjs'), 'utf8')
  assert.equal(contract.socketUnderHome, `${installedUnder}/run/helper.sock`)
  assert.match(source, /const RUN = join\(HERE, 'run'\)/)
  assert.match(source, /const SOCKET = join\(RUN, 'helper\.sock'\)/)
})

test('install.sh and uninstall.sh declare the label the plugin kickstarts', () => {
  for (const file of ['install.sh', 'uninstall.sh']) {
    assert.match(readFileSync(join(HERE, '..', file), 'utf8'), new RegExp(`^LABEL=${contract.label.replaceAll('.', '\\.')}$`, 'm'), file)
  }
})
