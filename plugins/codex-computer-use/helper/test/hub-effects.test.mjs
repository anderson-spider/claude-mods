import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'

import { Approvals, parseRequest } from '../lib/approvals.mjs'
import { DECISION_KINDS, Hub } from '../lib/hub.mjs'
import { temp } from './support.mjs'

// Characterization of what the hub does with each approval decision, and of how it tears a
// session down. Written against the hub before its decision effects became a table, so
// every expectation is today's behavior, including the odd cases (a denied app is still
// claimed at the start of a call; an unknown decision claims the app and declines it).
// The Codex session is a fake client: no process starts, and the approvals file and the
// codex approvals file are in the temp directory.

const KNOWN = ['deny', 'ask', 'session', 'always', 'auto']
// What `Approvals#decide` never returns today; the hub must treat each like an unlisted decision.
const UNKNOWN = ['weird', undefined, 'constructor', '__proto__', 'toString', '']
const ENTRY = 'await cua.getState();'
const NAMED = 'let a = await cua.getApp("Pad");'
const PAD = 'com.fake.Pad'

const elicitParams = ({ canAlways = true } = {}) => ({
  _meta: {
    connector_id: 'computer-use',
    persist: canAlways ? ['session', 'always'] : ['session'],
    tool_params: { app: PAD },
    tool_params_display: [{ name: 'app', value: 'Pad' }],
  },
})
const surface = appId => ({ content: [], _meta: { 'codex/toolSurface': { app: { kind: 'appId', appId } } } })

/**
 * A hub on a fake Codex client. `decisions` is what `approvals.decide` answers, one entry per
 * question (the last one repeats). `onCall({ client, args, caller })` is the fake `js` tool.
 * `events` collects each client close, with what the hub still held at that moment.
 */
const rig = ({ decisions = ['ask'], onCall = async () => ({ content: [] }), ...extra } = {}) => {
  const events = []
  const clients = []
  const queue = [...decisions]
  const hub = new Hub({
    approvals: new Approvals(join(temp(), 'approvals.json')),
    codexApprovals: join(temp(), 'codex-approvals.json'),
    resolve: async name => `com.fake.${name}`,
    createClient: onElicit => {
      let alive = false
      const client = {
        onElicit,
        get isAlive() {
          return alive
        },
        start: async () => {
          alive = true
        },
        close: () => {
          alive = false
          const caller = [...hub.sessions].find(([, session]) => session.client === client)?.[0]
          events.push(`close:${caller}:session=${caller !== undefined}:apps=${hub.owners.appsOf(caller).length}`)
        },
        callTool: (name, args) => onCall({ client, args, caller: [...hub.sessions].find(([, session]) => session.client === client)?.[0] }),
      }
      clients.push(client)

      return client
    },
    ...extra,
  })

  hub.approvals.decide = () => (queue.length > 1 ? queue.shift() : queue[0])

  return { hub, events, clients }
}

test('#elicit: each known decision sets its slot, claims or not, and answers as it does today', async () => {
  const request = { kind: 'app', bundleId: PAD, displayName: 'Pad', canAlways: true }
  const cases = [
    // decision, canAlways, status, answer, owner
    ['deny', true, 'denied', { action: 'decline' }, undefined],
    ['ask', true, 'needs_approval', { action: 'decline' }, undefined],
    ['session', true, 'ok', { action: 'accept', content: {}, _meta: { persist: 'session' } }, 's1'],
    ['auto', true, 'ok', { action: 'accept', content: {}, _meta: { persist: 'session' } }, 's1'],
    ['always', true, 'ok', { action: 'accept', content: {}, _meta: { persist: 'always' } }, 's1'],
    ['always', false, 'ok', { action: 'accept', content: {}, _meta: { persist: 'session' } }, 's1'],
  ]

  for (const [decision, canAlways, status, answer, owner] of cases) {
    let answered
    const { hub } = rig({
      decisions: [decision],
      onCall: async ({ client }) => ((answered = client.onElicit(elicitParams({ canAlways }))), { content: [] }),
    })
    const reply = await hub.call('s1', { code: ENTRY })
    const label = `${decision} canAlways=${canAlways}`

    assert.deepEqual(answered, answer, label)
    assert.equal(reply.status, status, label)
    assert.equal(hub.owners.ownerOf(PAD), owner, label)

    if (status !== 'ok') {
      assert.deepEqual(reply.app, { ...request, canAlways }, label)
      assert.deepEqual(Object.keys(reply).sort(), ['app', 'status'], label)
    }
  }
})

