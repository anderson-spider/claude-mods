import assert from 'node:assert/strict'
import { test } from 'node:test'

import { VERSION } from '../lib/version.mjs'
import { logged, send, stubHub } from './support.mjs'

// Characterization of the socket handler's routing, written against the if-chain
// and switch it replaced and kept passing across the route table: the order of the
// checks, and the status code and body shape of every answer. The hub is a stub,
// so only the handler's own routing, validation and logging decide.
const CALLER = { caller: 's1' }
const BAD_CALLER = 'caller must be "<session>" or "<session>/<agent>"'
const KNOWN = ['/call', '/reset', '/approve', '/release', '/settings', '/forget', '/status']
const WITH_CALLER = ['/call', '/reset', '/approve', '/release']

test('/status answers any method with 200 and never reads the body or the caller', async () => {
  for (const method of ['GET', 'POST', 'PUT', 'DELETE', 'HEAD', 'post']) {
    const hub = stubHub({ status: () => ({ callers: [], owners: {}, settings: { autoApprove: false, always: [] } }) })
    const answered = await send('/status', undefined, { hub, method, raw: '{not json' })

    assert.equal(answered.status, 200, method)
    assert.deepEqual(answered.headers, { 'content-type': 'application/json' })
    assert.deepEqual(answered.body, { version: VERSION, pid: process.pid, callers: [], owners: {}, settings: { autoApprove: false, always: [] } })
    assert.deepEqual(Object.keys(answered.body), ['version', 'pid', 'callers', 'owners', 'settings'])
  }
})

test('/status matches the whole url: a query or a trailing slash is another route', async () => {
  const hub = stubHub()

  assert.equal((await send('/status?x=1', undefined, { hub, method: 'GET' })).status, 405)
  assert.equal((await send('/status/', undefined, { hub, method: 'GET' })).status, 405)
  assert.equal((await send('/status?x=1', CALLER, { hub })).status, 404)
  assert.equal((await send('/status/', CALLER, { hub })).status, 404)
  assert.deepEqual(hub.seen, [])
})

test('a failing /status answers 500 with the error message', async () => {
  const error = await send('/status', undefined, { hub: stubHub({ status: () => { throw new Error('boom') } }), method: 'GET' })
  const text = await send('/status', undefined, { hub: stubHub({ status: () => { throw 'plain' } }), method: 'GET' })

  assert.deepEqual(error, { status: 500, headers: { 'content-type': 'application/json' }, body: { status: 'error', message: 'boom' } })
  assert.deepEqual(text.body, { status: 'error', message: 'plain' })
})

test('every other url refuses a method that is not POST with 405, before the body and the caller are looked at', async () => {
  for (const url of [...KNOWN.filter(path => path !== '/status'), '/nope', '', '/']) {
    for (const method of ['GET', 'PUT', 'DELETE', 'HEAD', 'post']) {
      const hub = stubHub()
      const answered = await send(url, undefined, { hub, method, raw: '{not json' })

      assert.equal(answered.status, 405, `${method} ${url}`)
      assert.deepEqual(answered.body, { status: 'error', message: 'POST only' })
      assert.deepEqual(hub.seen, [])
    }
  }
})

test('a body that is not JSON answers 500 on every route but /status, before the caller check and the hub', async () => {
  for (const url of [...WITH_CALLER, '/settings', '/forget', '/nope']) {
    const hub = stubHub()
    const answered = await send(url, undefined, { hub, raw: '{"caller":' })

    assert.equal(answered.status, 500, url)
    assert.equal(answered.body.status, 'error')
    assert.equal(typeof answered.body.message, 'string')
    assert.deepEqual(Object.keys(answered.body), ['status', 'message'])
    assert.deepEqual(hub.seen, [])
  }

  assert.equal((await send('/status', undefined, { hub: stubHub(), raw: '{"caller":' })).status, 200)
})

test('a body over the size limit answers 500 and reaches no route', async () => {
  const hub = stubHub()
  const answered = await send('/settings', undefined, { hub, raw: JSON.stringify({ autoApprove: true, pad: 'x'.repeat(1_000_001) }) })

  assert.deepEqual(answered.body, { status: 'error', message: 'request too large' })
  assert.equal(answered.status, 500)
  assert.deepEqual(hub.seen, [])
})

