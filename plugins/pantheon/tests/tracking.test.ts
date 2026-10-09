import { expect, test } from 'claude-code/testing'
import {
  MAX_NATIVES, DEFAULT_SESSION, DEFAULT_VIEW, roleOf, spawned, stepped, toolNoted, roundOpened, stepAccounted,
  completed, markNativesLost, normalizeNatives, normalizeSession, normalizeView,
  sessionStarted, sessionCompleted, sessionStepped, sessionMeasured, describeTool, viewToggled,
} from '../hooks/tracking'
import type { Native, SessionInfo } from '../hooks/types'

const spawn = (id = 'a', now = 100) => ({
  id, type: 'pantheon:oracle', task: 'Review the change', model: 'test-model', now,
})

test('roleOf maps pantheon types and others', () => {
  for (const role of ['explorer', 'librarian', 'executor', 'oracle', 'designer']) {
    expect(roleOf(`pantheon:${role}`)).toBe(role)
  }
  expect(roleOf('pantheon:oracle')).toBe('oracle')
  expect(roleOf('pantheon:designer')).toBe('designer')
  expect(roleOf('pantheon:councillor-beta')).toBe('councillor-beta')
  expect(roleOf('Explore')).toBe('other')
})

test('spawn creates a record with one running round', () => {
  expect(spawned([], spawn())).toEqual([{
    id: 'a', role: 'oracle', type: 'pantheon:oracle', task: 'Review the change',
    model: 'test-model', rounds: [{ startedAt: 100, status: 'running' }],
    ctx: 0, out: 0, steps: 0,
  }])
})

test('spawn replaces a duplicate id without mutating the previous record', () => {
  const original = spawned([], spawn())
  expect(spawned(original, spawn('a', 200))[0].rounds[0].startedAt).toBe(200)
  expect(spawned(original, spawn('a', 200)).length).toBe(1)
  expect(original[0].rounds[0].startedAt).toBe(100)
})

test('steps add tokens and steps', () => {
  const original = spawned([], spawn())
  const step = { id: 'a', turnId: 't1', now: 110,
    usage: { input_tokens: 10, cache_read_input_tokens: 90, output_tokens: 5 } }
  const list = stepped(stepped(original, step), step)
  expect(list[0].ctx).toBe(100)
  expect(list[0].out).toBe(10)
  expect(list[0].steps).toBe(2)
  expect(list[0].rounds[0].turnId).toBe('t1')
  expect(original[0].steps).toBe(0)
  expect(original[0].rounds[0].turnId).toBeUndefined()
  const cached = stepped(list, { ...step, usage: { cache_creation_input_tokens: 30 } })
  expect(cached[0].ctx).toBe(30)
  expect(stepped(cached, { ...step, usage: {} })[0].ctx).toBe(30)
})

test('a step with a new turnId after the round ended opens round 2', () => {
  const first = stepped(spawned([], spawn()), { id: 'a', turnId: 't1', now: 110 })
  const done = completed(first, { id: 'a', reason: 'answer', now: 120 })
  const next = stepped(done, { id: 'a', turnId: 't2', now: 130 })
  expect(next[0].rounds).toEqual([
    { turnId: 't1', startedAt: 100, endedAt: 120, status: 'done' },
    { turnId: 't2', startedAt: 130, status: 'running' },
  ])
  expect(done[0].rounds.length).toBe(1)
})

test('a continuation opens its round before the response and counts the step after it', () => {
  const done = completed(stepped(spawned([], spawn()), { id: 'a', turnId: 't1', now: 110 }), { id: 'a', reason: 'answer', now: 120 })
  const opened = roundOpened(done, { id: 'a', turnId: 't2', now: 130 })
  expect(opened[0].rounds[1]).toEqual({ turnId: 't2', startedAt: 130, status: 'running' })
  expect(opened[0].steps).toBe(1)
  const counted = stepAccounted(opened, { id: 'a', usage: { input_tokens: 5, output_tokens: 2 } })
  expect(counted[0].rounds).toEqual(opened[0].rounds)
  expect(counted[0]).toEqual(expect.objectContaining({ steps: 2, ctx: 5, out: 2 }))
})

test('a step with the same turnId does not open a round', () => {
  const first = stepped(spawned([], spawn()), { id: 'a', turnId: 't1', now: 110 })
  const done = completed(first, { id: 'a', reason: 'answer', now: 120 })
  const next = stepped(done, { id: 'a', turnId: 't1', now: 130 })
  expect(next[0].rounds.length).toBe(1)
  expect(next[0].rounds[0].status).toBe('done')
  expect(next[0].steps).toBe(2)
})

