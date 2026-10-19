import { expect, test } from 'claude-code/testing'
import type { SpiderRun } from '../types'
import { SAVED_MAX, SAVED_TTL_MS, pruned, restorable, savedKey, toSave } from '../hooks/saved'

const RUN: SpiderRun = { runId: 'r', title: 'Auth', phase: 'execute', startedAt: 0, tasks: [{ id: 'T1', title: 'Build', owner: 'main', after: [], state: 'running', attempts: 1, errors: [], agentIds: [] }] }
const CLOSED: SpiderRun = { ...RUN, phase: 'complete', finishedAt: 5 }

test('only an open run is saved, under its session, with when', () => {
  expect(savedKey('s1')).toBe('run:s1')
  expect(toSave(RUN, 10)).toEqual({ run: RUN, savedAt: 10 })
  expect(toSave(CLOSED, 10)).toBeUndefined()
  expect(toSave(null, 10)).toBeUndefined()
})

test('a stored value comes back only as an open run', () => {
  expect(restorable({ run: RUN, savedAt: 1 })).toEqual(RUN)
  expect(restorable({ run: CLOSED, savedAt: 1 })).toBeUndefined()
  expect(restorable({ run: { title: 'x' } })).toBeUndefined()
  expect(restorable('junk')).toBeUndefined()
  expect(restorable(undefined)).toBeUndefined()
})

test('pruning drops stale, broken and surplus runs and leaves other keys alone', () => {
  const now = SAVED_TTL_MS * 2
  const fresh = Array.from({ length: SAVED_MAX + 2 }, (_, i) => [`run:f${i}`, { run: RUN, savedAt: now - i }] as [string, unknown])
  const entries: [string, unknown][] = [['other', 1], ['run:old', { run: RUN, savedAt: now - SAVED_TTL_MS - 1 }], ['run:bad', { savedAt: now }], ...fresh]
  expect(pruned(entries, now)).toEqual(['run:old', 'run:bad', `run:f${SAVED_MAX}`, `run:f${SAVED_MAX + 1}`])
})
