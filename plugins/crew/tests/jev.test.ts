import { expect, test } from 'claude-code/testing'
import { JEV_DEADLINE_MS, JEV_URL, JevFailure, MAX_CONCURRENT, SLOT_HOLD_MS, classifyFailure, createBreaker, createGate, createJev, failureText, parseBody } from '../hooks/jev'
import type { JevInit, JevIo, JevOptions } from '../hooks/jev'

// A key-shaped fixture is assembled at runtime so no source literal matches a secret scanner.
const KEY = ['sk-test-', 'abcdefghijklmnopqrstuvwx'].join('')
const BODY = JSON.stringify({
  model: 'jev-1.13.0',
  answers: { tier: { choice: 'sonnet', confidence: 0.9, probabilities: { sonnet: 0.9 } }, reasoning_depth: { score: 1.4, confidence: 0.6 } },
})
const OPTS: JevOptions = { model: 'jev-1.13.0' }

type Reply = { status?: number; text?: string; headers?: Record<string, string>; throws?: unknown; never?: true; spendMs?: number }

/** A scripted host: fetch answers with the next reply (the last repeats); timers are recorded and fired by the test. */
function harness(replies: Reply[]) {
  const calls: JevInit[] = []
  const timers: { ms: number; fn: () => void; cancelled: boolean }[] = []
  const state = { now: 0, index: 0 }
  const io: JevIo = {
    fetch: async (url, init) => {
      expect(url).toBe(JEV_URL)
      calls.push(init)
      const reply = replies[Math.min(state.index++, replies.length - 1)] ?? {}
      state.now += reply.spendMs ?? 0
      if (reply.never) return new Promise(() => {})
      if (reply.throws !== undefined) throw reply.throws
      return { status: reply.status ?? 200, text: reply.text ?? BODY, headers: reply.headers }
    },
    // A backoff pause fires at once; the deadline waits for the test.
    timer: (ms, fn) => {
      const entry = { ms, fn, cancelled: false }
      timers.push(entry)
      if (ms !== JEV_DEADLINE_MS && ms !== SLOT_HOLD_MS) void Promise.resolve().then(() => { if (!entry.cancelled) fn() })
      return () => { entry.cancelled = true }
    },
    now: () => state.now,
  }
  const expire = () => timers.filter(t => t.ms === JEV_DEADLINE_MS).forEach(t => t.fn())
  /** The ceiling on a slot's hold. */
  const hold = () => timers.filter(t => t.ms === SLOT_HOLD_MS && !t.cancelled).forEach(t => t.fn())
  return { io, calls, timers, state, expire, hold }
}

const tick = () => new Promise<void>(resolve => (globalThis as unknown as { setTimeout: (f: () => void, ms: number) => unknown }).setTimeout(resolve, 0))

async function failureOf(promise: Promise<unknown>): Promise<JevFailure> {
  try {
    await promise
  } catch (error) {
    if (error instanceof JevFailure) return error
    throw error
  }
  throw new Error('expected a failure, got an answer')
}

test('one POST to the systemone endpoint with the bearer key, the pinned model, the state and the questions', async () => {
  const h = harness([{}])
  const reply = await createJev(h.io, KEY, OPTS)({ tier: { type: 'choice' } }, { agent: { type: 'developer' } })
  expect(reply.answers.tier).toMatchObject({ choice: 'sonnet', confidence: 0.9 })
  expect(reply.answers.reasoning_depth).toMatchObject({ score: 1.4 })
  expect(reply.model).toBe('jev-1.13.0')
  expect(JEV_URL).toBe('https://api.typesafe.ai/v1/systemone')
  const init = h.calls[0]!
  expect(init.method).toBe('POST')
  expect(init.headers.Authorization).toBe(`Bearer ${KEY}`)
  expect(JSON.parse(init.body)).toEqual({ model: 'jev-1.13.0', state: { agent: { type: 'developer' } }, questions: { tier: { type: 'choice' } } })
})

test('one retry on 429 and 5xx while the deadline allows it, none on other statuses', async () => {
  const retried = harness([{ status: 503 }, {}])
  expect((await createJev(retried.io, KEY, OPTS)({}, {})).answers.tier).toBeDefined()
  expect(retried.calls.length).toBe(2)

  const twice = harness([{ status: 429 }])
  expect((await failureOf(createJev(twice.io, KEY, OPTS)({}, {}))).status).toBe(429)
  expect(twice.calls.length).toBe(2)

  const rejected = harness([{ status: 401 }])
  expect((await failureOf(createJev(rejected.io, KEY, OPTS)({}, {}))).status).toBe(401)
  expect(rejected.calls.length).toBe(1)
})