test('unknown ids leave the list unchanged and tools only update their record', () => {
  const list = spawned(spawned([], spawn()), spawn('b'))
  expect(stepped(list, { id: 'unknown', turnId: 't', now: 120 })).toBe(list)
  expect(toolNoted(list, 'unknown', 'Read jobs.ts')).toBe(list)
  expect(completed(list, { id: 'unknown', reason: 'answer', now: 120 })).toBe(list)
  const noted = toolNoted(list, 'a', 'Read jobs.ts')
  expect(noted[0].lastTool).toBe('Read jobs.ts')
  expect(noted[1]).toBe(list[1])
  expect(list[0].lastTool).toBeUndefined()
})

test('complete maps reasons and leaves closed rounds unchanged', () => {
  for (const [reason, status] of [['answer', 'done'], ['aborted', 'stopped'], ['error', 'failed']]) {
    const list = spawned([], spawn())
    const done = completed(list, { id: 'a', reason, now: 120 })
    expect(done[0].rounds[0]).toEqual({ startedAt: 100, endedAt: 120, status })
    expect(list[0].rounds[0].status).toBe('running')
    expect(completed(done, { id: 'a', reason: 'aborted', now: 130 })).toEqual(done)
  }
})

test('the list keeps 24 records', () => {
  let list: Native[] = []
  for (let i = 1; i <= 30; i++) list = spawned(list, spawn(String(i)))
  expect(MAX_NATIVES).toBe(24)
  expect(list.length).toBe(24)
  expect(list[0].id).toBe('7')
})

test('markNativesLost turns running rounds into lost', () => {
  const done = completed(spawned([], spawn()), { id: 'a', reason: 'answer', now: 120 })
  const list = spawned(done, spawn('b'))
  const lost = markNativesLost(list)
  expect(lost[0].rounds).toEqual(done[0].rounds)
  expect(lost[1].rounds[0]).toEqual({ startedAt: 100, status: 'lost' })
  expect(list[1].rounds[0].status).toBe('running')
})

test('normalizeNatives drops broken records', () => {
  expect(normalizeNatives([{ id: 'a', role: 'other', type: 'pantheon:executor', rounds: [] }])[0].role).toBe('executor')
  expect(normalizeNatives('x')).toEqual([])
  const list = normalizeNatives([{ id: 'a' }, { id: 'b', rounds: [] }, null])
  expect(list.length).toBe(1)
  expect(list[0]).toEqual({
    id: 'b', role: 'other', type: '', task: '', model: '', rounds: [], ctx: 0, out: 0, steps: 0,
  })
  expect(normalizeNatives(spawned([], spawn()))).toEqual(spawned([], spawn()))
})

test('normalizers default invalid fields and preserve valid session and view state', () => {
  expect(normalizeSession(null)).toEqual(DEFAULT_SESSION)
  expect(normalizeSession({ isRunning: 'yes', lastTurnMs: 'bad' })).toEqual(DEFAULT_SESSION)
  expect(normalizeView('jobs')).toEqual(DEFAULT_VIEW)
  expect(normalizeView({ tab: 'bad' })).toEqual({})
  // An old saved view still carries the removed tab: it normalizes without it.
  expect(normalizeView({ tab: 'jobs' })).toEqual({})
  expect(normalizeView({ tab: 'agents', collapsed: ['idle', 'bogus', 'finished', 'running'] })).toEqual({ collapsed: ['running', 'idle'] })
  expect(viewToggled({}, 'idle')).toEqual({ collapsed: ['idle'] })
  expect(viewToggled({ collapsed: ['idle'] }, 'idle')).toEqual({})
  expect(normalizeSession({ isRunning: true, costUsd: 1.25 })).toEqual({ isRunning: true, costUsd: 1.25 })
  expect(normalizeSession({ isRunning: true, costUsd: 'x' })).toEqual({ isRunning: true })
  expect(sessionMeasured({ isRunning: false }, { window: 10 }, { usd: 0.4 }).costUsd).toBe(0.4)
  expect(sessionMeasured({ isRunning: false, costUsd: 0.4 }, { window: 10 }).costUsd).toBe(0.4)
  const session = {
    model: 'test-model', effort: 'high', context: { tokens: 25, window: 100, percent: 25 },
    isRunning: true, turnStartedAt: 100, lastTurnMs: 20,
  }
  expect(normalizeSession(session)).toEqual(session)
  const malformed = normalizeNatives([{ id: 'b', rounds: [null, { status: 'done' }], ctx: NaN, out: 'bad' }])
  expect(malformed[0].ctx).toBe(0)
  expect(malformed[0].out).toBe(0)
  expect(malformed[0].rounds).toEqual([{ startedAt: 0, status: 'done' }])
})

