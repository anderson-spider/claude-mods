import { expect, test } from 'claude-code/testing'
import { logEvents } from '../hooks/log'
import { ROLE_ORDER } from '../hooks/roster'
import type { Instance, Roster, Slot } from '../hooks/roster'

const inst = (o: Partial<Instance> = {}): Instance => ({
  id: 'i', task: 'Map the repo', status: 'running', isActive: true, startedAt: 1_000,
  rounds: [{ startedAt: 1_000, status: 'running' }], tokens: { out: 0 }, ...o,
})
const roster = (by: Record<string, Partial<Slot>> = {}): Roster => ({
  slots: ROLE_ORDER.map((name): Slot => ({
    name, state: 'idle', instances: [], ...by[name],
  })),
  others: [], delegating: [], counts: { active: 0, idle: 0, off: 0 },
})

test('empty roster yields no events', () => {
  expect(logEvents(roster(), 10_000, 50)).toEqual([])
})

test('git logs start and completion under its own actor', () => {
  const i = inst({ task: 'Commit changes', isActive: false, status: 'done', endedAt: 9_000,
    rounds: [{ startedAt: 1_000, endedAt: 9_000, status: 'done' }] })
  const out = logEvents(roster({ git: { instances: [i], history: [i] } }), 10_000, 50)
  expect(out.map(e => [e.actor, e.kind, e.text])).toEqual([
    ['git', 'started', 'started: Commit changes'],
    ['git', 'done', 'done in 8s · Commit changes'],
  ])
})

test('running instance has only a started event', () => {
  const i = inst()
  const out = logEvents(roster({ explorer: { state: 'active', instances: [i], history: [i] } }), 5_000, 50)
  expect(out).toEqual([{ at: 1_000, actor: 'explorer', kind: 'started', text: 'started: Map the repo' }])
})

test('done and failed carry the duration', () => {
  const a = inst({ id: 'a', isActive: false, status: 'done', endedAt: 73_000, startedAt: 1_000,
    rounds: [{ startedAt: 1_000, endedAt: 73_000, status: 'done' }] })
  const b = inst({ id: 'b', task: 'Fix it', isActive: false, status: 'failed', startedAt: 100_000, endedAt: 140_000,
    rounds: [{ startedAt: 100_000, endedAt: 140_000, status: 'failed' }] })
  const out = logEvents(roster({ executor: { instances: [b, a], history: [a, b] } }), 200_000, 50)
  expect(out.map(e => [e.at, e.kind, e.text])).toEqual([
    [1_000, 'started', 'started: Map the repo'],
    [73_000, 'done', 'done in 1m 12s · Map the repo'],
    [100_000, 'started', 'started: Fix it'],
    [140_000, 'failed', 'failed after 40s · Fix it'],
  ])
})

test('failed and stopped statuses log as failed and stopped', () => {
  const a = inst({ id: 'a', task: 'Fix it', isActive: false, status: 'failed', startedAt: 1_000, endedAt: 41_000,
    rounds: [{ startedAt: 1_000, endedAt: 41_000, status: 'failed' }] })
  const b = inst({ id: 'b', task: 'Stop it', isActive: false, status: 'stopped', startedAt: 50_000, endedAt: 55_000,
    rounds: [{ startedAt: 50_000, endedAt: 55_000, status: 'stopped' }] })
  const out = logEvents(roster({ executor: { instances: [b, a], history: [a, b] } }), 200_000, 50)
  expect(out.filter(e => e.kind !== 'started').map(e => [e.kind, e.text])).toEqual([
    ['failed', 'failed after 40s · Fix it'],
    ['stopped', 'stopped after 5s · Stop it'],
  ])
})

test('events are chronological across roles and limited to the most recent', () => {
  const a = inst({ id: 'a', isActive: false, status: 'done', endedAt: 9_000,
    rounds: [{ startedAt: 1_000, endedAt: 9_000, status: 'done' }] })
  const b = inst({ id: 'b', startedAt: 5_000, rounds: [{ startedAt: 5_000, status: 'running' }] })
  const r = roster({
    oracle: { instances: [a], history: [a] },
    explorer: { state: 'active', instances: [b], history: [b] },
  })
  const all = logEvents(r, 20_000, 50)
  expect(all.map(e => e.at)).toEqual([1_000, 5_000, 9_000])
  const last = logEvents(r, 20_000, 2)
  expect(last.map(e => e.at)).toEqual([5_000, 9_000])
})

test('council events name the seat', () => {
  const i = inst({ seat: 'alpha', task: 'Weigh in', isActive: false, status: 'done', endedAt: 31_000,
    rounds: [{ startedAt: 1_000, endedAt: 31_000, status: 'done' }] })
  const out = logEvents(roster({ council: { instances: [i], history: [i], seats: ['alpha', 'beta'] } }), 40_000, 50)
  expect(out.map(e => [e.actor, e.text])).toEqual([
    ['council', 'alpha started: Weigh in'],
    ['council', 'alpha done in 30s · Weigh in'],
  ])
})

test('multiple rounds log each round once; lost and disabled, no activity', () => {
  const i = inst({ isActive: false, status: 'lost', endedAt: 9_000, rounds: [
    { startedAt: 1_000, endedAt: 3_000, status: 'done' },
    { startedAt: 4_000, endedAt: 9_000, status: 'lost' },
  ] })
  const live = inst({ id: 'l', startedAt: 6_000, activity: 'Read', rounds: [{ startedAt: 6_000, status: 'running' }] })
  const out = logEvents(roster({
    designer: { instances: [i], history: [i] },
    librarian: { state: 'active', instances: [live], history: [live] },
    oracle: { state: 'off', offReason: 'disabledAgents' },
  }), 12_000, 50)
  expect(out.filter(e => e.actor === 'designer').map(e => [e.kind, e.text])).toEqual([
    ['started', 'started: Map the repo'], ['done', 'done in 2s · Map the repo'],
    ['started', 'resumed: Map the repo'], ['lost', 'lost after 5s · Map the repo'],
  ])
  expect(out.some(e => e.kind === 'activity')).toBe(false)
  expect(out.find(e => e.kind === 'disabled')).toEqual({ at: 12_000, actor: 'oracle', kind: 'disabled', text: 'disabled in config' })
})

test('parallel instances of one role get distinct end lines', () => {
  const mk = (n: number) => inst({ id: `p${n}`, task: `Executor ${n}  sleep\n${n}`, isActive: false, status: 'done', startedAt: 1_000,
    endedAt: 7_000, rounds: [{ startedAt: 1_000, endedAt: 7_000, status: 'done' }] })
  const all = [1, 2, 3, 4].map(mk)
  const out = logEvents(roster({ executor: { instances: all, history: all } }), 9_000, 50)
  const ends = out.filter(e => e.kind === 'done').map(e => e.text)
  expect(ends).toEqual([1, 2, 3, 4].map(n => `done in 6s · Executor ${n} sleep ${n}`))
  expect(new Set(ends).size).toBe(4)
  expect(out.some(e => e.kind === 'activity')).toBe(false)
})