test('an empty body is an empty object', async () => {
  const hub = stubHub()

  assert.equal((await send('/settings', undefined, { hub })).status, 200)
  assert.deepEqual(hub.seen, [])
  assert.deepEqual((await send('/call', undefined, { hub })).body, { status: 'error', message: BAD_CALLER })
  assert.equal((await send('/forget', undefined, { hub })).status, 200)
  assert.deepEqual(hub.calls, [['forget', undefined]])
})

test('a body that is JSON but not an object: null fails the route, other values lack a caller', async () => {
  for (const url of ['/settings', '/forget', ...WITH_CALLER]) {
    const hub = stubHub()
    const answered = await send(url, undefined, { hub, raw: 'null' })

    assert.equal(answered.status, 500, url)
    assert.equal(answered.body.status, 'error')
    assert.match(answered.body.message, /null/)
    assert.deepEqual(hub.seen, [])
  }

  for (const raw of ['5', '"abc"', '[]', 'true']) {
    for (const url of WITH_CALLER) {
      assert.equal((await send(url, undefined, { hub: stubHub(), raw })).status, 400, `${url} ${raw}`)
    }

    assert.equal((await send('/settings', undefined, { hub: stubHub(), raw })).status, 200, raw)
  }
})

test('/settings and /forget need no caller: a missing or invalid one changes nothing', async () => {
  for (const body of [{}, { caller: '../x' }, { caller: 7 }, CALLER]) {
    const hub = stubHub()

    assert.equal((await send('/settings', body, { hub })).status, 200)
    assert.equal((await send('/forget', { ...body, app: 'Grapher' }, { hub })).status, 200)
    assert.deepEqual(hub.calls, [['forget', 'Grapher']])
  }
})

test('/settings answers the current settings; a boolean autoApprove is set and logged, anything else is ignored', async () => {
  const settings = { autoApprove: true, always: ['com.x'] }

  for (const [autoApprove, expected] of [[true, [['settings', true]]], [false, [['settings', false]]]]) {
    const hub = stubHub({ approvals: { settings, setAutoApprove: value => hub.calls.push(['settings', value]) } })
    const lines = await logged(async () => {
      const answered = await send('/settings', { autoApprove }, { hub })

      assert.deepEqual(answered, { status: 200, headers: { 'content-type': 'application/json' }, body: { status: 'ok', settings } })
    })

    assert.deepEqual(hub.calls, expected)
    assert.deepEqual(lines, [`auto-approve ${autoApprove ? 'on' : 'off'}`])
  }

  for (const autoApprove of ['true', 1, null, undefined, [], {}]) {
    const hub = stubHub({ approvals: { settings, setAutoApprove: value => hub.calls.push(['settings', value]) } })
    const lines = await logged(async () => {
      assert.deepEqual((await send('/settings', { autoApprove }, { hub })).body, { status: 'ok', settings })
    })

    assert.deepEqual(hub.calls, [])
    assert.deepEqual(lines, [])
  }
})

test('/forget passes the app to the hub and answers 200 with its reply and a log line when it is ok', async () => {
  for (const [helper, codex] of [[true, 'removed'], [false, 'absent']]) {
    const reply = { status: 'ok', bundleId: 'com.x', helper, codex }
    const hub = stubHub({ forget: app => (hub.calls.push(['forget', app]), reply) })
    const lines = await logged(async () => {
      assert.deepEqual(await send('/forget', { app: 'X' }, { hub }), { status: 200, headers: { 'content-type': 'application/json' }, body: reply })
    })

    assert.deepEqual(hub.calls, [['forget', 'X']])
    assert.deepEqual(lines, [`forgot always for com.x (helper: ${helper ? 'removed' : 'absent'}, codex: ${codex})`])
  }
})

