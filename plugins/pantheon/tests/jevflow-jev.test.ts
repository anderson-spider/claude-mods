import { expect, test } from 'claude-code/testing'
import {
  JEV_TIMEOUT_MS,
  JEV_URL,
  JevFailure,
  backoffMs,
  createBreaker,
  createJev,
  parseAnswersBody,
  retryAfterMs,
} from '../hooks/jevflow/jev'
import type { JevInit, JevIo } from '../hooks/jevflow/jev'
import type { Questions } from '../hooks/jevflow/questions'

// Provider-shaped fixtures are assembled at runtime so no source literal matches a secret scanner.
const KEY = ['sk-or-', 'v1-fakekey-1234567890abcdef'].join('')
const QUESTIONS: Questions = { stuck: { type: 'noul', instructions: 'Is the agent stuck?' } }
const OK = JSON.stringify({ model: 'typesafe/jev-1.13', answers: { stuck: { type: 'noul', noul: 0.12 } } })

type Reply = { status?: number; text?: string; headers?: Record<string, string>; throws?: unknown; never?: true }
type Timer = { ms: number; cancelled: boolean; fire: () => void }

/**
 * A scripted host: fetch answers with the next reply (the last one repeats), and timers are of two kinds. The attempt
 * deadline (JEV_TIMEOUT_MS) fires only when a `never` reply asks for it; every other timer is a backoff and fires at
 * once, recorded in `sleeps`.
 */
function harness(replies: Reply[]) {
  const calls: JevInit[] = []
  const urls: string[] = []
  const sleeps: number[] = []
  const pending: Timer[] = []
  let index = 0
  const timer: JevIo['timer'] = (ms, fn) => {
    const entry: Timer = { ms, cancelled: false, fire: () => { if (!entry.cancelled) fn() } }
    pending.push(entry)
    if (ms !== JEV_TIMEOUT_MS) {
      sleeps.push(ms)
      void Promise.resolve().then(entry.fire)
    }
    return () => { entry.cancelled = true }
  }
  const io: JevIo = {
    fetch: async (url, init) => {
      urls.push(url)
      calls.push(init)
      const reply = replies[Math.min(index++, replies.length - 1)] ?? {}
      if (reply.never) {
        for (const t of pending) if (t.ms === JEV_TIMEOUT_MS) t.fire()
        return new Promise(() => {})
      }
      if (reply.throws !== undefined) throw reply.throws
      return { status: reply.status ?? 200, text: reply.text ?? OK, headers: reply.headers }
    },
    timer,
  }
  return { io, calls, urls, sleeps }
}

/** The failure a rejected promise carries; any other rejection is rethrown so the test shows it. */
async function failureOf(promise: Promise<unknown>): Promise<JevFailure> {
  try {
    await promise
  } catch (error) {
    if (error instanceof JevFailure) return error
    throw error
  }
  throw new Error('expected a failure, got an answer')
}

test('createJev posts one decisions request to OpenRouter with the bearer key, the state and the questions', async () => {
  const h = harness([{ text: OK }])
  const answers = await createJev(h.io, KEY)(QUESTIONS, '{"goal":"g"}')
  expect(answers.stuck).toEqual({ type: 'noul', noul: 0.12 })
  expect(h.urls).toEqual(['https://openrouter.ai/api/alpha/decisions'])
  expect(JEV_URL).toBe('https://openrouter.ai/api/alpha/decisions')
  const init = h.calls[0]!
  expect(init.method).toBe('POST')
  expect(init.headers.Authorization).toBe(`Bearer ${KEY}`)
  const body = JSON.parse(init.body)
  expect(body.model).toBe('typesafe/jev-1.13')
  expect(body.state).toBe('{"goal":"g"}')
  expect(body.questions).toEqual(QUESTIONS)
  expect(h.sleeps).toEqual([])
})

test('the attempt timeout defaults to 15 seconds', () => {
  expect(JEV_TIMEOUT_MS).toBe(15000)
})

test('a 429 and a 529 are retried with exponential backoff, and the answer of the third attempt is returned', async () => {
  const h = harness([{ status: 429 }, { status: 529 }, { text: OK }])
  const answers = await createJev(h.io, KEY)(QUESTIONS, 's')
  expect(h.calls.length).toBe(3)
  expect(h.sleeps).toEqual([500, 1000])
  expect(answers.stuck).toEqual({ type: 'noul', noul: 0.12 })
})

test('Retry-After is honoured and capped at 8 seconds', async () => {
  const h = harness([{ status: 429, headers: { 'Retry-After': '2' } }, { status: 429, headers: { 'retry-after': '999' } }, { text: OK }])
  await createJev(h.io, KEY)(QUESTIONS, 's')
  expect(h.sleeps).toEqual([2000, 8000])
})

test('retries run out after 3 retries: four attempts in all, then the last status is thrown', async () => {
  const h = harness([{ status: 529 }])
  const failure = await failureOf(createJev(h.io, KEY)(QUESTIONS, 's'))
  expect(failure.reason).toBe('http')
  expect(failure.status).toBe(529)
  expect(h.calls.length).toBe(4)
  expect(h.sleeps).toEqual([500, 1000, 2000])
})

test('a 400 is not retried, and the provider text comes with the status', async () => {
  const h = harness([{ status: 400, text: '{"error":"bad question"}' }])
  const failure = await failureOf(createJev(h.io, KEY)(QUESTIONS, 's'))
  expect(failure.reason).toBe('http')
  expect(failure.status).toBe(400)
  expect(failure.message).toContain('bad question')
  expect(h.calls.length).toBe(1)
  expect(h.sleeps).toEqual([])
})

