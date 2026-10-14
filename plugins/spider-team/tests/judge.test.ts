import { expect, test } from 'claude-code/testing'
import { judgeAnswer } from '../hooks/judge'
import { createBreaker, createGate } from '../hooks/jev'
import { JUDGE_FLAGS, JUDGE_QUESTIONS } from '../hooks/router'
import { ports } from './host'

const MARKER = 'SECRET-MARKER-7f3a'
const judge = (h: ReturnType<typeof ports>, answer: string, key: string | null = 'test-key') =>
  judgeAnswer(h.io, { answer, home: h.io.home, root: h.io.root, key: key ?? undefined })

test('the judge asks the three questions with the redacted answer as the only state and returns the three probabilities', async () => {
  const h = ports()
  h.answers.finished = { type: 'noul', noul: 0.87 }; h.answers.failingChecks = { type: 'noul', noul: 0.1 }; h.answers.blocked = { type: 'noul', noul: 0 }
  // A hostile extra answer from the service is not read.
  h.answers[MARKER] = { type: 'noul', noul: 1 }
  const answer = `Done. Edited /home/u/private/${MARKER}.ts with test-key, all checks pass.`
  expect(await judge(h, answer)).toEqual({ finished: 0.87, failingChecks: 0.1, blocked: 0 })
  expect(h.requests).toHaveLength(1)
  const request = h.requests[0]!, body = JSON.parse(request.body)
  expect(Object.keys(body)).toEqual(['model', 'state', 'questions'])
  expect(body.model).toBe('jev-1.13.0')
  expect(body.questions).toEqual(JUDGE_QUESTIONS)
  expect(Object.keys(body.questions)).toEqual([...JUDGE_FLAGS])
  // The answer is the only state, under `report.text`, with its path and the key masked.
  expect(Object.keys(body.state)).toEqual(['report']); expect(Object.keys(body.state.report)).toEqual(['text'])
  expect(body.state.report.text).toBe('Done. Edited ~/<path> with [redacted], all checks pass.')
  expect(request.body).not.toContain(MARKER); expect(request.body).not.toContain('/home/u'); expect(request.body).not.toContain('test-key')
  expect(request.headers.Authorization).toBe('Bearer test-key')
})

test('the judge masks the whole answer before clipping it to 4000 characters', async () => {
  const h = ports(), key = 'private-test-key'
  // A token longer than the limit: clipped first, its cut head would no longer end where the redaction ends.
  const token = ['sk-', 'a'.repeat(5000)].join('')
  const answer = `Report: ${token} END ${key.repeat(400)} tail`
  expect(await judgeAnswer(h.io, { answer, home: h.io.home, root: h.io.root, key })).not.toBeNull()
  const text = JSON.parse(h.requests[0]!.body).state.report.text as string
  expect(text.startsWith('Report: [redacted] END ')).toBe(true)
  expect(text.length).toBeLessThanOrEqual(4000); expect(text.endsWith('…')).toBe(true)
  expect(text).not.toContain('aaaaaaaa'); expect(text).not.toContain(key)
})

test('every judge failure is null with one fixed log line, never an error, and a logging failure changes nothing', async () => {
  for (const reason of ['no-key', 'bad-key', 'unreadable-settings', 'repo-declared-key', 'http', 'malformed', 'breaker', 'busy', 'timeout', 'network'] as const) {
    const h = ports(); let key: string | undefined = 'test-key'
    if (reason === 'no-key') key = undefined
    if (reason === 'bad-key') key = 'has space'
    if (reason === 'unreadable-settings') h.faults.settings = true
    if (reason === 'repo-declared-key') h.io.settings = async () => ({ env: { JEV_API_KEY: '' } })
    if (reason === 'http') h.faults.http = 401
    if (reason === 'malformed') h.io.jev.fetch = async () => ({ status: 200, text: '{}' })
    if (reason === 'network') h.io.jev.fetch = async () => { throw new Error(`private failure ${MARKER}`) }
    if (reason === 'breaker') { h.io.breaker = createBreaker(() => 0); h.io.breaker.failure(); h.io.breaker.failure(); h.io.breaker.failure() }
    if (reason === 'busy') { h.io.gate = createGate(); for (let n = 0; n < 4; n++) h.io.gate.acquire() }
    if (reason === 'timeout') {
      h.io.jev.fetch = async () => new Promise(() => {})
      h.io.jev.timer = (ms, fn) => { let cancelled = false; if (ms === 3000) void Promise.resolve().then(() => { if (!cancelled) fn() }); return () => { cancelled = true } }
    }
    expect(await judge(h, `answer ${MARKER}`, key ?? null)).toBeNull()
    expect(h.logs).toEqual([`spider-team: judge off (${reason})`])
    h.io.log = () => { throw new Error('logging failed') }
    expect(await judge(h, `answer ${MARKER}`, key ?? null)).toBeNull()
  }
})

test('a Noul that is missing, not a number or outside 0..1 makes the whole judge null', async () => {
  for (const bad of [undefined, { type: 'noul' }, { noul: '0.9' }, { noul: 1.2 }, { noul: -0.01 }, { noul: null }, { probabilities: { true: 1 } }]) {
    const h = ports()
    h.answers.finished = { noul: 0.9 }; h.answers.failingChecks = { noul: 0 }; h.answers.blocked = bad
    expect(await judge(h, 'Done.')).toBeNull()
    expect(h.logs).toEqual(['spider-team: judge off (malformed)'])
  }
})