test('describeTool redacts secrets', () => {
  expect(describeTool('Bash', { command: 'curl -H "Authorization: Bearer abc.def.ghi123" x' }))
    .not.toContain('abc.def')
  expect(describeTool('Read', { file_path: '/a/pantheon/hooks/jobs.ts' })).toBe('Read hooks/jobs.ts')
  for (const command of [
    'TOKEN=abcdefghijk', '--token abcdefghijk', 'password="abcdefghijk"',
    'https://user:abcdefghijk@example.com', 'ghp_abcdefghijk', 'Bearer abcdefghijk',
  ]) expect(describeTool('Bash', { command })).not.toContain('abcdefghijk')
  expect(describeTool('Grep', { pattern: 'needle' })).toBe('Grep needle')
  expect(describeTool('Fetch', { url: 'https://example.com' })).toBe('Fetch https://example.com')
  expect(describeTool('Agent', { description: 'Review code' })).toBe('Agent Review code')
  expect(describeTool('Read', null)).toBe('Read')
  const long = describeTool('Bash', { command: 'x'.repeat(100) })
  expect(long.length).toBe(64)
  expect(long.endsWith('…')).toBe(true)
})

test('session reducers', () => {
  const started = sessionStarted(DEFAULT_SESSION, 100)
  expect(started.isRunning).toBe(true)
  expect(started.turnStartedAt).toBe(100)
  const done = sessionCompleted(started, 50)
  expect(done.isRunning).toBe(false)
  expect(done.lastTurnMs).toBe(50)
  expect(done.turns).toEqual([{ startedAt: 100, endedAt: 150 }])
  expect(DEFAULT_SESSION).toEqual({ isRunning: false })
  const modeled = sessionStepped(done, 'test-model', 'high')
  expect(modeled.model).toBe('test-model')
  expect(modeled.effort).toBe('high')
  expect(sessionStepped(modeled, 'other-model', undefined).effort).toBeUndefined()
  expect(sessionMeasured(modeled, { window: 100 }).context).toEqual({ tokens: null, window: 100, percent: null })
  expect(sessionMeasured(modeled, { tokens: 25, window: 100, percent: 25 }).context)
    .toEqual({ tokens: 25, window: 100, percent: 25 })
})

test('completed session turns retain the last 15 minutes and at most 50 entries', () => {
  let session: SessionInfo = DEFAULT_SESSION
  for (let k = 0; k < 55; k++) session = sessionCompleted(sessionStarted(session, k * 1000), 500)
  expect(session.turns).toHaveLength(50)
  expect(session.turns?.[0]).toEqual({ startedAt: 5000, endedAt: 5500 })
  const before = JSON.stringify(session)
  const done = sessionCompleted(sessionStarted(session, 955_000), 500)
  expect(done.turns).toEqual([
    { startedAt: 955_000, endedAt: 955_500 },
  ])
  expect(JSON.stringify(session)).toBe(before)
  const boundary = sessionCompleted(sessionStarted({ isRunning: false, turns: [
    { startedAt: 0, endedAt: 99 }, { startedAt: 0, endedAt: 100 },
  ] }, 900_000), 100)
  expect(boundary.turns).toEqual([{ startedAt: 0, endedAt: 100 }, { startedAt: 900_000, endedAt: 900_100 }])
  expect(sessionCompleted(done, 500).turns).toEqual(done.turns)
  expect(sessionCompleted(DEFAULT_SESSION, 500).turns).toBeUndefined()
  expect(sessionCompleted(sessionStarted(DEFAULT_SESSION, 100), -1).turns).toBeUndefined()
})

test('normalizeSession validates turn intervals and bounds their history', () => {
  const turns = [{ startedAt: 0, endedAt: 10 }, { startedAt: 20, endedAt: 20 }]
  expect(normalizeSession({ isRunning: false, turns: [
    ...turns, null, {}, { startedAt: '0', endedAt: 10 }, { startedAt: 0, endedAt: Infinity },
    { startedAt: NaN, endedAt: 10 }, { startedAt: 10, endedAt: 5 }, { startedAt: -1, endedAt: 10 },
  ] }).turns).toEqual(turns)
  expect(normalizeSession({ turns: 'bad' }).turns).toBeUndefined()
  const many = Array.from({ length: 55 }, (_, k) => ({ startedAt: k * 1000, endedAt: k * 1000 + 500 }))
  expect(normalizeSession({ turns: [...many].reverse() }).turns).toEqual(many.slice(-50))
})
