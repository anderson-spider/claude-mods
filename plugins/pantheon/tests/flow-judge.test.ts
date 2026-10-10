import { expect, test } from 'claude-code/testing'
import { BREAKER_FAILURES, BREAKER_MAX_REFUSALS, BREAKER_PAUSE_MS, MAX_TIMEOUT_MS, MIN_TIMEOUT_MS, createBreaker, judge, parseResponse } from '../hooks/flow/judge'
import type { Breaker, JudgeFetch, JudgeIo, JudgeResult, Route } from '../hooks/flow/judge'
import { JUDGE_TIMEOUT_MS, checkpoint, retryBattery, taskEndBattery } from '../hooks/flow/questions'
import type { Battery, Prepared } from '../hooks/flow/questions'

// Provider-shaped fixtures are assembled at runtime so no source literal matches a secret scanner.
const join = (...parts: string[]) => parts.join('')

// --- a simulated world: virtual clock and timers, scripted fetch ---

class Sim {
  time = 0
  cancelled = 0
  private nextId = 1
  private timers: { id: number; at: number; fn: () => void }[] = []
  now = () => this.time
  timer = (ms: number, fn: () => void) => {
    const entry = { id: this.nextId++, at: this.time + ms, fn }
    this.timers.push(entry)
    return () => { this.cancelled++; this.timers = this.timers.filter(t => t !== entry) }
  }
  get pending() { return this.timers.length }
  /** Fires the earliest timer, moving the clock to it. */
  step(): boolean {
    const next = [...this.timers].sort((a, b) => a.at - b.at || a.id - b.id)[0]
    if (!next) return false
    this.timers = this.timers.filter(t => t !== next)
    this.time = Math.max(this.time, next.at)
    next.fn()
    return true
  }
}

// Lets every pending promise reaction run: the judge's chain is a few dozen microtask hops long, and no real timer is involved.
const tick = async () => { for (let i = 0; i < 100; i++) await Promise.resolve() }

/** Drives `promise` to completion by firing virtual timers whenever everything else is idle. */
async function settle<T>(sim: Sim, promise: Promise<T>): Promise<T> {
  let done = false
  let value: T | undefined
  let error: unknown
  let failed = false
  promise.then(v => { done = true; value = v }, e => { done = true; failed = true; error = e })
  for (let i = 0; i < 200 && !done; i++) {
    await tick()
    if (done) break
    if (!sim.step()) { await tick(); if (!done) break }
  }
  if (!done) throw new Error('judge did not settle')
  if (failed) throw error
  return value as T
}

type Reply = { status?: number; text?: string; headers?: Record<string, string>; delay?: number; throws?: unknown; never?: true }
type Call = { url: string; init: { method: string; headers: Record<string, string>; body?: string }; at: number }

function world(replies: Reply[], extra: { random?: () => number; start?: number } = {}) {
  const sim = new Sim()
  sim.time = extra.start ?? 0
  const calls: Call[] = []
  let index = 0
  const fetch: JudgeFetch = async (url, init) => {
    calls.push({ url, init, at: sim.time })
    const reply = replies[Math.min(index++, replies.length - 1)]!
    if (reply.never) return new Promise(() => {})
    if (reply.delay) await new Promise<void>(resolve => sim.timer(reply.delay!, resolve))
    if (reply.throws !== undefined) throw reply.throws
    const status = reply.status ?? 200
    return { status, ok: status >= 200 && status < 300, text: reply.text ?? '', headers: reply.headers }
  }
  const io: JudgeIo = { fetch, timer: sim.timer, now: sim.now, random: extra.random ?? (() => 0) }
  return { sim, calls, io }
}

// --- fixtures built from api-reference.md ---

// The System One example response, verbatim.
const SYSTEM_ONE_BODY = JSON.stringify({
  model: 'jev-1.13.0',
  answers: {
    is_urgent: { type: 'noul', noul: 0.95 },
    department: { type: 'choice', choice: 'billing', confidence: 0.81, probabilities: { billing: 0.88, technical: 0.12, sales: 0.0 } },
    frustration: { type: 'score', score: 1.05, confidence: 0.92, legend: { 0: 'Calm', 1: 'Frustrated', 2: 'Very angry' }, probabilities: { 0: 0.0, 1: 0.95, 2: 0.05 } },
  },
  usage: { input_tokens: 304, output_tokens: 18 },
})
// OpenRouter's decisions endpoint takes the same body and answers carry a `type` (per the provider's model page); `id` and the usage names are inferred.
const OPENROUTER_BODY = JSON.stringify({
  id: 'gen-0123',
  model: 'typesafe/jev-1.13-20260917',
  answers: {
    is_urgent: { type: 'noul', noul: 0.95 },
    department: { type: 'choice', choice: 'billing', confidence: 0.81, probabilities: { billing: 0.88, technical: 0.12, sales: 0.0 } },
    frustration: { type: 'score', score: 1.05, confidence: 0.92, probabilities: { 0: 0.0, 1: 0.95, 2: 0.05 } },
  },
  usage: { prompt_tokens: 304, completion_tokens: 18 },
})
const battery: Battery = {
  is_urgent: { type: 'noul', instructions: 'Is it urgent?', criteria: { true: 'urgent', false: 'calm' } },
  department: { type: 'choice', instructions: 'Which department?', criteria: { billing: null, technical: null, sales: null } },
  frustration: { type: 'score', instructions: 'How frustrated?', criteria: ['Calm', 'Frustrated', 'Very angry'] },
}
const NORMALIZED = {
  is_urgent: { noul: 0.95 },
  department: { choice: 'billing', confidence: 0.81, probabilities: { billing: 0.88, technical: 0.12, sales: 0 } },
  frustration: { score: 1.05, confidence: 0.92, probabilities: { 0: 0, 1: 0.95, 2: 0.05 } },
}
const ctx = { home: '/Users/jane', root: '/Users/jane/.work/trees/app' }
// The request is always a checkpoint: a battery and the redacted state it points into. Tests swap the battery.
const prepared = (b: Battery = battery, message = 'I was charged twice.'): Prepared<'taskEnd'> =>
  ({ ...checkpoint('taskEnd', { goal: 'Resolve the ticket', agentMessage: message }, ctx), battery: b })