test('a retry needs a second of the deadline: a slow first attempt is not retried', async () => {
  const h = harness([{ status: 503, spendMs: 2_500 }, {}])
  expect((await failureOf(createJev(h.io, KEY, OPTS)({}, {}))).reason).toBe('http')
  expect(h.calls.length).toBe(1)
})

test('one deadline covers the call: a fetch that never answers fails with timeout', async () => {
  const h = harness([{ never: true }])
  const pending = failureOf(createJev(h.io, KEY, OPTS)({}, {}))
  await tick()
  h.expire()
  expect((await pending).reason).toBe('timeout')
  expect(h.timers.find(t => t.ms === JEV_DEADLINE_MS)?.cancelled).toBe(true)
})

test('a thrown fetch and a malformed 2xx fail typed, and the malformed body is not retried', async () => {
  const thrown = harness([{ throws: new Error('connect failed') }])
  expect((await failureOf(createJev(thrown.io, KEY, OPTS)({}, {}))).reason).toBe('network')

  for (const text of ['not json', '{}', '{"answers":[]}', '{"answers":{"tier":3}}']) {
    const h = harness([{ text }])
    expect((await failureOf(createJev(h.io, KEY, OPTS)({}, {}))).reason).toBe('malformed')
    expect(h.calls.length).toBe(1)
  }
  expect(() => parseBody('{"answers":{}}')).not.toThrow()
})

test('failures carry a status or a reason and never the key or the response body', async () => {
  const echo = harness([{ status: 500, text: `{"error":"bad request: Authorization: Bearer ${KEY}"}` }])
  const failure = await failureOf(createJev(echo.io, KEY, OPTS)({}, {}))
  expect(failure.message).toBe('HTTP 500')
  expect(failure.message).not.toContain(KEY)

  const leaking = harness([{ throws: new Error(`ECONNRESET sending Bearer ${KEY}`) }])
  const network = await failureOf(createJev(leaking.io, KEY, OPTS)({}, {}))
  expect(JSON.stringify([network.message, network.reason, network.status])).not.toContain(KEY)
})

test('no key, or a key with whitespace, fails as config without a request', async () => {
  const h = harness([{}])
  expect((await failureOf(createJev(h.io, '  ', OPTS)({}, {}))).reason).toBe('config')
  expect((await failureOf(createJev(h.io, 'a b', OPTS)({}, {}))).reason).toBe('config')
  expect(h.calls.length).toBe(0)
})

test('three failures pause Jev, then one probe goes through and a success closes it', async () => {
  const h = harness([{ status: 500 }])
  let clock = 0
  const breaker = createBreaker(() => clock)
  const ask = createJev(h.io, KEY, { ...OPTS, breaker })
  for (let i = 0; i < 3; i++) await failureOf(ask({}, {}))
  const before = h.calls.length
  expect((await failureOf(ask({}, {}))).reason).toBe('breaker')
  expect(h.calls.length).toBe(before)

  clock = 5 * 60_000 + 1
  h.state.index = 0
  const ok = createJev(harness([{}]).io, KEY, { ...OPTS, breaker })
  expect((await ok({}, {})).answers.tier).toBeDefined()
  expect(breaker.allow()).toBe(true)
})

test('a rejected request does not count against the breaker', async () => {
  const h = harness([{ status: 422 }])
  const breaker = createBreaker(() => 0, { failures: 1 })
  const ask = createJev(h.io, KEY, { ...OPTS, breaker })
  await failureOf(ask({}, {}))
  expect(breaker.allow()).toBe(true)
})

test('at most four calls are in flight; a fifth fails open without a request and a slot frees on completion', async () => {
  expect(MAX_CONCURRENT).toBe(4)
  const h = harness([{ never: true }])
  const gate = createGate()
  const ask = createJev(h.io, KEY, { ...OPTS, gate })
  const inflight = Array.from({ length: 4 }, () => failureOf(ask({}, {})))
  await tick()
  expect(h.calls.length).toBe(4)

  expect((await failureOf(ask({}, {}))).reason).toBe('busy')
  expect(h.calls.length).toBe(4)

  h.expire()
  expect((await Promise.all(inflight)).map(f => f.reason)).toEqual(['timeout', 'timeout', 'timeout', 'timeout'])
  // The calls failed open at the deadline but their requests are still running: the slots are held.
  expect(gate.acquire()).toBe(false)
})