test('#elicit: a decision the hub does not list claims the app and declines it, as it does today', async () => {
  for (const decision of UNKNOWN) {
    let answered
    const { hub } = rig({
      decisions: [decision],
      onCall: async ({ client }) => ((answered = client.onElicit(elicitParams())), { content: [] }),
    })
    const reply = await hub.call('s1', { code: ENTRY })

    assert.deepEqual(answered, { action: 'decline' }, String(decision))
    assert.deepEqual(reply, { status: 'ok', isError: false, content: [], notes: [] }, String(decision))
    assert.equal(hub.owners.ownerOf(PAD), 's1', String(decision))
  }
})

test('#elicit: a request that is not an app approval is declined and noted, whatever the decision', async () => {
  let answered
  const { hub } = rig({
    decisions: ['session'],
    onCall: async ({ client }) => ((answered = client.onElicit({ message: 'record audio?', _meta: { connector_id: 'computer-use' } })), { content: [] }),
  })
  const reply = await hub.call('s1', { code: ENTRY })

  assert.deepEqual(answered, { action: 'decline' })
  assert.equal(reply.status, 'ok')
  assert.deepEqual(reply.notes, ['The Codex server asked for an approval this helper does not answer ("record audio?"); it was declined.'])
  assert.equal(hub.owners.ownerOf(PAD), undefined)
})

test('#elicit: a holder other than the caller makes the question busy and declined before any decision is read', async () => {
  let answered
  const { hub } = rig({
    decisions: ['session'],
    onCall: async ({ client, caller }) => (caller === 's2' ? ((answered = client.onElicit(elicitParams())), { content: [] }) : surface(PAD)),
  })

  assert.equal((await hub.call('s1', { code: ENTRY })).status, 'ok')
  assert.equal(hub.owners.ownerOf(PAD), 's1')
  hub.approvals.decide = () => assert.fail('the holder check comes before the decision')

  const reply = await hub.call('s2', { code: ENTRY })

  assert.deepEqual(answered, { action: 'decline' })
  assert.equal(reply.status, 'busy')
  assert.equal(reply.owner, 's1')
  assert.equal(hub.owners.ownerOf(PAD), 's1')
})

test('#precheck: only deny stops a call that names the app, and nothing is claimed or started for it', async () => {
  for (const decision of [...KNOWN, ...UNKNOWN]) {
    let calls = 0
    const { hub, clients } = rig({ decisions: [decision], onCall: async () => (calls++, { content: [] }) })
    const reply = await hub.call('s1', { code: NAMED })
    const label = String(decision)

    if (decision === 'deny') {
      assert.deepEqual(reply, { status: 'denied', app: { bundleId: PAD, displayName: 'Pad' } }, label)
      assert.equal(calls, 0, label)
      assert.equal(clients.length, 0, label)
      assert.equal(hub.owners.ownerOf(PAD), undefined, label)
    } else {
      assert.equal(reply.status, 'ok', label)
      assert.equal(calls, 1, label)
    }
  }
})

test('#invoke: it claims each named app before the run for every decision but ask, deny and unknown ones included', async () => {
  for (const decision of [...KNOWN, ...UNKNOWN]) {
    let heldAtRun
    // The precheck sees an allowing decision and the invoke sees `decision`, as when a choice lands between the two.
    const { hub } = rig({ decisions: ['session', decision], onCall: async () => ((heldAtRun = hub.owners.ownerOf(PAD)), { content: [] }) })
    const reply = await hub.call('s1', { code: NAMED })
    const label = String(decision)

    assert.equal(reply.status, 'ok', label)
    assert.equal(heldAtRun, decision === 'ask' ? undefined : 's1', label)
  }
})

test('#invoke: a fresh session refused for a first call that is no entry call claims nothing', async () => {
  const { hub } = rig({ decisions: ['session'] })
  const refused = await hub.call('s1', { code: 'await app.typeText("1") // getApp("Pad")' })

  assert.equal(refused.status, 'error')
  assert.equal(hub.owners.ownerOf(PAD), undefined)
})

