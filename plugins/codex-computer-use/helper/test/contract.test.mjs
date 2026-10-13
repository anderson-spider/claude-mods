import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { handler, ROUTES } from '../helper.mjs'
import { CHOICES } from '../lib/approvals.mjs'
import { LEASE_MS } from '../lib/hub.mjs'
import { contract } from './contract.mjs'

// The helper's half of the contract with hooks/helper.ts, over the examples in
// contract.mjs; the plugin's half is tests/contract.test.ts.
const HERE = dirname(fileURLToPath(import.meta.url))

/** Runs the real `handler` on one request and reports what it answered; the hub is a stub, so only the handler's own routing and checks decide. */
const send = async (url, payload, { method = 'POST', hub } = {}) => {
  const request = Readable.from([Buffer.from(JSON.stringify(payload))])
  request.url = url
  request.method = method
  let status
  let body
  const response = {
    writeHead: code => (status = code),
    end: text => (body = JSON.parse(text)),
  }

  await handler(hub)(request, response)

  return { status, body }
}

/** One POST /release; the stub hub records what it was asked to release. */
const releaseStatus = async caller => {
  const released = []
  const hub = { release: value => (released.push(value), { status: 'ok', ended: [value] }) }

  return { ...(await send('/release', { caller }, { hub })), released }
}

/** A hub that answers every method the routes reach, and counts the calls per method. */
const stubHub = () => {
  const seen = []
  const note = name => (...args) => (seen.push(name), name === 'forget' ? { status: 'ok', bundleId: 'b', helper: true, codex: 'absent' } : { status: 'ok', args })

  return {
    seen,
    call: note('call'),
    reset: note('reset'),
    approve: note('approve'),
    release: note('release'),
    forget: note('forget'),
    status: () => (seen.push('status'), {}),
    approvals: { settings: { autoApprove: false, always: [] }, setAutoApprove: () => seen.push('settings') },
  }
}

test('the helper accepts every caller callerOf makes, and the session and agent parts up to the limit', async () => {
  for (const { caller } of contract.callers) {
    const answered = await releaseStatus(caller)
    assert.equal(answered.status, 200, `caller ${JSON.stringify(caller)}`)
    assert.deepEqual(answered.released, [caller])
  }

  const longest = 'a'.repeat(contract.maxPart)
  assert.equal((await releaseStatus(longest)).status, 200)
  assert.equal((await releaseStatus(`${longest}/${longest}`)).status, 200)
  assert.equal((await releaseStatus(`${longest}a`)).status, 400)
  assert.equal((await releaseStatus(`a/${longest}a`)).status, 400)
})

test('the helper refuses every shape the shared examples mark as not a caller, and a missing or non-string one', async () => {
  for (const refused of contract.notCallers) {
    const answered = await releaseStatus(refused)
    assert.equal(answered.status, 400, `caller ${JSON.stringify(refused)}`)
    assert.equal(answered.body.status, 'error')
    assert.deepEqual(answered.released, [])
  }

  for (const refused of [undefined, null, 7, ['a'], { caller: 'a' }]) {
    assert.equal((await releaseStatus(refused)).status, 400)
  }
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
  assert.match(source, /const STATE = join\(HERE, 'state'\)/)
  assert.doesNotMatch(source, /process\.env\.CODEX_CU_(RUN|STATE)_DIR/)
  assert.match(source, /const SOCKET = join\(RUN, 'helper\.sock'\)/)
})

test('the helper serves exactly the routes the shared contract lists, and no other', async () => {
  assert.deepEqual(ROUTES, contract.routes)

  for (const [name, path] of Object.entries(contract.routes)) {
    const hub = stubHub()
    const answered = await send(path, { caller: 's1', bundleId: 'com.x', choice: contract.choices[0], app: 'x', autoApprove: true }, { hub, method: path === '/status' ? 'GET' : 'POST' })

    assert.equal(answered.status, 200, `route ${name} (${path})`)
    assert.equal(hub.seen.length, 1, `route ${name} reaches one hub method`)
  }

  const refused = await send('/nope', { caller: 's1' }, { hub: stubHub() })
  assert.equal(refused.status, 404)
  assert.equal((await send('/call', { caller: 's1' }, { hub: stubHub(), method: 'GET' })).status, 405)

  // A path written as a literal beside ROUTES would be served without the contract listing it.
  const source = readFileSync(join(HERE, '..', 'helper.mjs'), 'utf8')
  const written = [...source.matchAll(/['"`](\/[a-z]+)['"`]/g)].map(found => found[1]).sort()

  assert.deepEqual(written, Object.values(contract.routes).sort(), 'each path is written once, in ROUTES')
})

test('the helper takes exactly the choices the shared contract lists', async () => {
  assert.deepEqual(CHOICES, contract.choices)

  for (const choice of contract.choices) {
    const hub = stubHub()

    assert.equal((await send('/approve', { caller: 's1', bundleId: 'com.x', choice }, { hub })).status, 200, choice)
    assert.deepEqual(hub.seen, ['approve'])
  }

  const hub = stubHub()
  const refused = await send('/approve', { caller: 's1', bundleId: 'com.x', choice: 'maybe' }, { hub })

  assert.equal(refused.status, 400)
  assert.equal(refused.body.message, `approve needs bundleId and choice ${contract.choices.join('|')}`)
  assert.deepEqual(hub.seen, [])
})

test('the helper holds an app for the lease the plugin tells the model', () => {
  assert.equal(LEASE_MS, contract.leaseMinutes * 60_000)
})

// Static, so no launchd is touched: the scripts that load and remove the LaunchAgent, and the label the plugin kickstarts.
test('install.sh and uninstall.sh declare the LaunchAgent label the shared contract names', () => {
  for (const script of ['install.sh', 'uninstall.sh']) {
    const text = readFileSync(join(HERE, '..', script), 'utf8')

    assert.deepEqual([...text.matchAll(/^LABEL=(.*)$/gm)].map(found => found[1]), [contract.label], script)
  }

  const install = readFileSync(join(HERE, '..', 'install.sh'), 'utf8')

  assert.match(install, /<key>Label<\/key><string>\$LABEL<\/string>/)
  assert.match(install, /launchctl bootstrap "\$DOMAIN" "\$PLIST"/)
})
