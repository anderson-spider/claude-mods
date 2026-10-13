import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { handler, ROUTE_TABLE, ROUTES } from '../helper.mjs'
import { CHOICES } from '../lib/approvals.mjs'
import { LEASE_MS } from '../lib/hub.mjs'
import { contract } from './contract.mjs'
import { hubWith, send, stubHub } from './support.mjs'

// The helper's half of the contract with hooks/helper.ts, over the examples in
// contract.mjs; the plugin's half is tests/contract.test.ts.
const HERE = dirname(fileURLToPath(import.meta.url))

/** One POST /release; the stub hub records what it was asked to release. */
const releaseStatus = async caller => {
  const released = []
  const hub = { release: value => (released.push(value), { status: 'ok', ended: [value] }) }

  return { ...(await send('/release', { caller }, { hub })), released }
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
  assert.deepEqual(Object.keys(ROUTE_TABLE).sort(), Object.values(contract.routes).sort(), 'the route table has one entry per contract route')

  for (const [name, path] of Object.entries(contract.routes)) {
    const hub = stubHub()
    const answered = await send(path, { caller: 's1', bundleId: 'com.x', choice: contract.choices[0], app: 'x', autoApprove: true }, { hub, method: path === '/status' ? 'GET' : 'POST' })

    assert.equal(answered.status, 200, `route ${name} (${path})`)
    assert.deepEqual(hub.seen, [name], `route ${name} reaches its own hub method, once`)
  }

  const refused = await send('/nope', { caller: 's1' }, { hub: stubHub() })
  assert.equal(refused.status, 404)
  assert.equal((await send('/call', { caller: 's1' }, { hub: stubHub(), method: 'GET' })).status, 405)

  // The table is the only place a path is served: routing on the url written in the handler would serve a route the contract does not list.
  assert.deepEqual(routingOnUrl(handler.toString()), [], 'the handler looks routes up in ROUTE_TABLE only')
  assert.ok(Object.isFrozen(ROUTE_TABLE), 'a route cannot be added once the module is loaded')
  assert.ok(Object.values(ROUTE_TABLE).every(Object.isFrozen), 'a route cannot be changed once the module is loaded')
})