test('a slot is held until the request settles, so a burst against a hanging Jev never exceeds four real calls', async () => {
  const settle: (() => void)[] = []
  const timers: (() => void)[] = []
  const holds: (() => void)[] = []
  let started = 0
  const io: JevIo = {
    fetch: () => {
      started += 1
      return new Promise(resolve => { settle.push(() => resolve({ status: 200, text: BODY })) })
    },
    timer: (ms, fn) => ((ms === SLOT_HOLD_MS ? holds : timers).push(fn), () => {}),
    now: () => 0,
  }
  const ask = createJev(io, KEY, { ...OPTS, gate: createGate() })

  const burst = Array.from({ length: 10 }, () => failureOf(ask({}, {})))
  await tick()
  expect(started).toBe(4)
  // At the deadline the four fail open to their callers; the six others were refused at once.
  timers.forEach(fire => fire())
  const reasons = (await Promise.all(burst)).map(f => f.reason).sort()
  expect(reasons).toEqual([...Array(6).fill('busy'), ...Array(4).fill('timeout')].sort())

  // Four requests still run on the account: a new call is refused and no fifth request goes out.
  expect((await failureOf(ask({}, {}))).reason).toBe('busy')
  expect(started).toBe(4)

  // One request settles and frees its slot.
  settle[0]?.()
  await tick()
  const next = ask({}, {})
  await tick()
  expect(started).toBe(5)
  settle[4]?.()
  await next
})

test('the Jev model id is kept for the log only when it looks like one', () => {
  const body = (model: unknown) => JSON.stringify({ model, answers: {} })
  expect(parseBody(body('jev-1.13.0')).model).toBe('jev-1.13.0')
  expect(parseBody(body('org/model:v2')).model).toBeUndefined()
  expect(parseBody(body(`Bearer ${KEY}`)).model).toBeUndefined()
  expect(parseBody(body('x'.repeat(65))).model).toBeUndefined()
  expect(parseBody(body('')).model).toBeUndefined()
  expect(parseBody(body(7)).model).toBeUndefined()
})

test('a slot is released after the hold ceiling even when its fetch never settles', async () => {
  expect(SLOT_HOLD_MS).toBe(60_000)
  const h = harness([{ never: true }])
  const gate = createGate()
  const ask = createJev(h.io, KEY, { ...OPTS, gate })
  const inflight = Array.from({ length: 4 }, () => failureOf(ask({}, {})))
  await tick()
  h.expire()
  await Promise.all(inflight)
  expect(gate.acquire()).toBe(false)

  h.hold()
  expect(gate.acquire()).toBe(true)
  // Released once: a second ceiling firing, or a late settle, does not free a slot that is not its own.
  h.hold()
  expect(gate.acquire()).toBe(true)
  expect(gate.acquire()).toBe(true)
  expect(gate.acquire()).toBe(true)
  expect(gate.acquire()).toBe(false)
})

test('a settled call cancels its ceiling timer, and a call without a gate sets none', async () => {
  const h = harness([{}])
  await createJev(h.io, KEY, { ...OPTS, gate: createGate() })({}, {})
  const hold = h.timers.find(t => t.ms === SLOT_HOLD_MS)
  expect(hold?.cancelled).toBe(true)

  const bare = harness([{}])
  await createJev(bare.io, KEY, OPTS)({}, {})
  expect(bare.timers.some(t => t.ms === SLOT_HOLD_MS)).toBe(false)
})

// --- Characterization: how a failure is classified, pinned before the client's refactor ---

/** A breaker that opens on its first counted failure and pauses for a second; `clock.now` is the test's. */
function fragile() {
  const clock = { now: 0 }
  return { clock, breaker: createBreaker(() => clock.now, { failures: 1, pauseMs: 1_000 }) }
}

