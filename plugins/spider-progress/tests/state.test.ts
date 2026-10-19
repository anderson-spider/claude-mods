import { expect, test } from 'claude-code/testing'
import type { SpiderRun } from '../types'
import { LIMITS, MAX_ATTEMPTS, applyProgress, bindWorker, effectiveState, progressOf, workerEnded } from '../hooks/state'

let ids = 0
const ctx = () => ({ now: 1_000, newRunId: () => `run-${++ids}` })
const PLAN = { title: 'Auth', tasks: [{ id: 'T1', title: 'Read', owner: 'main' }, { id: 'T2', title: 'Build', owner: 'worker', after: ['T1'] }, { id: 'T3', title: 'Docs', owner: 'researcher' }] }
const start = () => applyProgress(null, PLAN, ctx()).run as SpiderRun
const set = (run: SpiderRun | null, id: string, state: string) => applyProgress(run, { task: { id, state } }, ctx())

test('the first call with a title and tasks starts a run in plan with pending tasks', () => {
  const { run, text } = applyProgress(null, PLAN, { now: 5, newRunId: () => 'run-x' })
  expect(run?.runId).toBe('run-x')
  expect(run?.phase).toBe('plan')
  expect(run?.startedAt).toBe(5)
  expect(run?.tasks.map(t => [t.id, t.state, t.attempts])).toEqual([['T1', 'pending', 1], ['T2', 'pending', 1], ['T3', 'pending', 1]])
  expect(text).toBe('ok: 0/3 tasks accepted · plan')
})

test('a call without a title and no run is refused', () => {
  expect(applyProgress(null, { phase: 'execute' }, ctx())).toEqual({ run: null, text: 'refused: no run; start one with a title' })
})

test('a task waits blocked until every after task is completed', () => {
  let run = start()
  expect(effectiveState(run, run.tasks[1]!)).toBe('blocked')
  run = set(run, 'T1', 'running').run!
  run = set(run, 'T1', 'completed').run!
  expect(effectiveState(run, run.tasks[1]!)).toBe('pending')
})

test('repeating the same call changes nothing', () => {
  const run = set(start(), 'T1', 'running').run!
  const again = set(run, 'T1', 'running')
  expect(again.run).toEqual(run)
  expect(again.text).toBe('ok: 0/3 tasks accepted · plan')
})

test('an invalid transition is refused with the reason', () => {
  let run = set(start(), 'T1', 'completed').run!
  const back = set(run, 'T1', 'running')
  expect(back.run).toEqual(run)
  expect(back.text).toBe('refused: T1 is completed')
  run = applyProgress(run, { task: { id: 'T9', state: 'running' } }, ctx()).run!
  expect(set(run, 'T9', 'running').text).toBe('refused: no task T9')
  expect(set(run, 'T3', 'blocked').text).toBe('refused: blocked is derived, not set')
})

test('a retry from reviewing counts the attempt and stops at three', () => {
  let run = set(start(), 'T1', 'running').run!
  for (let round = 2; round <= MAX_ATTEMPTS; round++) {
    run = set(run, 'T1', 'reviewing').run!
    run = set(run, 'T1', 'running').run!
    expect(run.tasks[0]!.attempts).toBe(round)
  }
  run = set(run, 'T1', 'reviewing').run!
  expect(set(run, 'T1', 'running').text).toBe(`refused: T1 reached ${MAX_ATTEMPTS} attempts; escalate or fail it`)
})

test("a replan keeps kept ids' state, cancels dropped ones and the percent ignores cancelled", () => {
  let run = set(start(), 'T1', 'completed').run!
  run = applyProgress(run, { tasks: [{ id: 'T1', title: 'Read', owner: 'main' }, { id: 'T4', title: 'New', owner: 'reviewer' }] }, ctx()).run!
  expect(run.tasks.map(t => [t.id, t.state])).toEqual([['T1', 'completed'], ['T4', 'pending'], ['T2', 'cancelled'], ['T3', 'cancelled']])
  expect(progressOf(run)).toEqual({ accepted: 1, total: 2, percent: 50 })
})

