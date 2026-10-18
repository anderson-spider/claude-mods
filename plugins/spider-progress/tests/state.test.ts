import { expect, test } from 'claude-code/testing'
import type { SpiderRun } from '../types'
import { LIMITS, MAX_ATTEMPTS, applyProgress, bindWorker, effectiveState, progressOf, workerEnded } from '../hooks/state'

let ids = 0
const ctx = () => ({ now: 1_000, newRunId: () => `run-${++ids}` })
const PLAN = { title: 'Auth', tasks: [{ id: 'T1', title: 'Read', owner: 'main' }, { id: 'T2', title: 'Build', owner: 'opus', after: ['T1'] }, { id: 'T3', title: 'Docs', owner: 'haiku' }] }
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
  run = applyProgress(run, { tasks: [{ id: 'T1', title: 'Read', owner: 'main' }, { id: 'T4', title: 'New', owner: 'sonnet' }] }, ctx()).run!
  expect(run.tasks.map(t => [t.id, t.state])).toEqual([['T1', 'completed'], ['T4', 'pending'], ['T2', 'cancelled'], ['T3', 'cancelled']])
  expect(progressOf(run)).toEqual({ accepted: 1, total: 2, percent: 50 })
})

test('progress is undefined without tasks and counts only completed', () => {
  const empty = applyProgress(null, { title: 'Bare' }, ctx()).run!
  expect(progressOf(empty)).toEqual({ accepted: 0, total: 0 })
  const run = set(set(start(), 'T1', 'running').run, 'T1', 'reviewing').run!
  expect(progressOf(run)).toEqual({ accepted: 0, total: 3, percent: 0 })
})

test('finished closes the run and later calls for it are refused', () => {
  const run = applyProgress(start(), { finished: true }, ctx()).run!
  expect(run.phase).toBe('complete')
  expect(run.finishedAt).toBe(1_000)
  expect(set(run, 'T1', 'running').text).toBe('refused: the run is over; start a new one with a new title')
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

test('junk input is bounded, unknown deps dropped and a cycle refused', () => {
  const many = Array.from({ length: 500 }, (_, i) => ({ id: `T${i + 1}`, title: 'x'.repeat(400), owner: 'main', after: ['T999', 7] }))
  const run = applyProgress(null, { title: 'y'.repeat(400), tasks: many }, ctx()).run!
  expect(run.title.length).toBe(LIMITS.title)
  expect(run.tasks.length).toBe(LIMITS.tasks)
  expect(run.tasks[0]!.title.length).toBe(LIMITS.title)
  expect(run.tasks[0]!.after).toEqual([])
  const bad = applyProgress(null, { title: 'Bad', tasks: [{ id: 3, title: 'n', owner: 'main' }, { id: 'T1', title: 'ok', owner: 'wizard' }] }, ctx())
  expect(bad.text).toBe('refused: each task needs an id like T1, a title and an owner (main, explore, fable, opus, sonnet or haiku)')
  const cycle = applyProgress(null, { title: 'Loop', tasks: [{ id: 'T1', title: 'a', owner: 'main', after: ['T2'] }, { id: 'T2', title: 'b', owner: 'main', after: ['T1'] }] }, ctx())
  expect(cycle).toEqual({ run: null, text: 'refused: the dependencies form a cycle (T1 → T2 → T1)' })
})

test('bindWorker moves a pending task to running; workerEnded moves it to reviewing or records the error', () => {
  let run = bindWorker(start(), 'T3', 'agent-1')
  expect(run.tasks[2]).toMatchObject({ state: 'running', agentIds: ['agent-1'] })
  run = workerEnded(run, 'T3', false, 'timed out')
  expect(run.tasks[2]).toMatchObject({ state: 'running', errors: ['timed out'] })
  run = workerEnded(run, 'T3', true)
  expect(run.tasks[2]!.state).toBe('reviewing')
  expect(bindWorker(run, 'T9', 'agent-2')).toEqual(run)
})