test('a 4xx other than 400 and 422, a retried status that stays, a timeout and a dropped connection count against the breaker', async () => {
  const counted: [string, Reply][] = [
    ['401', { status: 401 }],
    ['403', { status: 403 }],
    ['404', { status: 404 }],
    ['429', { status: 429 }],
    ['500', { status: 500 }],
    ['503', { status: 503 }],
    ['a redirect status', { status: 302 }],
    ['a thrown fetch', { throws: new Error('connect failed') }],
  ]
  for (const [name, reply] of counted) {
    const h = harness([reply])
    const { breaker } = fragile()
    await failureOf(createJev(h.io, KEY, { ...OPTS, breaker })({}, {}))
    expect([name, breaker.allow()]).toEqual([name, false])
  }

  const never = harness([{ never: true }])
  const { breaker } = fragile()
  const pending = failureOf(createJev(never.io, KEY, { ...OPTS, breaker })({}, {}))
  await tick()
  never.expire()
  await pending
  expect(breaker.allow()).toBe(false)
})

test('a rejected request and an unreadable 2xx say nothing about the service: they leave the breaker as it was', async () => {
  const silent: [string, Reply][] = [
    ['400', { status: 400 }],
    ['422', { status: 422 }],
    ['text that is not JSON', { text: 'not json' }],
    ['a body without answers', { text: '{}' }],
    ['an answer that is not an object', { text: '{"answers":{"tier":3}}' }],
    ['an empty 2xx body', { text: '' }],
  ]
  for (const [name, reply] of silent) {
    const h = harness([reply])
    const { breaker } = fragile()
    await failureOf(createJev(h.io, KEY, { ...OPTS, breaker })({}, {}))
    expect([name, breaker.allow()]).toEqual([name, true])
  }
})

test('the probe that goes through after the pause decides: a rejected or malformed outcome frees it, a counted failure reopens', async () => {
  const outcomes: [Reply, boolean][] = [
    [{ status: 422 }, true],
    [{ text: 'nope' }, true],
    [{ status: 401 }, false],
    [{ status: 500 }, false],
  ]
  for (const [reply, allowed] of outcomes) {
    const { clock, breaker } = fragile()
    await failureOf(createJev(harness([{ status: 500 }]).io, KEY, { ...OPTS, breaker })({}, {}))
    expect(breaker.allow()).toBe(false)

    clock.now = 1_000
    await failureOf(createJev(harness([reply]).io, KEY, { ...OPTS, breaker })({}, {}))
    expect([JSON.stringify(reply), breaker.allow()]).toEqual([JSON.stringify(reply), allowed])
  }
})

test('an open breaker refuses without a request, frees the slot it took and does not extend the pause', async () => {
  const { clock, breaker } = fragile()
  await failureOf(createJev(harness([{ status: 500 }]).io, KEY, { ...OPTS, breaker })({}, {}))

  const h = harness([{}])
  const gate = createGate(1)
  clock.now = 999
  const refused = await failureOf(createJev(h.io, KEY, { ...OPTS, breaker, gate })({}, {}))
  expect(refused.reason).toBe('breaker')
  expect(refused.message).toBe('paused after repeated failures')
  expect(refused.status).toBeUndefined()
  expect(h.calls).toEqual([])
  expect(gate.acquire()).toBe(true)
  gate.release()

  // The refusal did not count as a failure: the pause still ends at 1000 and the probe goes through.
  clock.now = 1_000
  expect((await createJev(h.io, KEY, { ...OPTS, breaker, gate })({}, {})).answers.tier).toBeDefined()
  expect(h.calls).toHaveLength(1)
})

test('a full gate refuses as busy before the breaker is asked, so the probe is not spent', async () => {
  const { clock, breaker } = fragile()
  await failureOf(createJev(harness([{ status: 500 }]).io, KEY, { ...OPTS, breaker })({}, {}))
  clock.now = 1_000

  const gate = createGate(1)
  expect(gate.acquire()).toBe(true)
  const h = harness([{}])
  const refused = await failureOf(createJev(h.io, KEY, { ...OPTS, breaker, gate })({}, {}))
  expect(refused.reason).toBe('busy')
  expect(refused.message).toBe('too many calls in flight')
  expect(h.calls).toEqual([])
  // The probe is still there: this is the first allow() since the pause ended.
  expect(breaker.allow()).toBe(true)
  expect(breaker.allow()).toBe(false)
})

test('429, 500, 502, 503, 504 and 529 are retried once; other statuses, 3xx included, are not', async () => {
  for (const status of [429, 500, 502, 503, 504, 529]) {
    const h = harness([{ status }])
    const failure = await failureOf(createJev(h.io, KEY, OPTS)({}, {}))
    expect([status, h.calls.length, failure.reason, failure.status]).toEqual([status, 2, 'http', status])
  }
  for (const status of [199, 300, 301, 400, 401, 403, 404, 408, 422, 501]) {
    const h = harness([{ status }])
    const failure = await failureOf(createJev(h.io, KEY, OPTS)({}, {}))
    expect([status, h.calls.length, failure.reason, failure.status]).toEqual([status, 1, 'http', status])
    expect(failure.message).toBe(`HTTP ${status}`)
  }
})