test('/forget answers 400 with the hub reply, unlogged, whenever that reply is not ok', async () => {
  for (const reply of [
    { status: 'error', message: 'no app found for "x"' },
    { status: 'error', bundleId: 'com.x', helper: true, message: 'disk' },
    { status: 'other' },
  ]) {
    const lines = await logged(async () => {
      assert.deepEqual(await send('/forget', { app: 'x' }, { hub: stubHub({ forget: () => reply }) }), { status: 400, headers: { 'content-type': 'application/json' }, body: reply })
    })

    assert.deepEqual(lines, [])
  }

  const throwing = await send('/forget', { app: 'x' }, { hub: stubHub({ forget: async () => { throw new Error('gone') } }) })

  assert.deepEqual(throwing.body, { status: 'error', message: 'gone' })
  assert.equal(throwing.status, 500)
})

test('the caller routes answer 400 for a missing or invalid caller, before reaching the hub', async () => {
  for (const url of WITH_CALLER) {
    for (const caller of [undefined, null, '', 7, ['a'], '../x', 'a b', 'a/b/c']) {
      const hub = stubHub()
      const answered = await send(url, { caller, bundleId: 'com.x', choice: 'session' }, { hub })

      assert.equal(answered.status, 400, `${url} ${JSON.stringify(caller)}`)
      assert.deepEqual(answered.body, { status: 'error', message: BAD_CALLER })
      assert.deepEqual(hub.seen, [])
    }
  }
})

test('/call, /reset and /release pass the caller (and /call the whole body) to the hub and answer 200 with its reply', async () => {
  const body = { caller: 's1/a', code: 'await cua.getState();', title: 't', timeout_ms: 5 }
  const held = { status: 'busy', app: { bundleId: 'b', displayName: 'B' }, owner: 's2' }

  for (const [url, name, args] of [['/call', 'call', ['s1/a', body]], ['/reset', 'reset', ['s1/a']], ['/release', 'release', ['s1/a']]]) {
    const hub = stubHub({ [name]: (...given) => (hub.calls.push([name, ...given]), held) })
    const answered = await send(url, body, { hub })

    assert.deepEqual(answered, { status: 200, headers: { 'content-type': 'application/json' }, body: held }, url)
    assert.deepEqual(hub.calls, [[name, ...args]])
  }

  // A reply that says error is still a 200: only the transport and validation use other codes.
  const failed = await send('/call', CALLER, { hub: stubHub({ call: () => ({ status: 'error', message: 'no' }) }) })

  assert.deepEqual(failed.body, { status: 'error', message: 'no' })
  assert.equal(failed.status, 200)
})

// `/release` does not await its hub call (Hub#release is synchronous), so only a throw ends in 500 there.
test('/call, /reset and /release answer 500 with the message when the hub throws, and with the text of a non-error; /call and /reset also when it rejects', async () => {
  for (const url of ['/call', '/reset', '/release']) {
    const name = url.slice(1)
    const fails = failure => send(url, CALLER, { hub: stubHub({ [name]: failure }) })

    assert.deepEqual(await fails(() => { throw new Error('sync') }), { status: 500, headers: { 'content-type': 'application/json' }, body: { status: 'error', message: 'sync' } })
    assert.deepEqual((await fails(() => { throw 42 })).body, { status: 'error', message: '42' })

    if (name !== 'release') {
      assert.deepEqual((await fails(async () => { throw new Error('async') })).body, { status: 'error', message: 'async' })
    }
  }
})

test('/approve needs a string bundleId and one of the choices, else answers 400 with the choices and reaches nothing', async () => {
  const message = 'approve needs bundleId and choice session|always|deny'

  for (const body of [
    { ...CALLER },
    { ...CALLER, bundleId: 'com.x' },
    { ...CALLER, choice: 'session' },
    { ...CALLER, bundleId: 7, choice: 'session' },
    { ...CALLER, bundleId: 'com.x', choice: 'maybe' },
    { ...CALLER, bundleId: 'com.x', choice: ['session'] },
    { ...CALLER, bundleId: 'com.x', choice: 'SESSION' },
  ]) {
    const hub = stubHub()
    const lines = await logged(async () => {
      assert.deepEqual(await send('/approve', body, { hub }), { status: 400, headers: { 'content-type': 'application/json' }, body: { status: 'error', message } })
    })

    assert.deepEqual(hub.calls, [])
    assert.deepEqual(lines, [])
  }
})