test('#outcome: denied outranks needs_approval whichever came first', async () => {
  const request = { kind: 'app', bundleId: PAD, displayName: 'Pad', canAlways: true }
  const order = async (decisions, extraCalls) => {
    const { hub } = rig({
      decisions,
      onCall: async ({ client }) => (extraCalls(client), { content: [] }),
    })

    return hub.call('s1', { code: ENTRY })
  }

  // deny then ask in one run: denied outranks needs_approval.
  const both = await order(['deny', 'ask'], client => (client.onElicit(elicitParams()), client.onElicit(elicitParams())))
  assert.deepEqual(both, { status: 'denied', app: request })

  // ask then deny: still denied.
  const reversed = await order(['ask', 'deny'], client => (client.onElicit(elicitParams()), client.onElicit(elicitParams())))
  assert.deepEqual(reversed, { status: 'denied', app: request })
})

test('approve: a deny frees the app only for its holder; session and always leave it', () => {
  const { hub } = rig()

  for (const [caller, choice, owner] of [
    ['s1', 'deny', undefined],
    ['s2', 'deny', 's1'],
    ['s1', 'session', 's1'],
    ['s1', 'always', 's1'],
  ]) {
    hub.owners.claim(PAD, 's1')
    hub.approve(caller, PAD, choice)

    assert.equal(hub.owners.ownerOf(PAD), owner, `${caller} ${choice}`)
    hub.owners.drop(PAD)
    hub.approvals.session.clear()
  }

  assert.throws(() => hub.approve('s1', PAD, 'maybe'), /unknown choice: maybe/)
})

test('reset: the apps are freed at once, the client closes after the queued calls, and a missing session still frees them', async () => {
  let release
  const gate = new Promise(resolve => (release = resolve))
  const { hub, events } = rig({
    onCall: async ({ args }) => (args.title === 'slow' ? (await gate, { content: [] }) : surface(args.title)),
  })

  await hub.call('s1', { code: ENTRY, title: PAD })
  assert.equal(hub.owners.ownerOf(PAD), 's1')

  const slow = hub.call('s1', { code: ENTRY, title: 'slow' })
  await new Promise(resolve => setImmediate(resolve))
  const reset = hub.reset('s1')

  assert.equal(hub.owners.ownerOf(PAD), undefined, 'freed before the queue drains')
  assert.deepEqual(events, [], 'not closed while a call is queued')
  assert.ok(hub.sessions.has('s1'))

  release()
  await slow

  assert.deepEqual(await reset, { status: 'ok', message: 'Codex session reset; the next call must be an entry call.' })
  assert.deepEqual(events, ['close:s1:session=true:apps=0'])
  assert.equal(hub.sessions.has('s1'), false)

  hub.owners.claim(PAD, 's9')
  assert.deepEqual(await hub.reset('s9'), { status: 'ok', message: 'No Codex session to reset.' })
  assert.equal(hub.owners.ownerOf(PAD), undefined)
  assert.deepEqual(events, ['close:s1:session=true:apps=0'])
})

test('release: it closes each session under the prefix, then frees the prefix and its choices, and names who ended', async () => {
  const { hub, events } = rig({ onCall: async ({ args }) => surface(args.title) })
  const order = []
  const releasePrefix = hub.owners.releasePrefix.bind(hub.owners)
  const forget = hub.approvals.forget.bind(hub.approvals)

  hub.owners.releasePrefix = prefix => (order.push(`releasePrefix:${prefix}:sessions=${hub.sessions.size}`), releasePrefix(prefix))
  hub.approvals.forget = prefix => (order.push(`forget:${prefix}:apps=${hub.owners.apps().length}`), forget(prefix))

  await hub.call('s1', { code: ENTRY, title: 'com.fake.A' })
  await hub.call('s1/a', { code: ENTRY, title: 'com.fake.B' })
  await hub.call('s10', { code: ENTRY, title: 'com.fake.C' })
  await hub.call('s2', { code: ENTRY, title: 'com.fake.D' })
  hub.approve('s1/a', 'com.fake.X', 'deny')
  hub.approve('s2', 'com.fake.X', 'deny')

  const reply = hub.release('s1')

  assert.deepEqual(reply, { status: 'ok', ended: ['s1', 's1/a'] })
  assert.deepEqual(events, ['close:s1:session=true:apps=1', 'close:s1/a:session=true:apps=1'])
  assert.deepEqual(order, ['releasePrefix:s1:sessions=2', 'forget:s1:apps=2'])
  assert.deepEqual([...hub.sessions.keys()], ['s10', 's2'])
  assert.deepEqual(hub.owners.apps().sort(), ['com.fake.C', 'com.fake.D'])
  assert.equal(hub.approvals.session.has('s1/a'), false)
  assert.equal(hub.approvals.session.has('s2'), true)
  assert.deepEqual(hub.release('nobody'), { status: 'ok', ended: [] })
})