test('the first status that is not retried ends the call, even after a retried one', async () => {
  const h = harness([{ status: 503 }, { status: 401 }])
  const failure = await failureOf(createJev(h.io, KEY, OPTS)({}, {}))

  expect(h.calls).toHaveLength(2)
  expect([failure.reason, failure.status]).toEqual(['http', 401])
})

test('the pause before the retry is Retry-After in seconds, read in any case, between 0 and one second; 250 ms without one', async () => {
  const pauses: [Record<string, string> | undefined, number][] = [
    [undefined, 250],
    [{}, 250],
    [{ 'Retry-After': '0' }, 0],
    [{ 'retry-after': '0.5' }, 500],
    [{ 'RETRY-AFTER': ' 1 ' }, 1_000],
    [{ 'Retry-After': '2' }, 1_000],
    [{ 'Retry-After': '120' }, 1_000],
    [{ 'Retry-After': '-3' }, 0],
    [{ 'Retry-After': 'Wed, 21 Oct 2026 07:28:00 GMT' }, 250],
    [{ 'Retry-After': 'soon' }, 250],
    // An empty value reads as zero seconds.
    [{ 'Retry-After': '' }, 0],
  ]
  for (const [headers, expected] of pauses) {
    const h = harness([{ status: 429, headers }, {}])
    await createJev(h.io, KEY, OPTS)({}, {})
    expect([JSON.stringify(headers), h.timers.filter(t => t.ms !== JEV_DEADLINE_MS).map(t => t.ms)])
      .toEqual([JSON.stringify(headers), [expected]])
  }
})

test('a retry that is waiting for its pause when the deadline passes fails as timeout, not as the status', async () => {
  const timers: { ms: number; fn: () => void }[] = []
  let fetched = 0
  const io: JevIo = {
    fetch: async () => { fetched += 1; return { status: 503, text: '' } },
    timer: (ms, fn) => (timers.push({ ms, fn }), () => {}),
    now: () => 0,
  }
  const breaker = createBreaker(() => 0, { failures: 1 })
  const pending = failureOf(createJev(io, KEY, { ...OPTS, breaker })({}, {}))
  await tick()
  expect(timers.map(t => t.ms)).toEqual([JEV_DEADLINE_MS, 250])

  timers[0]?.fn()
  const failure = await pending
  expect([failure.reason, failure.status, failure.message]).toEqual(['timeout', undefined, 'deadline passed'])
  expect(fetched).toBe(1)
  expect(breaker.allow()).toBe(false)
})

test('a dropped connection is retried once; with less than a second left it is not', async () => {
  const dropped = harness([{ throws: new Error('connect failed') }])
  const failure = await failureOf(createJev(dropped.io, KEY, OPTS)({}, {}))
  expect([failure.reason, failure.status, failure.message]).toEqual(['network', undefined, 'request failed'])
  expect(dropped.calls).toHaveLength(2)

  const slow = harness([{ throws: new Error('connect failed'), spendMs: 2_500 }, {}])
  expect((await failureOf(createJev(slow.io, KEY, OPTS)({}, {}))).reason).toBe('network')
  expect(slow.calls).toHaveLength(1)
})

test('every failure carries its reason, its message and, for a status, the status: nothing else', async () => {
  const seen = async (replies: Reply[], opts: JevOptions = OPTS, key = KEY) => {
    const failure = await failureOf(createJev(harness(replies).io, key, opts)({}, {}))
    return [failure.reason, failure.message, failure.status]
  }

  expect(await seen([{ status: 418 }])).toEqual(['http', 'HTTP 418', 418])
  expect(await seen([{ throws: 'down' }])).toEqual(['network', 'request failed', undefined])
  expect(await seen([{ text: 'not json' }])).toEqual(['malformed', 'response is not JSON', undefined])
  expect(await seen([{ text: '{}' }])).toEqual(['malformed', 'response has no answers object', undefined])
  expect(await seen([{ text: '{"answers":{"tier":3}}' }])).toEqual(['malformed', 'an answer is not an object', undefined])
  expect(await seen([{}], OPTS, '')).toEqual(['config', 'no key', undefined])
  expect(await seen([{}], OPTS, 'a b')).toEqual(['config', 'the key has whitespace or control characters', undefined])

  const full = createGate(1)
  full.acquire()
  expect(await seen([{}], { ...OPTS, gate: full })).toEqual(['busy', 'too many calls in flight', undefined])

  const timeout = harness([{ never: true }])
  const pending = failureOf(createJev(timeout.io, KEY, OPTS)({}, {}))
  await tick()
  timeout.expire()
  const late = await pending
  expect([late.reason, late.message, late.status]).toEqual(['timeout', 'deadline passed', undefined])
  expect(late).toBeInstanceOf(JevFailure)
  expect(late.name).toBe('JevFailure')
})