test('a replan cancels every dropped task, restarts a re-added cancelled one and keeps at most the task limit', () => {
  let run = set(start(), 'T2', 'failed').run!
  run = applyProgress(run, { tasks: [{ id: 'T1', title: 'Read', owner: 'main' }, { id: 'T3', title: 'Docs', owner: 'researcher' }] }, ctx()).run!
  expect(run.tasks.find(t => t.id === 'T2')!.state).toBe('cancelled')
  run = set(set(run, 'T1', 'completed').run, 'T3', 'completed').run!
  expect(progressOf(run)).toEqual({ accepted: 2, total: 2, percent: 100 })
  run = applyProgress(run, { tasks: [{ id: 'T1', title: 'Read', owner: 'main' }, { id: 'T2', title: 'Build again', owner: 'worker' }, { id: 'T3', title: 'Docs', owner: 'researcher' }] }, ctx()).run!
  expect(run.tasks.find(t => t.id === 'T2')).toMatchObject({ state: 'pending', attempts: 1, title: 'Build again' })
  expect(set(run, 'T2', 'running').text).toBe('ok: 2/3 tasks accepted · plan')
  const many = (from: number) => Array.from({ length: LIMITS.tasks }, (_, i) => ({ id: `T${from + i}`, title: 'x', owner: 'main' }))
  let big = applyProgress(null, { title: 'Big', tasks: many(1) }, ctx()).run!
  big = applyProgress(big, { tasks: many(101) }, ctx()).run!
  expect(big.tasks.length).toBe(LIMITS.tasks)
  expect(progressOf(big).total).toBe(LIMITS.tasks)
})

test('progress is undefined without tasks and counts only completed', () => {
  const empty = applyProgress(null, { title: 'Bare' }, ctx()).run!
  expect(progressOf(empty)).toEqual({ accepted: 0, total: 0 })
  const run = set(set(start(), 'T1', 'running').run, 'T1', 'reviewing').run!
  expect(progressOf(run)).toEqual({ accepted: 0, total: 3, percent: 0 })
})

test('finished closes the run and later calls for it are ignored with ok', () => {
  const run = applyProgress(start(), { finished: true }, ctx()).run!
  expect(run.phase).toBe('complete')
  expect(run.finishedAt).toBe(1_000)
  expect(set(run, 'T1', 'running')).toEqual({ run, text: 'ok: the run is over · 0/3 tasks accepted · complete' })
  expect(applyProgress(run, { finished: true }, ctx())).toEqual({ run, text: 'ok: the run is over · 0/3 tasks accepted · complete' })
  expect(applyProgress(run, { title: 'Auth', finished: true }, ctx()).run).toBe(run)
})

test('the complete phase then finished closes once, and a task sent with the closing phase is applied first', () => {
  const closed = applyProgress(start(), { phase: 'complete' }, ctx()).run!
  expect(applyProgress(closed, { finished: true }, ctx()).text).toBe('ok: the run is over · 0/3 tasks accepted · complete')
  const run = set(start(), 'T1', 'running').run!
  const both = applyProgress(run, { task: { id: 'T1', state: 'completed' }, phase: 'complete' }, ctx())
  expect(both.text).toBe('ok: 1/3 tasks accepted · complete')
})

test('a different title on an open run starts a new run and leaves the old tasks behind', () => {
  const old = set(set(start(), 'T1', 'running').run, 'T1', 'completed').run!
  const { run, text } = applyProgress(old, { title: 'Billing', phase: 'plan', tasks: [{ id: 'T1', title: 'Read', owner: 'main' }, { id: 'T2', title: 'Pay', owner: 'worker' }] }, { now: 9_000, newRunId: () => 'run-new' })
  expect(run).toMatchObject({ runId: 'run-new', title: 'Billing', startedAt: 9_000 })
  expect(run!.tasks.map(t => [t.id, t.state, t.agentIds, t.evidence])).toEqual([['T1', 'pending', [], undefined], ['T2', 'pending', [], undefined]])
  expect(text).toBe('ok: 0/2 tasks accepted · plan')
})

test('after finished a new title starts a new run', () => {
  const old = applyProgress(start(), { finished: true }, ctx()).run!
  const { run } = applyProgress(old, { title: 'Next', tasks: [{ id: 'T1', title: 'Go', owner: 'main' }] }, ctx())
  expect(run?.runId).not.toBe(old.runId)
  expect(run?.title).toBe('Next')
  expect(run?.tasks.map(t => t.id)).toEqual(['T1'])
})

test('cancelled sets every open task cancelled and the phase cancelled', () => {
  const done = set(start(), 'T1', 'completed').run!
  const run = applyProgress(done, { cancelled: true }, ctx()).run!
  expect(run.phase).toBe('cancelled')
  expect(run.tasks.map(t => t.state)).toEqual(['completed', 'cancelled', 'cancelled'])
})

test('tasks a cancelled run leaves open stay in the count, unlike tasks a replan dropped', () => {
  let run = applyProgress(set(start(), 'T1', 'completed').run, { tasks: PLAN.tasks.slice(0, 2) }, ctx()).run!
  const { run: over, text } = applyProgress(run, { cancelled: true }, ctx())
  expect(text).toBe('ok: 1/2 tasks accepted · cancelled')
  expect(progressOf(over!)).toEqual({ accepted: 1, total: 2, percent: 50 })
  run = applyProgress(set(start(), 'T1', 'completed').run, { phase: 'cancelled' }, ctx()).run!
  expect(progressOf(run)).toEqual({ accepted: 1, total: 3, percent: 33 })
})

