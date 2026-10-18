import { expect, test } from 'claude-code/testing'
import type { SpiderAgent } from '../types'
import { agentEnded, agentStepped, capped, resumed, spawned, stepReported } from '../hooks/agents'
import { STEP_BRIEF, TIERS, briefed, taskIdOf, tierOf } from '../hooks/tiers'

const BRIEF = 'spider-task: T3\nRead the auth module.'
const spawn = (list: SpiderAgent[] = [], agentId = 'a1', type = 'spider-team:spider-sonnet', prompt = BRIEF) => spawned(list, { agentId, type, model: 'claude-sonnet-5-5', prompt, now: 100 }, 200)
const USAGE = { model: 'claude-sonnet-5-5', input_tokens: 1_000, output_tokens: 200, cache_read_input_tokens: 9_000, cache_creation_input_tokens: 500 }

test('a spider spawn binds its task id and planned effort; any other agent is tracked with neither', () => {
  const [spider] = spawn()
  expect(spider).toMatchObject({ agentId: 'a1', tier: 'sonnet', taskId: 'T3', plannedEffort: 'high', model: 'claude-sonnet-5-5', status: 'running', startedAt: 100, requests: 0 })
  const [other] = spawn([], 'a2', 'Explore', 'Find the router.')
  expect(other!.tier).toBeUndefined()
  expect(other!.taskId).toBeUndefined()
  expect(other!.plannedEffort).toBeUndefined()
  const list = spawn()
  expect(spawn(list)).toEqual(list)
})

test('a step from an unknown or ended agent is ignored with a reason', () => {
  let list = spawn()
  expect(stepReported(list, undefined, { done: 1, total: 2 }, 5).text).toBe('refused: only a subagent reports steps; Main reports with progress')
  expect(stepReported(list, 'zz', { done: 1, total: 2 }, 5).text).toBe('ignored: no agent zz')
  expect(stepReported(list, 'a1', { done: 3, total: 2 }, 5).text).toBe('refused: done and total must be whole numbers with 0 ≤ done ≤ total ≤ 1000')
  list = agentEnded(list, 'a1', 'answer', 9)
  const late = stepReported(list, 'a1', { done: 1, total: 2 }, 10)
  expect(late).toEqual({ list, text: 'ignored: a1 already ended' })
})

test('steps are absolute, so a repeat changes nothing', () => {
  const first = stepReported(spawn(), 'a1', { done: 2, total: 5, note: 'tests' }, 7)
  expect(first.text).toBe('ok: 2/5')
  expect(first.list[0]!.steps).toEqual({ done: 2, total: 5, note: 'tests' })
  expect(stepReported(first.list, 'a1', { done: 2, total: 5, note: 'tests' }, 8).list).toEqual(first.list)
})

test("usage accumulates per request and context is the last request's input side", () => {
  let list = agentStepped(spawn(), 'a1', { model: 'claude-sonnet-5-5', effort: 'medium', usage: USAGE }, 10)
  list = agentStepped(list, 'a1', { model: 'claude-sonnet-5-5', effort: 'medium', usage: { ...USAGE, cache_read_input_tokens: 11_000 } }, 11)
  expect(list[0]).toMatchObject({ effort: 'medium', requests: 2, contextTokens: 12_500, lastUpdate: 11, usage: { input: 2_000, output: 400, cacheRead: 20_000, cacheWrite: 1_000 } })
  expect(list[0]!.costUsd).toBeGreaterThan(0)
  const unpriced = agentStepped(spawn(), 'a1', { model: 'mystery-1', usage: { ...USAGE, model: 'mystery-1' } }, 10)
  expect(unpriced[0]!.costUsd).toBeUndefined()
  expect(unpriced[0]!.costPartial).toBe(true)
  expect(agentStepped(spawn(), 'zz', { usage: USAGE }, 10)).toEqual(spawn())
})

test('an agent that never reports steps still ends with its usage', () => {
  const list = agentEnded(spawn(), 'a1', 'answer', 50, USAGE)
  expect(list[0]).toMatchObject({ status: 'done', endedAt: 50, requests: 1, usage: { input: 1_000, output: 200 } })
  expect(list[0]!.steps).toBeUndefined()
  expect(agentEnded(spawn(), 'a1', 'aborted', 50)[0]!.status).toBe('cancelled')
  expect(agentEnded(spawn(), 'a1', 'error', 50)[0]!.status).toBe('failed')
  expect(agentEnded(list, 'a1', 'error', 60)).toEqual(list)
})

test('the history cap drops the oldest finished agents and keeps running ones', () => {
  let list: SpiderAgent[] = []
  for (const id of ['a', 'b', 'c', 'd']) list = spawn(list, id)
  list = agentEnded(agentEnded(list, 'b', 'answer', 1), 'c', 'answer', 1)
  expect(capped(list, 3).map(a => a.agentId)).toEqual(['a', 'c', 'd'])
  expect(capped(list, 2).map(a => a.agentId)).toEqual(['a', 'd'])
  expect(capped(list, 1).map(a => a.agentId)).toEqual(['a', 'd'])
})

test('tierOf strips the plugin namespace and ignores other types', () => {
  expect(tierOf('spider-team:spider-opus')).toBe('opus')
  expect(tierOf('spider-haiku')).toBe('haiku')
  expect(tierOf('other:spider-opus')).toBeUndefined()
  expect(tierOf('general-purpose')).toBeUndefined()
  expect(tierOf(undefined)).toBeUndefined()
  expect(TIERS.fable).toEqual({ model: 'fable', effort: 'high' })
  expect(taskIdOf('intro\nspider-task: T12  \nmore')).toBe('T12')
  expect(taskIdOf('spider-task: X1')).toBeUndefined()
})

test('briefed appends the step brief once', () => {
  expect(briefed('do it', 'spider-team:spider-opus')).toBe(`do it${STEP_BRIEF}`)
  expect(briefed(`do it${STEP_BRIEF}`, 'spider-team:spider-opus')).toBe(`do it${STEP_BRIEF}`)
  expect(briefed('do it', 'Explore')).toBe('do it')
})

test('a resumed agent runs again with its usage kept and reports steps again', () => {
  const ended = agentEnded(agentStepped(spawn(), 'a1', { usage: USAGE }, 10), 'a1', 'answer', 50)
  const [again] = resumed(ended, 'a1', 70)
  expect(again).toMatchObject({ status: 'running', lastUpdate: 70, requests: 1, usage: { input: 1_000 } })
  expect(again!.endedAt).toBeUndefined()
  expect(stepReported([again!], 'a1', { done: 1, total: 2 }, 80).text).toBe('ok: 1/2')
  expect(resumed(spawn(), 'a1', 70)).toEqual(spawn())
  expect(resumed(ended, 'zz', 70)).toBe(ended)
})