test('a key is trimmed before it is used, and one with an inner space or control character is refused without a request', async () => {
  const h = harness([{}])
  await createJev(h.io, `  ${KEY}\n`, OPTS)({}, {})
  expect(h.calls[0]?.headers.Authorization).toBe(`Bearer ${KEY}`)

  const refused = harness([{}])
  for (const key of ['a\tb', 'a\u0000b', 'a\u007fb']) {
    expect((await failureOf(createJev(refused.io, key, OPTS)({}, {}))).reason).toBe('config')
  }
  expect(refused.calls).toEqual([])
})

test('a config failure takes no slot and does not count against the breaker', async () => {
  const gate = createGate(1)
  const breaker = createBreaker(() => 0, { failures: 1 })
  await failureOf(createJev(harness([{}]).io, '', { ...OPTS, gate, breaker })({}, {}))

  expect(gate.acquire()).toBe(true)
  expect(breaker.allow()).toBe(true)
})

test('failureText reads a typed failure by its reason and, when it has one, its status', () => {
  expect(failureText(new JevFailure('http', 'HTTP 429', 429))).toBe('http 429')
  expect(failureText(new JevFailure('timeout', 'deadline passed'))).toBe('timeout')
  expect(failureText({ reason: 'busy', status: 503 })).toBe('busy 503')
})

test('failureText reads by shape: what has no string reason is `error`, and the message never appears', () => {
  expect(failureText(new Error('boom with a secret'))).toBe('error')
  expect(failureText(null)).toBe('error')
  expect(failureText(undefined)).toBe('error')
  expect(failureText('network down')).toBe('error')
  expect(failureText({ reason: 5 })).toBe('error')
  expect(failureText({ reason: 5, status: 500 })).toBe('error 500')
  expect(failureText({ reason: 'http', status: '500' })).toBe('http')
})

test('classifyFailure keeps a typed failure as it is and reads anything else as a dropped request', () => {
  const typed = new JevFailure('http', 'HTTP 503', 503)
  expect(classifyFailure(typed).failure).toBe(typed)

  const other = classifyFailure(new TypeError('x'))
  expect(other.failure).toBeInstanceOf(JevFailure)
  expect([other.failure.reason, other.failure.message, other.failure.status]).toEqual(['network', 'request failed', undefined])
  expect(classifyFailure('boom').failure.reason).toBe('network')
  expect(classifyFailure(null).failure.reason).toBe('network')
})

test('classifyFailure counts a failure against the breaker unless the request was rejected or the body unreadable', () => {
  const counts = (failure: JevFailure) => classifyFailure(failure).counts

  expect(counts(new JevFailure('http', 'HTTP 400', 400))).toBe(false)
  expect(counts(new JevFailure('http', 'HTTP 422', 422))).toBe(false)
  expect(counts(new JevFailure('malformed', 'response is not JSON'))).toBe(false)

  expect(counts(new JevFailure('http', 'HTTP 401', 401))).toBe(true)
  expect(counts(new JevFailure('http', 'HTTP 429', 429))).toBe(true)
  expect(counts(new JevFailure('http', 'HTTP 503', 503))).toBe(true)
  expect(counts(new JevFailure('timeout', 'deadline passed'))).toBe(true)
  expect(counts(new JevFailure('network', 'request failed'))).toBe(true)
  expect(classifyFailure(new Error('x')).counts).toBe(true)
})

test('a 503 is retried once while the deadline allows', async () => {
  const h = harness([{ status: 503 }, {}])
  await createJev(h.io, KEY, OPTS)({}, {})
  expect(h.calls.length).toBe(2)
})