test('/approve records the choice for the caller, logs it, and answers exactly { status: "ok" }', async () => {
  for (const choice of ['session', 'always', 'deny']) {
    const hub = stubHub({ approve: (...given) => (hub.calls.push(['approve', ...given]), { status: 'ok', extra: 'dropped' }) })
    const lines = await logged(async () => {
      assert.deepEqual(await send('/approve', { caller: 's1/a', bundleId: 'com.x', choice }, { hub }), { status: 200, headers: { 'content-type': 'application/json' }, body: { status: 'ok' } })
    })

    assert.deepEqual(hub.calls, [['approve', 's1/a', 'com.x', choice]])
    assert.deepEqual(lines, [`approval ${choice} for com.x`])
  }

  const failing = await send('/approve', { ...CALLER, bundleId: 'com.x', choice: 'deny' }, { hub: stubHub({ approve: () => { throw new Error('write failed') } }) })

  assert.deepEqual(failing.body, { status: 'error', message: 'write failed' })
  assert.equal(failing.status, 500)
})

test('an unknown url answers 404 naming it, but only once the caller is valid', async () => {
  for (const url of ['/nope', '/', '', '/call/', '/call?x=1', '/Call', '/CALL', ' /call', 'call', '/status/x', 'toString', '__proto__', 'constructor', 'hasOwnProperty', '/__proto__', '/constructor']) {
    const hub = stubHub()

    assert.deepEqual(await send(url, CALLER, { hub }), { status: 404, headers: { 'content-type': 'application/json' }, body: { status: 'error', message: `unknown route ${url}` } }, url)
    assert.deepEqual((await send(url, { caller: '../x' }, { hub })).body, { status: 'error', message: BAD_CALLER }, url)
    assert.equal((await send(url, {}, { hub })).status, 400, url)
    assert.deepEqual(hub.seen, [])
  }

  const missing = await send(undefined, CALLER, { hub: stubHub() })

  assert.deepEqual(missing.body, { status: 'error', message: 'unknown route undefined' })
  assert.equal(missing.status, 404)
})

test('the checks run in a fixed order: status, method, body, then the caller, then the route', async () => {
  const bad = { caller: '../x' }
  const hub = stubHub()
  const order = async (url, payload, options) => (await send(url, payload, { hub, ...options })).status

  assert.equal(await order('/status', bad, { method: 'GET', raw: '{' }), 200, 'status before the method, the body and the caller')
  assert.equal(await order('/call', bad, { method: 'GET', raw: '{' }), 405, 'method before the body')
  assert.equal(await order('/nope', bad, { method: 'GET', raw: '{' }), 405, 'method before the route')
  assert.equal(await order('/call', bad, { raw: '{' }), 500, 'body before the caller')
  assert.equal(await order('/nope', bad, { raw: '{' }), 500, 'body before the route')
  assert.equal(await order('/settings', bad), 200, 'settings before the caller')
  assert.equal(await order('/forget', { ...bad, app: 'x' }), 200, 'forget before the caller')
  assert.equal(await order('/call', bad), 400, 'caller before the route')
  assert.equal(await order('/approve', { ...bad, bundleId: 1 }), 400, 'caller before the approve fields')
  assert.equal(await order('/nope', bad), 400, 'caller before the 404')
  assert.equal(await order('/nope', CALLER), 404)
  assert.equal(await order('/approve', { ...CALLER, bundleId: 1 }), 400, 'approve fields before the hub')
  assert.deepEqual(hub.seen, ['status', 'forget'], 'only /status and /forget reached the hub')
})

test('every answer is JSON', async () => {
  const hub = stubHub()
  const answers = [
    await send('/status', undefined, { hub, method: 'GET' }),
    await send('/call', undefined, { hub, method: 'GET' }),
    await send('/call', undefined, { hub, raw: '{' }),
    await send('/call', {}, { hub }),
    await send('/nope', CALLER, { hub }),
    await send('/release', CALLER, { hub }),
  ]

  for (const answered of answers) {
    assert.deepEqual(answered.headers, { 'content-type': 'application/json' })
  }

  assert.deepEqual(answers.map(one => one.status), [200, 405, 500, 400, 404, 200])
})