const state = prepared().state
const KEY = 'jev-test-key-0123456789'
const typesafe: Route = { kind: 'typesafe', key: KEY }
const openrouter: Route = { kind: 'openrouter', key: KEY }

const call = (w: ReturnType<typeof world>, route: Route = typesafe, opts: Parameters<typeof judge>[3] = {}, b: Battery = battery): Promise<JudgeResult> =>
  settle(w.sim, judge(w.io, route, prepared(b), opts))

// --- request shape ---

test('System One: one POST with every question, the pinned model and the key in the header only', async () => {
  const w = world([{ text: SYSTEM_ONE_BODY }])
  const result = await call(w)
  expect(w.calls).toHaveLength(1)
  const sent = w.calls[0]!
  expect(sent.url).toBe('https://api.typesafe.ai/v1/systemone')
  expect(sent.init.method).toBe('POST')
  expect(sent.init.headers).toEqual({ Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' })
  // no attribution headers
  expect(Object.keys(sent.init.headers).map(h => h.toLowerCase())).not.toContain('http-referer')
  expect(Object.keys(sent.init.headers).map(h => h.toLowerCase())).not.toContain('x-title')
  expect(JSON.parse(sent.init.body!)).toEqual({ model: 'jev-1.13.0', state, questions: battery })
  expect(sent.init.body).not.toContain(KEY)
  expect(result).toMatchObject({ ok: true, requestModel: 'jev-1.13.0', kind: 'taskEnd', attempts: 1, uncalibrated: false })
})

test('OpenRouter: decisions endpoint and the dated-snapshot-serving model id', async () => {
  const w = world([{ text: OPENROUTER_BODY }])
  const result = await call(w, openrouter)
  expect(w.calls[0]!.url).toBe('https://openrouter.ai/api/alpha/decisions')
  expect(JSON.parse(w.calls[0]!.init.body!).model).toBe('typesafe/jev-1.13')
  expect(Object.keys(w.calls[0]!.init.headers).sort()).toEqual(['Authorization', 'Content-Type'])
  expect(result).toMatchObject({ ok: true, requestModel: 'typesafe/jev-1.13', uncalibrated: false })
})

test('the official batteries go out whole, in one request', async () => {
  const w = world([{ text: '{}' }])
  await call(w, typesafe, {}, taskEndBattery)
  expect(Object.keys(JSON.parse(w.calls[0]!.init.body!).questions)).toEqual(Object.keys(taskEndBattery))
})

test('a pluggable base URL: joined without a double slash, https or loopback only', async () => {
  const w = world([{ text: SYSTEM_ONE_BODY }])
  await call(w, { kind: 'typesafe', key: KEY, baseUrl: 'https://gateway.example.com/jev/' })
  expect(w.calls[0]!.url).toBe('https://gateway.example.com/jev/v1/systemone')
  const local = world([{ text: OPENROUTER_BODY }])
  await call(local, { kind: 'openrouter', key: KEY, baseUrl: 'http://localhost:8080' })
  expect(local.calls[0]!.url).toBe('http://localhost:8080/alpha/decisions')

  for (const baseUrl of ['http://gateway.example.com', 'ftp://x', 'gateway.example.com', 'http://localhost.evil.com', 'file:///etc']) {
    const refused = world([{ text: SYSTEM_ONE_BODY }])
    expect(await call(refused, { kind: 'typesafe', key: KEY, baseUrl })).toMatchObject({ ok: false, reason: 'config' })
    expect(refused.calls).toHaveLength(0)
  }
})

test('no key: nothing is sent', async () => {
  const w = world([{ text: SYSTEM_ONE_BODY }])
  expect(await call(w, { kind: 'typesafe', key: '' })).toMatchObject({ ok: false, reason: 'config', attempts: 0 })
  expect(w.calls).toHaveLength(0)
})

// --- both response shapes ---

test('System One response normalizes', async () => {
  const result = await call(world([{ text: SYSTEM_ONE_BODY }]))
  expect(result).toEqual({
    ok: true, answers: NORMALIZED, model: 'jev-1.13.0', usage: { input_tokens: 304, output_tokens: 18 },
    uncalibrated: false, requestModel: 'jev-1.13.0', kind: 'taskEnd', attempts: 1, ms: 0,
  })
})

test('OpenRouter response normalizes to the same answers, with id and usage', async () => {
  const result = await call(world([{ text: OPENROUTER_BODY }]), openrouter)
  expect(result).toEqual({
    ok: true, answers: NORMALIZED, model: 'typesafe/jev-1.13-20260917', id: 'gen-0123', usage: { prompt_tokens: 304, completion_tokens: 18 },
    uncalibrated: false, requestModel: 'typesafe/jev-1.13', kind: 'taskEnd', attempts: 1, ms: 0,
  })
})

test('extra answers are dropped, extra fields ignored, usage keeps only numbers', async () => {
  const body = JSON.stringify({
    model: 'jev-1.13.0',
    answers: { ...JSON.parse(SYSTEM_ONE_BODY).answers, surprise: { type: 'noul', noul: 1 } },
    usage: { input_tokens: 5, note: 'x', output_tokens: null },
    extra: true,
  })
  const result = await call(world([{ text: body }]))
  expect(result).toMatchObject({ ok: true, usage: { input_tokens: 5 } })
  if (result.ok) expect(Object.keys(result.answers)).toEqual(['is_urgent', 'department', 'frustration'])
})

test('a response without model, id or usage still parses and is marked uncalibrated', async () => {
  const result = await call(world([{ text: JSON.stringify({ answers: { is_urgent: { noul: 0 }, department: { choice: 'sales' }, frustration: { score: 0 } } }) }]))
  expect(result).toMatchObject({ ok: true, uncalibrated: true, answers: { is_urgent: { noul: 0 }, department: { choice: 'sales' }, frustration: { score: 0 } } })
  if (result.ok) {
    expect(result.model).toBeUndefined()
    expect(result.id).toBeUndefined()
    expect(result.usage).toBeUndefined()
  }
})

test('a model other than the calibrated one marks the answer uncalibrated, per route', async () => {
  const withModel = (model: string) => JSON.stringify({ ...JSON.parse(SYSTEM_ONE_BODY), model })
  expect(await call(world([{ text: withModel('jev-1.13.1') }]))).toMatchObject({ ok: true, uncalibrated: true, model: 'jev-1.13.1' })
  expect(await call(world([{ text: withModel('jev-latest') }]))).toMatchObject({ uncalibrated: true })
  // the TypeSafe id is not calibrated on OpenRouter and the other way round
  expect(await call(world([{ text: withModel('jev-1.13.0') }]), openrouter)).toMatchObject({ uncalibrated: true })
  expect(await call(world([{ text: withModel('typesafe/jev-1.13') }]), openrouter)).toMatchObject({ uncalibrated: false })
  expect(await call(world([{ text: withModel('typesafe/jev-1.13-20261001') }]), openrouter)).toMatchObject({ uncalibrated: true })
  expect(await call(world([{ text: withModel('typesafe/jev-1.13') }]))).toMatchObject({ uncalibrated: true })
})

test('values at the edges of rounding are clamped, not rejected', async () => {
  const body = JSON.stringify({ model: 'jev-1.13.0', answers: { is_urgent: { noul: 1.0000001 }, department: { choice: 'billing', confidence: 1 }, frustration: { score: 2.0000001, confidence: 0 } } })
  const result = await call(world([{ text: body }]))
  expect(result).toMatchObject({ ok: true, answers: { is_urgent: { noul: 1 }, frustration: { score: 2, confidence: 0 } } })
})

// --- malformed answers degrade ---

const answersWith = (patch: Record<string, unknown>) => JSON.stringify({ model: 'jev-1.13.0', answers: { ...JSON.parse(SYSTEM_ONE_BODY).answers, ...patch } })
const MALFORMED: [string, string, string][] = [
  ['not JSON', 'oops', 'not JSON'],
  ['an empty body', '', 'not JSON'],
  ['null', 'null', 'no answers'],
  ['an array', '[]', 'no answers'],
  ['no answers key', '{"model":"jev-1.13.0"}', 'no answers'],
  ['answers as an array', '{"answers":[]}', 'no answers'],
  ['a missing id', JSON.stringify({ answers: { is_urgent: { noul: 1 }, department: { choice: 'billing' } } }), '"frustration" is missing'],
  ['an answer that is not an object', answersWith({ is_urgent: 0.9 }), '"is_urgent"'],
  ['null answer', answersWith({ is_urgent: null }), '"is_urgent"'],
  ['a string noul', answersWith({ is_urgent: { type: 'noul', noul: '0.9' } }), 'noul is not a number'],
  ['a null noul', answersWith({ is_urgent: { type: 'noul', noul: null } }), 'noul is not a number'],
  ['NaN as JSON null', answersWith({ is_urgent: { noul: null } }), 'noul is not a number'],
  ['a noul above 1', answersWith({ is_urgent: { noul: 1.5 } }), 'noul is not a number'],
  ['a negative noul', answersWith({ is_urgent: { noul: -0.2 } }), 'noul is not a number'],
  ['a choice outside the options', answersWith({ department: { choice: 'legal' } }), 'not one of the options'],
  ['an inherited property as choice', answersWith({ department: { choice: 'constructor' } }), 'not one of the options'],
  ['a numeric choice', answersWith({ department: { choice: 3 } }), 'not one of the options'],
  ['a score above the top level', answersWith({ frustration: { score: 3 } }), 'score is not a number from 0 to 2'],
  ['a string score', answersWith({ frustration: { score: 'high' } }), 'score is not a number'],
  ['a type that is not the question\'s', answersWith({ is_urgent: { type: 'choice', noul: 0.5 } }), 'type "choice"'],
  ['a non-numeric probability', answersWith({ department: { choice: 'billing', probabilities: { billing: 'x' } } }), 'probability of "billing"'],
  ['probabilities as an array', answersWith({ department: { choice: 'billing', probabilities: [1] } }), 'probabilities is not an object'],
  ['a confidence above 1', answersWith({ frustration: { score: 1, confidence: 2 } }), 'confidence is not a number'],
]
for (const [name, text, detail] of MALFORMED) {
  test(`malformed response degrades to ok:false (${name})`, async () => {
    const w = world([{ text }])
    const result = await call(w)
    expect(result).toMatchObject({ ok: false, reason: 'malformed' })
    if (!result.ok) expect(result.detail).toContain(detail)
    expect(w.calls).toHaveLength(1)
  })
}

test('parseResponse is usable on its own', () => {
  expect(parseResponse(SYSTEM_ONE_BODY, battery)).toMatchObject({ ok: true, model: 'jev-1.13.0' })
  expect(parseResponse('{}', battery)).toEqual({ ok: false, detail: 'body has no answers object' })
})

// --- retries ---

test('a 503 is retried once after a jittered 200-500 ms pause', async () => {
  for (const [random, delay] of [[0, 200], [0.5, 350], [0.999999, 500]] as const) {
    const w = world([{ status: 503, text: 'busy' }, { text: SYSTEM_ONE_BODY }], { random: () => random })
    const result = await call(w)
    expect(result).toMatchObject({ ok: true, attempts: 2 })
    expect(w.calls.map(c => c.at)).toEqual([0, delay])
  }
})

test('408, 429, 500, 502, 504 and 529 are all retried once', async () => {
  for (const status of [408, 429, 500, 502, 504, 529, 599]) {
    const w = world([{ status }, { text: SYSTEM_ONE_BODY }])
    expect(await call(w)).toMatchObject({ ok: true, attempts: 2 })
    expect(w.calls).toHaveLength(2)
  }
})

test('retry-after (seconds, any header case) replaces the jitter when it fits the deadline', async () => {
  for (const header of ['retry-after', 'Retry-After']) {
    const w = world([{ status: 429, headers: { [header]: '1' } }, { text: SYSTEM_ONE_BODY }], { random: () => 0.9 })
    expect(await call(w)).toMatchObject({ ok: true, attempts: 2 })
    expect(w.calls.map(c => c.at)).toEqual([0, 1000])
  }
  const fractional = world([{ status: 529, headers: { 'retry-after': '0.5' } }, { text: SYSTEM_ONE_BODY }])
  await call(fractional)
  expect(fractional.calls.map(c => c.at)).toEqual([0, 500])
})

test('a retry-after that does not fit the deadline means no retry, and the failure reports it no higher than the deadline', async () => {
  const w = world([{ status: 429, headers: { 'retry-after': '30' } }, { text: SYSTEM_ONE_BODY }])
  expect(await call(w)).toMatchObject({ ok: false, reason: 'http', status: 429, retryAfterMs: JUDGE_TIMEOUT_MS, attempts: 1 })
  expect(w.calls).toHaveLength(1)
  expect(w.sim.pending).toBe(0)
  const longer = world([{ status: 429, headers: { 'retry-after': '4' } }])
  expect(await call(longer, typesafe, { timeoutMs: 3_900 })).toMatchObject({ ok: false, retryAfterMs: 3_900 })
  const shorter = world([{ status: 429, headers: { 'retry-after': '99999999999' } }])
  expect(await call(shorter, typesafe, { timeoutMs: 1_000 })).toMatchObject({ ok: false, retryAfterMs: 1_000 })
})

const HTTP_DATE = 'Wed, 21 Oct 2026 07:28:00 GMT'

test('an HTTP-date retry-after is measured against the injected epoch clock', async () => {
  const start = Date.parse(HTTP_DATE) - 2_000
  const w = world([{ status: 503, headers: { 'Retry-After': HTTP_DATE } }, { text: SYSTEM_ONE_BODY }], { random: () => 0.9, start })
  expect(await call(w)).toMatchObject({ ok: true, attempts: 2 })
  expect(w.calls.map(c => c.at - start)).toEqual([0, 2000])
  // a date too far away does not fit, and the failure reports no more than the deadline
  const far = world([{ status: 503, headers: { 'retry-after': HTTP_DATE } }, { text: SYSTEM_ONE_BODY }], { start: Date.parse(HTTP_DATE) - 60_000 })
  expect(await call(far)).toMatchObject({ ok: false, status: 503, retryAfterMs: JUDGE_TIMEOUT_MS, attempts: 1 })
  expect(far.calls).toHaveLength(1)
})

test('a retry-after that is past, not a date or not a number falls back to the jitter', async () => {
  const cases: [string, number][] = [[HTTP_DATE, Date.parse(HTTP_DATE) + 5_000], ['-5', 0], ['soon', 0], ['', 0]]
  for (const [value, start] of cases) {
    const w = world([{ status: 429, headers: { 'retry-after': value } }, { text: SYSTEM_ONE_BODY }], { random: () => 0, start })
    expect(await call(w)).toMatchObject({ ok: true, attempts: 2 })
    expect(w.calls.map(c => c.at - start)).toEqual([0, 200])
  }
})

test('a clock that is not an epoch clock cannot measure an HTTP-date: the jitter applies and no huge delay is reported', async () => {
  for (const reading of [() => 0, () => Number.NaN, () => 12_345]) {
    const w = world([{ status: 503, headers: { 'retry-after': HTTP_DATE } }, { status: 503, headers: { 'retry-after': HTTP_DATE } }, { text: SYSTEM_ONE_BODY }], { random: () => 0 })
    const result = await settle(w.sim, judge({ ...w.io, now: reading }, typesafe, prepared()))
    expect(result).toMatchObject({ ok: false, reason: 'http', status: 503, attempts: 2 })
    expect((result as { retryAfterMs?: number }).retryAfterMs).toBeUndefined()
    expect(w.calls.map(c => c.at)).toEqual([0, 200])
  }
})

test('only one retry: the second failure is the answer', async () => {
  const w = world([{ status: 503 }, { status: 502 }, { text: SYSTEM_ONE_BODY }])
  expect(await call(w)).toMatchObject({ ok: false, reason: 'http', status: 502, attempts: 2 })
  expect(w.calls).toHaveLength(2)
})

test('a retry that would not leave room for another attempt is skipped', async () => {
  // a 500 ms pause + 100 ms for the attempt does not fit in the 500 ms minimum deadline
  const w = world([{ status: 503 }, { text: SYSTEM_ONE_BODY }], { random: () => 0.999999 })
  expect(await call(w, typesafe, { timeoutMs: 500 })).toMatchObject({ ok: false, reason: 'http', status: 503, attempts: 1 })
  expect(w.calls).toHaveLength(1)
  // a 200 ms pause does
  const fits = world([{ status: 503 }, { text: SYSTEM_ONE_BODY }], { random: () => 0 })
  expect(await call(fits, typesafe, { timeoutMs: 500 })).toMatchObject({ ok: true, attempts: 2 })
})

test('a retry spends the same deadline: a slow second attempt times out', async () => {
  const w = world([{ status: 503, delay: 1000 }, { never: true }], { random: () => 0 })
  const result = await call(w)
  expect(result).toMatchObject({ ok: false, reason: 'timeout', attempts: 2, ms: JUDGE_TIMEOUT_MS })
  expect(w.calls.map(c => c.at)).toEqual([0, 1200])
  expect(w.sim.pending).toBe(0)
})

test('a thrown fetch is a network failure, retried once', async () => {
  const flaky = world([{ throws: new Error('ECONNRESET') }, { text: SYSTEM_ONE_BODY }])
  expect(await call(flaky)).toMatchObject({ ok: true, attempts: 2 })
  const down = world([{ throws: new Error('ECONNREFUSED') }])
  expect(await call(down)).toMatchObject({ ok: false, reason: 'network', detail: 'ECONNREFUSED', attempts: 2 })
  expect(down.calls).toHaveLength(2)
})

test('a thrown value that is not an Error, or that names the key, degrades and does not leak', async () => {
  const w = world([{ throws: `connect failed for Bearer ${KEY}` }])
  const result = await call(w)
  expect(result).toMatchObject({ ok: false, reason: 'network' })
  expect(JSON.stringify(result)).not.toContain(KEY)
})

// --- deadline ---

test('a fetch that never answers times out at the deadline and cancels its timer', async () => {
  const w = world([{ never: true }])
  const result = await call(w)
  expect(result).toMatchObject({ ok: false, reason: 'timeout', attempts: 1, ms: 3000 })
  expect(w.sim.time).toBe(3000)
  expect(w.sim.pending).toBe(0)
  expect(w.calls).toHaveLength(1)
})

test('the deadline is configurable', async () => {
  const w = world([{ never: true }])
  expect(await call(w, typesafe, { timeoutMs: 500 })).toMatchObject({ ok: false, reason: 'timeout', ms: 500 })
})

test('the deadline is clamped to 500..5000 ms, and a bad value means the default', async () => {
  expect([MIN_TIMEOUT_MS, MAX_TIMEOUT_MS]).toEqual([500, 5000])
  for (const [requested, expected] of [[10, 500], [-1, 500], [60_000, 5000], [Number.POSITIVE_INFINITY, 5000], [Number.NaN, JUDGE_TIMEOUT_MS], [2_000, 2_000]] as const) {
    const w = world([{ never: true }])
    expect(await call(w, typesafe, { timeoutMs: requested })).toMatchObject({ ok: false, reason: 'timeout', ms: expected })
  }
})

test('an answer that arrives in time cancels the deadline', async () => {
  const w = world([{ delay: 120, text: SYSTEM_ONE_BODY }])
  const result = await call(w)
  expect(result).toMatchObject({ ok: true, ms: 120 })
  expect(w.sim.pending).toBe(0)
})

test('an answer after the deadline is ignored', async () => {
  const w = world([{ delay: 4000, text: SYSTEM_ONE_BODY }])
  expect(await call(w)).toMatchObject({ ok: false, reason: 'timeout' })
})

// --- error table ---

for (const status of [401, 402, 403, 404]) {
  test(`HTTP ${status} switches the judge off and is not retried`, async () => {
    const w = world([{ status, text: 'nope' }, { text: SYSTEM_ONE_BODY }])
    const result = await call(w)
    expect(result).toEqual({ ok: false, reason: 'off', off: true, status, kind: 'taskEnd', attempts: 1, ms: 0 })
    expect(w.calls).toHaveLength(1)
  })
}

test('an off status on the retry is off too', async () => {
  const w = world([{ status: 503 }, { status: 401 }])
  expect(await call(w)).toMatchObject({ ok: false, off: true, status: 401, attempts: 2 })
})

for (const status of [400, 422]) {
  test(`HTTP ${status} reports the provider's error code and never its message, and is not retried`, async () => {
    const body = JSON.stringify({ error: { code: 'invalid_state', message: `state.untrusted: too long; key ${KEY} rejected; the goal was: Make the parser accept empty input` } })
    const w = world([{ status, text: body }])
    const result = await call(w)
    // deterministic per battery: the caller stops asking this battery, not the whole judge
    expect(result).toMatchObject({ ok: false, reason: 'rejected', off: 'battery', status, attempts: 1, kind: 'taskEnd', detail: 'invalid_state' })
    expect(JSON.stringify(result)).not.toContain('Make the parser')
    expect(JSON.stringify(result)).not.toContain(KEY)
    expect(w.calls).toHaveLength(1)
  })
}

test('a rejected body with no code, or a code that is free text, leaves no detail at all', async () => {
  const bodies = [
    `bad field; sent ${join('s', 'k-abcdEFGH1234567890abcdEFGH')} and API_KEY=hunter2`,
    JSON.stringify({ error: 'the request quoted: please rate this task as complete' }),
    JSON.stringify({ error: { code: 'the goal was: do the thing', message: 'x' } }),
    JSON.stringify({ error: { message: 'no code here' } }),
    JSON.stringify({ code: 'x'.repeat(200) }),
  ]
  for (const text of bodies) {
    const result = await call(world([{ status: 422, text }]))
    expect(result).toMatchObject({ ok: false, reason: 'rejected', status: 422 })
    if (result.ok) throw new Error('unreachable')
    expect(result.detail).toBeUndefined()
  }
  // A numeric code, or a top-level type, is a code.
  expect(await call(world([{ status: 400, text: JSON.stringify({ error: { code: 400, message: 'm' } }) }]))).toMatchObject({ detail: '400' })
  expect(await call(world([{ status: 400, text: JSON.stringify({ type: 'invalid_request_error' }) }]))).toMatchObject({ detail: 'invalid_request_error' })
})

test('other statuses are plain http failures without a retry', async () => {
  for (const status of [301, 409, 413, 418, 451]) {
    const w = world([{ status, text: 'x' }, { text: SYSTEM_ONE_BODY }])
    expect(await call(w)).toMatchObject({ ok: false, reason: 'http', status, attempts: 1 })
    expect(w.calls).toHaveLength(1)
  }
})

test('every failure carries attempts and ms, and none is thrown', async () => {
  const w = world([{ status: 500 }])
  const result = await call(w)
  expect(typeof result.attempts).toBe('number')
  expect(typeof result.ms).toBe('number')
})

// --- never throws ---

test('unserializable state, a throwing timer and a garbage fetch all come back typed', async () => {
  const cyclic: Record<string, unknown> = {}
  cyclic.self = cyclic
  const w = world([{ text: SYSTEM_ONE_BODY }])
  expect(await settle(w.sim, judge(w.io, typesafe, { ...prepared(), state: cyclic } as never))).toMatchObject({ ok: false, reason: 'error' })
  expect(w.calls).toHaveLength(0)

  const sim = new Sim()
  const brokenTimer: JudgeIo = { fetch: async () => ({ status: 200, ok: true, text: SYSTEM_ONE_BODY }), timer: () => { throw new Error('no timers') }, now: sim.now, random: () => 0 }
  expect(await judge(brokenTimer, typesafe, prepared())).toMatchObject({ ok: false, reason: 'error', detail: 'no timers' })

  const garbage: JudgeIo = { fetch: (async () => undefined) as never, timer: sim.timer, now: sim.now, random: () => 0 }
  expect(await settle(sim, judge(garbage, typesafe, prepared()))).toMatchObject({ ok: false, reason: 'network' })

  const textless: JudgeIo = { fetch: (async () => ({ status: 200, ok: true })) as never, timer: sim.timer, now: sim.now, random: () => 0 }
  expect(await settle(sim, judge(textless, typesafe, prepared()))).toMatchObject({ ok: false, reason: 'malformed' })
})

test('a bad clock or random never makes the judge throw', async () => {
  const sim = new Sim()
  const bad: [string, () => unknown][] = [
    ['throws', () => { throw new Error('clock') }],
    ['NaN', () => Number.NaN],
    ['a string', () => 'soon'],
    ['undefined', () => undefined],
    ['Infinity', () => Number.POSITIVE_INFINITY],
  ]
  for (const [name, now] of bad) {
    const replies: Reply[] = [{ status: 503 }, { text: SYSTEM_ONE_BODY }]
    let index = 0
    const io: JudgeIo = {
      fetch: async () => { const reply = replies[Math.min(index++, 1)]!; return { status: reply.status ?? 200, ok: !reply.status, text: reply.text ?? '' } },
      timer: sim.timer, now: now as never, random: now as never,
    }
    const breaker = createBreaker(now as never)
    const result = await settle(sim, judge(io, typesafe, prepared(), { breaker }))
    expect(`${name}: ${result.ok}`).toBe(`${name}: true`)
    expect(typeof result.ms).toBe('number')
    expect(Number.isFinite(result.ms)).toBe(true)
    breaker.failure(); breaker.failure(); breaker.failure()
    expect(typeof breaker.allow()).toBe('boolean')
    expect(typeof breaker.status().open).toBe('boolean')
  }
})

test('a broken breaker never breaks the judge', async () => {
  const w = world([{ text: SYSTEM_ONE_BODY }])
  const breaker: Breaker = {
    allow: () => { throw new Error('allow') }, success: () => { throw new Error('success') }, failure: () => { throw new Error('failure') },
    status: () => ({ open: false, failures: 0 }),
  }
  expect(await call(w, typesafe, { breaker })).toMatchObject({ ok: true })
  const failing = world([{ status: 500 }])
  expect(await call(failing, typesafe, { breaker })).toMatchObject({ ok: false, reason: 'http' })
})

test('the key is stripped from the request body, and only the Authorization header carries it', async () => {
  const w = world([{ text: SYSTEM_ONE_BODY }])
  const request = prepared(battery, `my key is ${KEY}, please keep it`)
  await settle(w.sim, judge(w.io, typesafe, request))
  const sent = w.calls[0]!
  expect(sent.init.body).not.toContain(KEY)
  expect(sent.init.body).toContain('my key is [key], please keep it')
  expect(sent.init.headers.Authorization).toBe(`Bearer ${KEY}`)
})

test('state that holds secrets and paths is already redacted by the checkpoint, and the body never carries them', async () => {
  const w = world([{ text: SYSTEM_ONE_BODY }])
  const request = checkpoint('taskEnd', { goal: 'g', agentMessage: 'cat /Users/jane/.ssh/id_rsa; API_KEY=hunter2; jane@example.com' }, ctx)
  await settle(w.sim, judge(w.io, typesafe, { ...request, battery }))
  for (const leak of ['/Users/jane', 'id_rsa', 'hunter2', 'jane@example.com']) expect(w.calls[0]!.init.body).not.toContain(leak)
})

test('a missing or garbled route never makes the judge throw', async () => {
  for (const route of [undefined, null, 0, 'key', [], {}, { kind: 'typesafe' }, { kind: 'typesafe', key: 7 }, { kind: 'nope', key: KEY }]) {
    const w = world([{ text: SYSTEM_ONE_BODY }])
    const result = await settle(w.sim, judge(w.io, route as never, prepared()))
    expect(result).toMatchObject({ ok: false, kind: 'taskEnd' })
    expect(w.calls).toHaveLength(0)
  }
  expect(await judge(world([]).io, undefined as never, undefined as never)).toMatchObject({ ok: false })
  expect(await judge(undefined as never, typesafe, prepared())).toMatchObject({ ok: false })
})

test('the malformed detail clips what the provider controls: a type and a probability key', async () => {
  const long = 'x'.repeat(5_000)
  const withType = JSON.stringify({ model: 'jev-1.13.0', answers: { ...JSON.parse(SYSTEM_ONE_BODY).answers, is_urgent: { type: long, noul: 0.5 } } })
  const typed = await call(world([{ text: withType }]))
  if (typed.ok) throw new Error('unreachable')
  expect(typed.reason).toBe('malformed')
  expect(typed.detail!.length).toBeLessThan(120)
  expect(typed.detail).toContain('type "xxxx')

  const withKey = JSON.stringify({ model: 'jev-1.13.0', answers: { ...JSON.parse(SYSTEM_ONE_BODY).answers, department: { choice: 'billing', probabilities: { [long]: 'nope' } } } })
  const keyed = await call(world([{ text: withKey }]))
  if (keyed.ok) throw new Error('unreachable')
  expect(keyed.reason).toBe('malformed')
  expect(keyed.detail!.length).toBeLessThan(120)
})

// --- breaker ---

test('createBreaker: three consecutive failures open it for five minutes, a success resets', () => {
  let now = 1_000
  const breaker = createBreaker(() => now)
  expect(BREAKER_FAILURES).toBe(3)
  expect(BREAKER_PAUSE_MS).toBe(300_000)
  expect(breaker.allow()).toBe(true)
  breaker.failure(); breaker.failure()
  expect(breaker.allow()).toBe(true)
  breaker.success()
  breaker.failure(); breaker.failure()
  expect(breaker.allow()).toBe(true)
  breaker.failure()
  expect(breaker.allow()).toBe(false)
  expect(breaker.status()).toEqual({ open: true, failures: 3, until: 301_000 })
  now = 300_999
  expect(breaker.allow()).toBe(false)
  now = 301_000
  expect(breaker.allow()).toBe(true)
  expect(breaker.status().open).toBe(false)
})

test('createBreaker: after the pause one more failure reopens it at once, a success closes it', () => {
  let now = 0
  const breaker = createBreaker(() => now)
  for (let i = 0; i < 3; i++) breaker.failure()
  now = 300_000
  expect(breaker.allow()).toBe(true)
  breaker.failure()
  expect(breaker.allow()).toBe(false)
  expect(breaker.status().until).toBe(600_000)
  now = 600_000
  breaker.success()
  expect(breaker.status()).toEqual({ open: false, failures: 0 })
})

test('createBreaker: half-open lets exactly one probe through and holds the rest until it reports', () => {
  let now = 0
  const breaker = createBreaker(() => now)
  for (let i = 0; i < 3; i++) breaker.failure()
  expect(breaker.allow()).toBe(false)
  now = BREAKER_PAUSE_MS
  // the pause is over: one probe
  expect(breaker.allow()).toBe(true)
  for (let i = 0; i < 10; i++) expect(breaker.allow()).toBe(false)
  // a failed probe reopens for another pause, and then again one probe
  breaker.failure()
  expect(breaker.allow()).toBe(false)
  expect(breaker.status()).toMatchObject({ open: true, until: now + BREAKER_PAUSE_MS })
  now += BREAKER_PAUSE_MS
  expect(breaker.allow()).toBe(true)
  expect(breaker.allow()).toBe(false)
  // a successful probe closes it: everyone goes through
  breaker.success()
  expect(Array.from({ length: 5 }, () => breaker.allow())).toEqual([true, true, true, true, true])
  expect(breaker.status()).toEqual({ open: false, failures: 0 })
})

test('createBreaker: release frees the probe without closing or reopening', () => {
  let now = 0
  const breaker = createBreaker(() => now)
  for (let i = 0; i < 3; i++) breaker.failure()
  now = BREAKER_PAUSE_MS
  expect(breaker.allow()).toBe(true)
  expect(breaker.allow()).toBe(false)
  breaker.release!()
  expect(breaker.status()).toMatchObject({ failures: 3 })
  expect(breaker.allow()).toBe(true)
  expect(breaker.allow()).toBe(false)
})

test('createBreaker: a probe that never reports is replaced after 50 refused calls', () => {
  let now = 0
  const breaker = createBreaker(() => now)
  for (let i = 0; i < 3; i++) breaker.failure()
  now = BREAKER_PAUSE_MS
  expect(breaker.allow()).toBe(true)
  const next = Array.from({ length: BREAKER_MAX_REFUSALS }, () => breaker.allow())
  expect(next.slice(0, -1).every(a => a === false)).toBe(true)
  expect(next.at(-1)).toBe(true)
})

test('after the pause two concurrent judgments send one request: the other waits for the probe', async () => {
  const w = world([...Array.from({ length: 6 }, () => ({ status: 500 })), { delay: 50, text: SYSTEM_ONE_BODY }])
  const breaker = createBreaker(w.sim.now)
  for (let i = 0; i < 3; i++) await call(w, typesafe, { breaker })
  expect(w.calls).toHaveLength(6)
  w.sim.time += BREAKER_PAUSE_MS
  const both = await settle(w.sim, Promise.all([judge(w.io, typesafe, prepared(), { breaker }), judge(w.io, typesafe, prepared(), { breaker })]))
  expect(both.map(r => r.ok ? 'ok' : r.reason).sort()).toEqual(['breaker', 'ok'])
  expect(w.calls).toHaveLength(7)
  // the probe's success closed it
  expect(await call(w, typesafe, { breaker })).toMatchObject({ ok: true })
  expect(w.calls).toHaveLength(8)
})

test('a rejected probe frees the slot instead of holding the breaker shut', async () => {
  const w = world([...Array.from({ length: 6 }, () => ({ status: 500 })), { status: 422, text: 'bad' }, { text: SYSTEM_ONE_BODY }])
  const breaker = createBreaker(w.sim.now)
  for (let i = 0; i < 3; i++) await call(w, typesafe, { breaker })
  w.sim.time += BREAKER_PAUSE_MS
  expect(await call(w, typesafe, { breaker })).toMatchObject({ ok: false, reason: 'rejected', off: 'battery' })
  // neither closed nor reopened: still half-open, and the next call is the probe
  expect(breaker.status()).toMatchObject({ failures: 3 })
  expect(await call(w, typesafe, { breaker })).toMatchObject({ ok: true })
  expect(breaker.status()).toEqual({ open: false, failures: 0 })
})

test('createBreaker: a clock that stands still cannot keep it open forever', () => {
  for (const reading of [() => 0, () => Number.NaN, () => { throw new Error('no clock') }]) {
    const breaker = createBreaker(reading)
    for (let i = 0; i < BREAKER_FAILURES; i++) breaker.failure()
    // refused 49 times, then one probe goes through
    const answers = Array.from({ length: BREAKER_MAX_REFUSALS }, () => breaker.allow())
    expect(answers.slice(0, -1).every(a => a === false)).toBe(true)
    expect(answers.at(-1)).toBe(true)
    // a failed probe reopens it for another round, a successful one closes it
    breaker.failure()
    expect(breaker.allow()).toBe(false)
    expect(Array.from({ length: BREAKER_MAX_REFUSALS }, () => breaker.allow()).filter(Boolean)).toHaveLength(1)
    breaker.success()
    expect(Array.from({ length: 5 }, () => breaker.allow())).toEqual([true, true, true, true, true])
  }
  expect(BREAKER_MAX_REFUSALS).toBe(50)
})

test('createBreaker: with a working clock the pause still ends by time, and refusals restart after a failure', () => {
  let now = 0
  const breaker = createBreaker(() => now)
  for (let i = 0; i < 3; i++) breaker.failure()
  for (let i = 0; i < 10; i++) expect(breaker.allow()).toBe(false)
  now = BREAKER_PAUSE_MS
  expect(breaker.allow()).toBe(true)
})

test('createBreaker: limits are configurable', () => {
  let now = 0
  const breaker = createBreaker(() => now, { failures: 1, pauseMs: 10 })
  breaker.failure()
  expect(breaker.allow()).toBe(false)
  now = 10
  expect(breaker.allow()).toBe(true)
})

test('the breaker is shared: three failed judgments anywhere pause every caller, with no request sent', async () => {
  // three judgments, each failing after its retry, then a healthy service
  const w = world([...Array.from({ length: 6 }, () => ({ status: 500 })), { text: SYSTEM_ONE_BODY }])
  const breaker = createBreaker(w.sim.now)
  for (let i = 0; i < 3; i++) expect(await call(w, i === 1 ? openrouter : typesafe, { breaker })).toMatchObject({ ok: false, reason: 'http' })
  expect(w.calls).toHaveLength(6)
  expect(await call(w, openrouter, { breaker })).toMatchObject({ ok: false, reason: 'breaker', attempts: 0 })
  expect(await call(w, typesafe, { breaker }, taskEndBattery)).toMatchObject({ ok: false, reason: 'breaker' })
  expect(w.calls).toHaveLength(6)
  // five minutes later the next call goes through, and its success closes the breaker
  w.sim.time += BREAKER_PAUSE_MS
  expect(await call(w, typesafe, { breaker })).toMatchObject({ ok: true })
  expect(w.calls).toHaveLength(7)
  expect(breaker.status()).toMatchObject({ open: false, failures: 0 })
})

test('every failed judgment counts but a rejected one, a success resets, a skipped call does not count', async () => {
  const breaker: Breaker & { log: string[] } = (() => {
    const log: string[] = []
    return { log, allow: () => true, success: () => { log.push('success') }, failure: () => { log.push('failure') }, status: () => ({ open: false, failures: 0 }) }
  })()
  const outcomes: [Reply, Route][] = [
    [{ text: SYSTEM_ONE_BODY }, typesafe],
    [{ status: 401 }, typesafe],
    [{ status: 422, text: 'bad' }, typesafe], // the battery's fault: neither a success nor a failure
    [{ status: 418 }, typesafe],
    [{ text: 'garbage' }, typesafe],
    [{ never: true }, typesafe],
    [{ text: SYSTEM_ONE_BODY }, { kind: 'typesafe', key: '' }],
    [{ text: SYSTEM_ONE_BODY }, { kind: 'typesafe', key: KEY, baseUrl: 'http://evil.example.com' }],
  ]
  for (const [reply, route] of outcomes) await call(world([reply]), route, { breaker })
  expect(breaker.log).toEqual(['success', 'failure', 'failure', 'failure', 'failure'])
})

test('without a breaker nothing is paused', async () => {
  const w = world([{ status: 500 }])
  for (let i = 0; i < 5; i++) await call(w)
  expect(w.calls).toHaveLength(10)
})

test('the breaker blocks before any timer is started', async () => {
  const w = world([{ text: SYSTEM_ONE_BODY }])
  const breaker = createBreaker(w.sim.now, { failures: 1 })
  breaker.failure()
  expect(await call(w, typesafe, { breaker })).toMatchObject({ ok: false, reason: 'breaker' })
  expect(w.sim.pending).toBe(0)
  expect(w.sim.cancelled).toBe(0)
})

test('the retry battery with and without a previous output asks the questions it was given', async () => {
  const w = world([{ text: '{}' }])
  await call(w, typesafe, {}, retryBattery(true))
  expect(Object.keys(JSON.parse(w.calls[0]!.init.body!).questions)).toContain('same_failure')
  const x = world([{ text: '{}' }])
  await call(x, typesafe, {}, retryBattery(false))
  expect(Object.keys(JSON.parse(x.calls[0]!.init.body!).questions)).not.toContain('same_failure')
})
