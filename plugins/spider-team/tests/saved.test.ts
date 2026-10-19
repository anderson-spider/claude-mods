import { expect, test } from 'claude-code/testing'
import type { SpiderRun } from '../types'
import { SAVED_MAX, SAVED_TTL_MS, STATE_SHAPE, pruned, restorable, savedKey, toSave } from '../hooks/saved'

const RUN: SpiderRun = { runId: 'r', title: 'Auth', phase: 'execute', startedAt: 0, tasks: [{ id: 'T1', title: 'Build', owner: 'main', after: [], state: 'running', attempts: 1, errors: [], agentIds: [] }] }
const CLOSED: SpiderRun = { ...RUN, phase: 'complete', finishedAt: 5 }

test('only an open run is saved, under its session, with when', () => {
  expect(savedKey('s1')).toBe('run:s1')
  expect(toSave(RUN, 10)).toEqual({ shape: STATE_SHAPE, run: RUN, savedAt: 10 })
  expect(toSave(CLOSED, 10)).toBeUndefined()
  expect(toSave(null, 10)).toBeUndefined()
})

test('a stored value comes back only as an open run of this shape saved within the TTL', () => {
  const saved = (over: object = {}) => ({ shape: STATE_SHAPE, run: RUN, savedAt: 1, ...over })
  expect(restorable(saved(), 2)).toEqual(RUN)
  expect(restorable(saved({ shape: 'spider-team/0' }), 2)).toBeUndefined()
  expect(restorable(saved({ run: CLOSED }), 2)).toBeUndefined()
  expect(restorable(saved({ run: { title: 'x' } }), 2)).toBeUndefined()
  expect(restorable(saved(), 1 + SAVED_TTL_MS + 1)).toBeUndefined()
  expect(restorable('junk', 2)).toBeUndefined()
  expect(restorable(undefined, 2)).toBeUndefined()
})

test('pruning drops stale, broken, older-shape and surplus runs and leaves other keys alone', () => {
  const now = SAVED_TTL_MS * 2
  const fresh = Array.from({ length: SAVED_MAX + 2 }, (_, i) => [`run:f${i}`, { shape: STATE_SHAPE, run: RUN, savedAt: now - i }] as [string, unknown])
  const entries: [string, unknown][] = [
    ['other', 1], ['run:old', { shape: STATE_SHAPE, run: RUN, savedAt: now - SAVED_TTL_MS - 1 }], ['run:bad', { shape: STATE_SHAPE, savedAt: now }],
    ['run:older-shape', { shape: 'spider-team/0', run: RUN, savedAt: now }], ...fresh,
  ]
  expect(pruned(entries, now)).toEqual(['run:old', 'run:bad', 'run:older-shape', `run:f${SAVED_MAX}`, `run:f${SAVED_MAX + 1}`])
})
