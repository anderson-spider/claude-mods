import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { tmpdir } from 'node:os'

import { hubWith, temp } from './support.mjs'

const textOf = reply => reply.content?.map(block => block.text).join('\n')

test('hub: first call must be an entry call, state survives calls, callers are isolated', async () => {
  const { hub } = hubWith()

  try {
    const refused = await hub.call('s1', { code: 'set n=1' })
    assert.equal(refused.status, 'error')
    assert.match(refused.message, /entry call/)

    assert.equal((await hub.call('s1', { code: 'await cua.getState();' })).status, 'ok')
    await hub.call('s1', { code: 'set n=25' })
    assert.equal(textOf(await hub.call('s1', { code: 'get n' })), '25')

    await hub.call('s1/agent-a', { code: 'await cua.getState();' })
    assert.equal(textOf(await hub.call('s1/agent-a', { code: 'get n' })), 'undefined')
  } finally {
    hub.close()
  }
})

test('hub: calls of one caller run one at a time, in order', async () => {
  const { hub } = hubWith()

  try {
    await hub.call('s1', { code: 'await cua.getState();' })
    const replies = await Promise.all(['set n=1', 'set n=2', 'get n'].map(code => hub.call('s1', { code })))
    assert.equal(textOf(replies[2]), '2')
  } finally {
    hub.close()
  }
})

test('hub: an unapproved app asks first, a denial is kept, and a session approval is per caller', async () => {
  const { hub } = hubWith('Calculator')

  try {
    const code = 'let app = await cua.getApp("TextEdit");'
    const asked = await hub.call('s1', { code })
    assert.equal(asked.status, 'needs_approval')
    assert.deepEqual(
      { bundleId: asked.app.bundleId, displayName: asked.app.displayName, canAlways: asked.app.canAlways },
      { bundleId: 'com.fake.TextEdit', displayName: 'TextEdit', canAlways: true },
    )

    hub.approve('s1', 'com.fake.TextEdit', 'session')
    const allowed = await hub.call('s1', { code })
    assert.equal(allowed.status, 'ok')
    assert.equal(textOf(await hub.call('s1', { code: 'get lastPersist' })), 'session')

    // Another caller is asked again, and the app is busy for it while s1 owns it.
    const other = await hub.call('s2', { code })
    assert.equal(other.status, 'busy')
    assert.equal(other.owner, 's1')

    hub.release('s1')
    const after = await hub.call('s2', { code })
    assert.equal(after.status, 'needs_approval')

    hub.approve('s2', 'com.fake.TextEdit', 'deny')
    const denied = await hub.call('s2', { code })
    assert.equal(denied.status, 'denied')
  } finally {
    hub.close()
  }
})

test('hub: auto-approve answers only when switched on; always is persisted for the server', async () => {
  const { hub } = hubWith('')

  try {
    hub.approvals.setAutoApprove(true)
    assert.equal((await hub.call('s1', { code: 'let a = await cua.getApp("Notepad");' })).status, 'ok')
    hub.approvals.setAutoApprove(false)
    assert.equal((await hub.call('s2', { code: 'let a = await cua.getApp("Paint");' })).status, 'needs_approval')
    hub.approve('s2', 'com.fake.Paint', 'always')
    await hub.call('s2', { code: 'let a = await cua.getApp("Paint");' })
    assert.equal(textOf(await hub.call('s2', { code: 'get lastPersist' })), 'always')
  } finally {
    hub.close()
  }
})

test('hub: reset and idle expiry release apps and start a fresh session', async () => {
  let clock = 0
  const { hub } = hubWith('Calculator', { now: () => clock, idleMs: 1000 })

  try {
    await hub.call('s1', { code: 'let app = await cua.getApp("Calculator");' })
    assert.equal(hub.owners.ownerOf('com.fake.Calculator'), 's1')
    await hub.reset('s1')
    assert.equal(hub.owners.ownerOf('com.fake.Calculator'), undefined)
    assert.equal((await hub.call('s1', { code: 'get n' })).status, 'error')

    await hub.call('s2', { code: 'let app = await cua.getApp("Calculator");' })
    clock = 5000
    hub.sweep()
    assert.equal(hub.owners.ownerOf('com.fake.Calculator'), undefined)
    assert.equal(hub.status().callers.length, 0)
  } finally {
    hub.close()
  }
})

test('hub: an app lease lapses 2 minutes (here 1 s) after its holder\'s last call', async () => {
  let clock = 0
  const { hub } = hubWith('Calculator', { now: () => clock, leaseMs: 1000 })
  const code = 'let app = await cua.getApp("Calculator");'

  try {
    assert.equal((await hub.call('s1', { code })).status, 'ok')
    clock = 500
    const busy = await hub.call('s2', { code })
    assert.equal(busy.status, 'busy')
    assert.equal(busy.owner, 's1')
    assert.equal(busy.idleSeconds, 1)

    clock = 2000
    assert.equal((await hub.call('s2', { code })).status, 'ok')
    assert.equal(hub.owners.ownerOf('com.fake.Calculator'), 's2')
    assert.equal((await hub.call('s1', { code })).status, 'busy')
  } finally {
    hub.close()
  }
})

test('hub: at most maxSessions run; the quietest idle one makes room, and none is stopped mid-call', async () => {
  let clock = 0
  const { hub } = hubWith('Calculator', { now: () => clock, maxSessions: 2 })
  const entry = { code: 'await cua.getState();' }

  try {
    await hub.call('s1', entry)
    clock = 10
    await hub.call('s2', entry)
    clock = 20
    assert.equal((await hub.call('s3', entry)).status, 'ok')
    assert.deepEqual(hub.status().callers.map(one => one.caller).sort(), ['s2', 's3'])

    const slow = [hub.call('s2', { code: 'sleep 300' }), hub.call('s3', { code: 'sleep 300' })]
    await new Promise(resolve => setTimeout(resolve, 50))
    const full = await hub.call('s4', entry)
    assert.equal(full.status, 'full')
    await Promise.all(slow)
  } finally {
    hub.close()
  }
})

test('hub.forget removes "always" from the helper and from Codex, so the app asks again', async () => {
  const codex = join(temp(), 'codex.json')
  writeFileSync(codex, JSON.stringify({ approvedBundleIdentifiers: ['com.fake.Calculator', 'com.fake.Grapher'] }, null, 2))
  const { hub } = hubWith('Calculator', { codexApprovals: codex })
  const code = 'let g = await cua.getApp("Grapher");'

  try {
    hub.approve('s1', 'com.fake.Grapher', 'always')
    assert.equal((await hub.call('s1', { code })).status, 'ok')

    const forgotten = await hub.forget('Grapher')
    assert.deepEqual(forgotten, { status: 'ok', bundleId: 'com.fake.Grapher', helper: true, codex: 'removed' })
    assert.deepEqual(JSON.parse(readFileSync(codex, 'utf8')).approvedBundleIdentifiers, ['com.fake.Calculator'])
    assert.equal(hub.approvals.decide('s1', 'com.fake.Grapher'), 'ask')

    // s1's running session was restarted: it starts over with an entry call, and the app asks.
    const again = await hub.call('s1', { code })
    assert.equal(again.status, 'needs_approval')

    assert.deepEqual(await hub.forget('Grapher'), { status: 'ok', bundleId: 'com.fake.Grapher', helper: false, codex: 'absent' })
  } finally {
    hub.close()
  }
})

test('hubWith without options keeps the codex approvals file in the temp directory', () => {
  const { hub } = hubWith()

  try {
    assert.ok(hub.codexApprovals.startsWith(tmpdir()))
  } finally {
    hub.close()
  }
})