test('a 401 whose body echoes the key shows the key redacted, never in the error', async () => {
  const h = harness([{ status: 401, text: `invalid key ${KEY}` }])
  const failure = await failureOf(createJev(h.io, KEY)(QUESTIONS, 's'))
  expect(failure.status).toBe(401)
  expect(failure.message).not.toContain(KEY)
  expect(failure.message).toContain('[REDACTED]')
  expect(h.calls.length).toBe(1)
})

test('a timeout on every attempt is retried and then reported as timeout', async () => {
  const h = harness([{ never: true }])
  const failure = await failureOf(createJev(h.io, KEY)(QUESTIONS, 's'))
  expect(failure.reason).toBe('timeout')
  expect(h.calls.length).toBe(4)
  expect(h.sleeps).toEqual([500, 1000, 2000])
})

test('a timeout that clears on a retry is an answer, not a failure', async () => {
  const h = harness([{ never: true }, { text: OK }])
  const answers = await createJev(h.io, KEY)(QUESTIONS, 's')
  expect(answers.stuck).toEqual({ type: 'noul', noul: 0.12 })
  expect(h.calls.length).toBe(2)
})

test('a network error is retried, and one that clears is an answer', async () => {
  const h = harness([{ throws: new TypeError('fetch failed') }, { text: OK }])
  const answers = await createJev(h.io, KEY)(QUESTIONS, 's')
  expect(answers.stuck).toEqual({ type: 'noul', noul: 0.12 })
  expect(h.sleeps).toEqual([500])
})

test('a network error on every attempt is reported as network, with the host message redacted', async () => {
  const h = harness([{ throws: new Error(`socket hang up ${KEY}`) }])
  const failure = await failureOf(createJev(h.io, KEY)(QUESTIONS, 's'))
  expect(failure.reason).toBe('network')
  expect(failure.message).not.toContain(KEY)
  expect(h.calls.length).toBe(4)
})

test('a 2xx body of the wrong shape is malformed and is not retried', async () => {
  const h = harness([{ text: 'not json' }])
  const failure = await failureOf(createJev(h.io, KEY)(QUESTIONS, 's'))
  expect(failure.reason).toBe('malformed')
  expect(h.calls.length).toBe(1)
  expect(h.sleeps).toEqual([])
})

test('parseAnswersBody accepts a well-formed answers object and rejects each malformed shape', () => {
  expect(parseAnswersBody(OK).stuck).toEqual({ type: 'noul', noul: 0.12 })
  const bad = [
    'not json',
    '[]',
    '{"no": 1}',
    '{"answers": {"x": {"type": "noul"}}}',
    '{"answers": {"x": {"type": "choice"}}}',
    '{"answers": {"x": {"type": "score"}}}',
    '{"answers": {"x": {"noul": 0.1}}}',
    '{"answers": {"x": 3}}',
  ]
  for (const text of bad) {
    let reason: string | undefined
    try {
      parseAnswersBody(text)
    } catch (error) {
      reason = error instanceof JevFailure ? error.reason : 'other'
    }
    expect(reason).toBe('malformed')
  }
})

test('the breaker opens after three failures and refuses the fourth call without sending it', async () => {
  const h = harness([{ status: 500 }])
  const breaker = createBreaker(() => 0)
  const ask = createJev(h.io, KEY, { breaker, maxRetries: 0 })
  for (let i = 0; i < 3; i++) await failureOf(ask(QUESTIONS, 's'))
  const refused = await failureOf(ask(QUESTIONS, 's'))
  expect(refused.reason).toBe('breaker')
  expect(h.calls.length).toBe(3)
  expect(breaker.status().open).toBe(true)
})

test('a rejected request (400) frees the breaker without counting against it', async () => {
  const h = harness([{ status: 400 }])
  const breaker = createBreaker(() => 0)
  const ask = createJev(h.io, KEY, { breaker, maxRetries: 0 })
  for (let i = 0; i < 4; i++) await failureOf(ask(QUESTIONS, 's'))
  expect(h.calls.length).toBe(4)
  expect(breaker.status().open).toBe(false)
  expect(breaker.status().failures).toBe(0)
})

test('a missing or blank key, or one with whitespace, is a config failure with nothing sent', async () => {
  for (const key of ['', '   ', 'a b', 'abc\r\nX-Evil: 1']) {
    const h = harness([{ text: OK }])
    const failure = await failureOf(createJev(h.io, key)(QUESTIONS, 's'))
    expect(failure.reason).toBe('config')
    expect(h.calls.length).toBe(0)
  }
})

test('empty questions are a config failure with nothing sent', async () => {
  const h = harness([{ text: OK }])
  const failure = await failureOf(createJev(h.io, KEY)({}, 's'))
  expect(failure.reason).toBe('config')
  expect(h.calls.length).toBe(0)
})

test('backoffMs doubles from 500 ms and caps at 8 seconds; Retry-After wins, also capped', () => {
  expect([0, 1, 2, 3, 4, 10].map(a => backoffMs(a, undefined))).toEqual([500, 1000, 2000, 4000, 8000, 8000])
  expect(backoffMs(0, 2000)).toBe(2000)
  expect(backoffMs(0, 999000)).toBe(8000)
})

test('retryAfterMs reads seconds from any header case, and nothing it cannot read', () => {
  expect(retryAfterMs({ 'Retry-After': '1.5' })).toBe(1500)
  expect(retryAfterMs({ 'retry-after': '3' })).toBe(3000)
  expect(retryAfterMs({ 'Retry-After': 'soon' })).toBeUndefined()
  expect(retryAfterMs({ 'Retry-After': '' })).toBeUndefined()
  expect(retryAfterMs(undefined)).toBeUndefined()
})
