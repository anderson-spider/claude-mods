import { expect, test } from 'claude-code/testing'
import { JEV_DEADLINE_MS, JEV_URL, JevFailure, MAX_CONCURRENT, SLOT_HOLD_MS, createBreaker, createGate, createJev, parseBody } from '../hooks/jev'
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