test('sweep: an idle session closes, leaves the table, then its apps are freed; a running or recent one stays', async () => {
  let clock = 0
  const { hub, events } = rig({ now: () => clock, idleMs: 1000, onCall: async ({ args }) => surface(args.title) })
  const order = []
  const release = hub.owners.release.bind(hub.owners)

  hub.owners.release = caller => (order.push(`release:${caller}:session=${hub.sessions.has(caller)}`), release(caller))

  await hub.call('s1', { code: ENTRY, title: 'com.fake.A' })
  clock = 900
  await hub.call('s2', { code: ENTRY, title: 'com.fake.B' })
  clock = 1500
  hub.sweep()

  assert.deepEqual(events, ['close:s1:session=true:apps=1'])
  assert.deepEqual(order, ['release:s1:session=false'])
  assert.deepEqual([...hub.sessions.keys()], ['s2'])
  assert.deepEqual(hub.owners.apps(), ['com.fake.B'])
})

test('makeRoom: the quietest idle session closes, leaves the table, then its apps are freed; it never closes a running one', async () => {
  let clock = 0
  const { hub, events } = rig({ now: () => clock, maxSessions: 2, onCall: async ({ args }) => surface(args.title) })
  const order = []
  const release = hub.owners.release.bind(hub.owners)

  hub.owners.release = caller => (order.push(`release:${caller}:session=${hub.sessions.has(caller)}`), release(caller))

  await hub.call('s1', { code: ENTRY, title: 'com.fake.A' })
  clock = 10
  await hub.call('s2', { code: ENTRY, title: 'com.fake.B' })
  clock = 20
  assert.equal((await hub.call('s3', { code: ENTRY, title: 'com.fake.C' })).status, 'ok')

  assert.deepEqual(events, ['close:s1:session=true:apps=1'])
  assert.deepEqual(order, ['release:s1:session=false'])
  assert.deepEqual([...hub.sessions.keys()].sort(), ['s2', 's3'])
  assert.deepEqual(hub.owners.apps().sort(), ['com.fake.B', 'com.fake.C'])
})

test('close: every client closes and the table empties, but the apps stay held', async () => {
  const { hub, events } = rig({ onCall: async ({ args }) => surface(args.title) })

  await hub.call('s1', { code: ENTRY, title: 'com.fake.A' })
  await hub.call('s2', { code: ENTRY, title: 'com.fake.B' })
  hub.close()

  assert.deepEqual(events, ['close:s1:session=true:apps=1', 'close:s2:session=true:apps=1'])
  assert.equal(hub.sessions.size, 0)
  assert.deepEqual(hub.owners.apps().sort(), ['com.fake.A', 'com.fake.B'])
})

test('every decision the real Approvals returns has a row in the table, and every row is one it returns', () => {
  const approvals = new Approvals(join(temp(), 'approvals.json'))
  const seen = new Set()
  const see = () => seen.add(approvals.decide('s1', PAD))

  see() // nothing said, auto-approve off
  approvals.setAutoApprove(true)
  see()
  approvals.setAutoApprove(false)
  approvals.record('s1', PAD, 'session')
  see()
  approvals.record('s1', PAD, 'deny')
  see()
  approvals.record('s1', PAD, 'always')
  see()

  assert.equal(seen.size, 5, 'the five states give five different decisions')
  assert.deepEqual([...seen].sort(), [...DECISION_KINDS].sort())
})