/** The ways a handler's source can pick a route from `request.url` other than the table lookup; empty when it does not. */
const routingOnUrl = source =>
  Object.entries({
    comparison: /request\.url\s*[!=]==?/,
    'switch on the url': /switch\s*\(\s*request\.url\s*\)/,
    'string method on the url': /request\.url\s*\??\.\s*(startsWith|endsWith|includes|match|test|slice|indexOf|split|replace)\s*\(/,
    'startsWith routing': /\.\s*startsWith\s*\(/,
    'url passed to a matcher': /\.\s*(test|includes|match|has)\s*\(\s*request\.url\b/,
    'url copied to a name': /(?:const|let|var)\s+\w+\s*=\s*request\.url\b|\burl\b[^=\n]*\}\s*=\s*request\b/,
  })
    .filter(([, pattern]) => pattern.test(source))
    .map(([name]) => name)

test('the guard on how the handler routes catches each way of choosing a route by the url, and passes the table lookup', () => {
  const lookup = 'async (request, response) => { const route = Object.hasOwn(ROUTE_TABLE, request.url) ? ROUTE_TABLE[request.url] : undefined; return `unknown route ${request.url}` }'

  assert.deepEqual(routingOnUrl(lookup), [])

  for (const [source, found] of [
    ["if (request.url === '/call') {}", 'comparison'],
    ["if (request.url != '/call') {}", 'comparison'],
    ["switch (request.url) { case '/call': break }", 'switch on the url'],
    ["switch(request.url){}", 'switch on the url'],
    ["if (request.url.startsWith('/x/')) {}", 'string method on the url'],
    ["if (request.url?.endsWith('/x')) {}", 'string method on the url'],
    ["if (path.startsWith('/x/')) {}", 'startsWith routing'],
    ['if (/^\\/x/.test(request.url)) {}', 'url passed to a matcher'],
    ["if (['/call'].includes(request.url)) {}", 'url passed to a matcher'],
    ['const path = request.url', 'url copied to a name'],
    ['const { url } = request', 'url copied to a name'],
  ]) {
    assert.ok(routingOnUrl(source).includes(found), `${source} is caught as ${found}`)
  }
})

test('the helper takes exactly the choices the shared contract lists', async () => {
  assert.deepEqual(CHOICES, contract.choices)
  assert.ok(Object.isFrozen(CHOICES), 'a caller cannot add a choice at run time')

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

// The key sets of the replies, from the real hub through the real handler: hooks/model.ts types the same shapes, checked in tests/contract.test.ts.
const keysOf = reply => Object.keys(reply).sort()

test('the helper answers each route with the key set the shared contract lists', async () => {
  const { hub } = hubWith()
  const ask = async (path, payload, method) => {
    const answered = await send(path, payload, { hub, method })

    assert.equal(answered.status, 200, path)

    return answered.body
  }

  try {
    const replies = {
      call: await ask('/call', { caller: 's1', code: 'await cua.getState();' }),
      reset: await ask('/reset', { caller: 's1' }),
      approve: await ask('/approve', { caller: 's1', bundleId: 'com.x', choice: 'session' }),
      release: await ask('/release', { caller: 's1' }),
      settings: await ask('/settings', { autoApprove: false }),
      forget: await ask('/forget', { app: 'Grapher' }),
      status: await ask('/status', undefined, 'GET'),
    }

    // /reset ends in the same reply with no session to reset.
    assert.deepEqual(keysOf(await ask('/reset', { caller: 's9' })), contract.replies.ok.reset, 'reset with no session')
    assert.deepEqual(Object.keys(replies).sort(), Object.keys(contract.routes).sort())
    assert.deepEqual(Object.keys(contract.replies.ok).sort(), Object.keys(contract.routes).sort())

    for (const [name, reply] of Object.entries(replies)) {
      assert.deepEqual(keysOf(reply), contract.replies.ok[name], `${name} reply`)

      if (name !== 'status') {
        assert.equal(reply.status, 'ok', name)
      }
    }
  } finally {
    hub.close()
  }
})

/** The held replies of a /call through the handler, by status, and whether s2's busy call got as far as starting its Codex session. */
const heldReplies = async options => {
  const { hub } = hubWith('Calculator', options)
  const code = 'let app = await cua.getApp("TextEdit");'
  const call = async caller => (await send('/call', { caller, code }, { hub })).body
  const found = {}

  try {
    found.needs_approval = await call('s1')
    hub.approve('s1', 'com.fake.TextEdit', 'session')
    assert.equal((await call('s1')).status, 'ok')
    found.busy = await call('s2')
    found.started = hub.sessions.get('s2').client !== undefined
    hub.release('s1')
    hub.approve('s2', 'com.fake.TextEdit', 'deny')
    found.denied = await call('s2')
  } finally {
    hub.close()
  }

  return found
}

// With names resolved before the run, `#precheck` answers busy and denied before a Codex session starts; with none resolved, `#outcome` builds them from what the server asked.
test('the held replies of a call have the key sets the shared contract lists, whether the precheck or the outcome builds them', async () => {
  const viaPrecheck = await heldReplies({})
  const viaOutcome = await heldReplies({ resolve: async () => undefined })

  assert.equal(viaPrecheck.started, false, 'the precheck answered busy before s2 started a Codex session')
  assert.equal(viaOutcome.started, true, 'the outcome answered busy after the server asked')

  for (const found of [viaPrecheck, viaOutcome]) {
    for (const status of ['needs_approval', 'busy', 'denied']) {
      assert.equal(found[status].status, status)
      assert.deepEqual(keysOf(found[status]), contract.replies.held[status], status)
    }
  }

  // The app a held reply names is the same two fields on both paths.
  assert.deepEqual(keysOf(viaPrecheck.busy.app), ['bundleId', 'displayName'])
  assert.deepEqual(keysOf(viaOutcome.busy.app), ['bundleId', 'displayName'])
})

test('the app inside each held reply has the key sets the shared contract lists: always sent, sent by one path only, and what hooks reads', async () => {
  const paths = [await heldReplies({}), await heldReplies({ resolve: async () => undefined })]

  assert.deepEqual(Object.keys(contract.replies.app).sort(), Object.keys(contract.replies.held).filter(status => contract.replies.held[status].includes('app')).sort())

  for (const [status, keys] of Object.entries(contract.replies.app)) {
    const seen = paths.map(found => keysOf(found[status].app))

    for (const sent of seen) {
      assert.deepEqual(sent.filter(key => keys.always.includes(key)), [...keys.always].sort(), `${status}: every path sends the always keys`)
      assert.deepEqual(sent.filter(key => !keys.always.includes(key) && !keys.sometimes.includes(key)), [], `${status}: no key outside the contract`)
    }

    assert.deepEqual([...new Set(seen.flat())].sort(), [...keys.always, ...keys.sometimes].sort(), `${status}: the paths together send exactly always + sometimes`)
    assert.ok(keys.read.every(key => keys.always.includes(key) || keys.sometimes.includes(key)), `${status}: hooks reads only what is sent`)
    assert.deepEqual(keys.always, [...keys.always].sort())
    assert.deepEqual(keys.sometimes, [...keys.sometimes].sort())
    assert.deepEqual(keys.read, [...keys.read].sort())
  }
})

test('a call with every Codex session mid-call answers full with the key set the shared contract lists', async () => {
  const { hub } = hubWith('Calculator', { maxSessions: 1 })
  const entry = { code: 'await cua.getState();' }

  try {
    assert.equal((await hub.call('s2', entry)).status, 'ok')
    const slow = hub.call('s2', { code: 'sleep 300' })
    await new Promise(resolve => setTimeout(resolve, 50))
    const full = (await send('/call', { caller: 's3', ...entry }, { hub })).body

    assert.equal(full.status, 'full')
    assert.deepEqual(keysOf(full), contract.replies.held.full)
    await slow
  } finally {
    hub.close()
  }
})