test('a task Main cancelled before the run was cancelled stays out of the total', () => {
  const asked = set(start(), 'T1', 'cancelled').run!
  const run = applyProgress(asked, { cancelled: true }, ctx()).run!
  expect(run.tasks.map(t => [t.id, t.state, t.cancelledWithRun])).toEqual([['T1', 'cancelled', undefined], ['T2', 'cancelled', true], ['T3', 'cancelled', true]])
  expect(progressOf(run)).toEqual({ accepted: 0, total: 2, percent: 0 })
})

test('new tasks from one replan do not share their errors or agentIds', () => {
  const [a, b] = start().tasks
  expect(a!.errors).not.toBe(b!.errors)
  expect(a!.agentIds).not.toBe(b!.agentIds)
  let run = bindWorker(start(), 'T1', 'agent-1')
  run = workerEnded(run, 'T1', 'agent-1', false, 'timed out')
  expect(run.tasks[0]).toMatchObject({ errors: ['timed out'], agentIds: ['agent-1'] })
  expect(run.tasks.slice(1).map(t => [t.errors, t.agentIds])).toEqual([[[], []], [[], []]])
})

test('a worker error is cut to the text limit', () => {
  const run = workerEnded(bindWorker(start(), 'T1', 'agent-1'), 'T1', 'agent-1', false, 'e'.repeat(5_000))
  expect(run.tasks[0]!.errors[0]!.length).toBe(LIMITS.text)
})

test('junk input is bounded, unknown deps dropped and a cycle refused', () => {
  const many = Array.from({ length: 500 }, (_, i) => ({ id: `T${i + 1}`, title: 'x'.repeat(400), owner: 'main', after: ['T999', 7] }))
  const run = applyProgress(null, { title: 'y'.repeat(400), tasks: many }, ctx()).run!
  expect(run.title.length).toBe(LIMITS.title)
  expect(run.tasks.length).toBe(LIMITS.tasks)
  expect(run.tasks[0]!.title.length).toBe(LIMITS.title)
  expect(run.tasks[0]!.after).toEqual([])
  const bad = applyProgress(null, { title: 'Bad', tasks: [{ id: 3, title: 'n', owner: 'main' }, { id: 'T1', title: 'ok', owner: 'wizard' }] }, ctx())
  expect(bad.text).toBe('refused: each task needs an id like T1, a title and an owner (main, planner, worker, researcher or reviewer)')
  const cycle = applyProgress(null, { title: 'Loop', tasks: [{ id: 'T1', title: 'a', owner: 'main', after: ['T2'] }, { id: 'T2', title: 'b', owner: 'main', after: ['T1'] }] }, ctx())
  expect(cycle).toEqual({ run: null, text: 'refused: the dependencies form a cycle (T1 → T2 → T1)' })
})

test('bindWorker moves a pending task to running; workerEnded moves it to reviewing or records the error', () => {
  let run = bindWorker(start(), 'T3', 'agent-1')
  expect(run.tasks[2]).toMatchObject({ state: 'running', agentIds: ['agent-1'] })
  run = workerEnded(run, 'T3', 'agent-1', false, 'timed out')
  expect(run.tasks[2]).toMatchObject({ state: 'running', errors: ['timed out'] })
  run = workerEnded(run, 'T3', 'agent-1', true)
  expect(run.tasks[2]!.state).toBe('reviewing')
  expect(bindWorker(run, 'T9', 'agent-2')).toEqual(run)
})

test('a worker that the task does not list moves nothing', () => {
  const run = bindWorker(start(), 'T1', 'agent-new')
  expect(workerEnded(run, 'T1', 'agent-old', true)).toBe(run)
  expect(workerEnded(run, 'T1', 'agent-old', false, 'crashed')).toBe(run)
})

test('a refusal names a long task id cut short', () => {
  const { text } = set(start(), `T${'x'.repeat(5_000)}`, 'running')
  expect(text.length).toBeLessThanOrEqual('refused: no task '.length + LIMITS.id)
  expect(text).toContain('…')
})

test('a plan longer than the task limit keeps the first tasks and says so', () => {
  const many = Array.from({ length: 150 }, (_, i) => ({ id: `T${i + 1}`, title: 'x', owner: 'main' }))
  const { run, text } = applyProgress(null, { title: 'Big', tasks: many }, ctx())
  expect(run!.tasks.length).toBe(LIMITS.tasks)
  expect(text).toBe(`ok: 0/${LIMITS.tasks} tasks accepted · plan · only the first ${LIMITS.tasks} tasks were kept`)
})
