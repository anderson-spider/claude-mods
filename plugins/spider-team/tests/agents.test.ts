import { expect, test } from 'claude-code/testing'
import type { SpiderAgent, SpiderRun } from '../types'
import { TOOLS_KEPT, agentEnded, agentStepped, answeredModel, agentsOfRun, capped, resumed, spawned, stepReported, toolName, toolUsed } from '../hooks/agents'
import { STEP_BRIEF, TIERS, briefed, taskIdOf, tierOf } from '../hooks/tiers'

const BRIEF = 'spider-task: T3\nRead the auth module.'
const spawn = (list: SpiderAgent[] = [], agentId = 'a1', type = 'spider-team:spider-worker', prompt = BRIEF) => spawned(list, { agentId, type, model: 'claude-sonnet-5-5', prompt, now: 100 }, 200)
const USAGE = { model: 'claude-sonnet-5-5', input_tokens: 1_000, output_tokens: 200, cache_read_input_tokens: 9_000, cache_creation_input_tokens: 500 }

test('a spider spawn binds its task id and planned effort; any other agent is tracked with neither', () => {
  const [spider] = spawn()
  expect(spider).toMatchObject({ agentId: 'a1', tier: 'worker', taskId: 'T3', plannedEffort: 'medium', model: 'claude-sonnet-5-5', status: 'running', startedAt: 100, requests: 0 })
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
  expect(tierOf('spider-team:spider-planner')).toBe('planner')
  expect(tierOf('spider-researcher')).toBe('researcher')
  expect(tierOf('other:spider-planner')).toBeUndefined()
  expect(tierOf('general-purpose')).toBeUndefined()
  expect(tierOf(undefined)).toBeUndefined()
  expect(TIERS.planner).toEqual({ model: 'claude-opus-5-5', effort: 'medium' })
  expect(taskIdOf('intro\nspider-task: T12  \nmore')).toBe('T12')
  expect(taskIdOf('spider-task: X1')).toBeUndefined()
})

test('briefed appends the step brief once', () => {
  expect(briefed('do it', 'spider-team:spider-reviewer')).toBe(`do it${STEP_BRIEF}`)
  expect(briefed(`do it${STEP_BRIEF}`, 'spider-team:spider-reviewer')).toBe(`do it${STEP_BRIEF}`)
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
  expect(resumed(agentEnded(spawn(), 'a1', 'max_tokens', 50), 'a1', 70)[0]!.endReason).toBeUndefined()
})

test('usage taken from the turn end leaves the context unknown, since it sums every request of the turn', () => {
  const [agent] = agentEnded(spawn(), 'a1', 'answer', 50, USAGE)
  expect(agent!.usage.input).toBe(1_000)
  expect(agent!.contextTokens).toBeUndefined()
})

test('the run counts agents started while it was open and workers its tasks list, never older or later ones', () => {
  const at = (agentId: string, now: number, list: SpiderAgent[]) => spawned(list, { agentId, type: 'Explore', prompt: 'Find it.', now }, 200)
  const list = at('late', 900, at('during', 500, at('resumed', 50, at('before', 10, []))))
  const run: SpiderRun = { runId: 'r', title: 'Auth', phase: 'complete', startedAt: 100, finishedAt: 800, tasks: [
    { id: 'T1', title: 'Read', owner: 'worker', after: [], state: 'completed', attempts: 1, errors: [], agentIds: ['resumed'] },
  ] }
  expect(agentsOfRun(run, list).map(a => a.agentId)).toEqual(['resumed', 'during'])
  expect(agentsOfRun({ ...run, finishedAt: undefined, phase: 'execute' }, list).map(a => a.agentId)).toEqual(['resumed', 'during', 'late'])
})

test('usage summed at the turn end uses the base price card, never the long-prompt one', () => {
  // Several 30K requests of a Haiku 5.5 agent sum past 100K tokens; no one of them did.
  const summed = { input_tokens: 150_000, output_tokens: 0, model: 'claude-haiku-5-5' }
  const [ended] = agentEnded(spawn(), 'a1', 'answer', 50, summed)
  expect(Math.round(ended!.costUsd! * 1e6) / 1e6).toBe(0.015)
  const [stepped] = agentStepped(spawn(), 'a1', { usage: { input_tokens: 150_000, model: 'claude-haiku-5-5' } }, 10)
  expect(Math.round(stepped!.costUsd! * 1e6) / 1e6).toBe(0.075)
})

test('answeredModel prefers the model the usage names, else the fallback', () => {
  expect(answeredModel({ model: 'claude-opus-5-5' }, 'x')).toBe('claude-opus-5-5')
  expect(answeredModel({ input_tokens: 1 }, 'x')).toBe('x')
  expect(answeredModel({ model: 3 }, 'x')).toBe('x')
  expect(answeredModel(null, 'x')).toBe('x')
  expect(answeredModel(undefined, undefined)).toBeUndefined()
})

test('the run counts an agent that started exactly when it opened or when it finished', () => {
  const at = (agentId: string, now: number, list: SpiderAgent[]) => spawned(list, { agentId, type: 'Explore', prompt: 'Find it.', now }, 200)
  const list = at('after', 801, at('end', 800, at('start', 100, at('before', 99, []))))
  const run: SpiderRun = { runId: 'r', title: 'Auth', phase: 'complete', startedAt: 100, finishedAt: 800, tasks: [] }
  expect(agentsOfRun(run, list).map(a => a.agentId)).toEqual(['start', 'end'])
})

test('a running agent keeps its last tools, its call count and its failed calls; an ended or unknown one changes nothing', () => {
  let list = spawn()
  for (const [tool, failed] of [['Grep', false], ['Read', true], ['mcp__gitlab__gitlab_mr', false], ['Bash', false]] as const) list = toolUsed(list, 'a1', tool, failed, 20)
  expect(list[0]!.activity).toEqual({ tools: ['Read', 'gitlab_mr', 'Bash'].slice(-TOOLS_KEPT), calls: 4, errors: 1 })
  expect(list[0]!.lastUpdate).toBe(20)
  expect(toolUsed(list, 'zz', 'Read', false, 21)).toBe(list)
  const ended = agentEnded(list, 'a1', 'answer', 30)
  expect(toolUsed(ended, 'a1', 'Read', false, 31)).toBe(ended)
})

test("the plugin's own tools are not activity, and an MCP tool reads by its own name", () => {
  expect(toolName('mcp__spider-team__step')).toBeUndefined()
  expect(toolName('mcp__plugin_context-mode_context-mode__ctx_search')).toBe('ctx_search')
  expect(toolName('Read')).toBe('Read')
  const list = spawn()
  expect(toolUsed(list, 'a1', 'mcp__spider-team__step', false, 5)).toBe(list)
})

test('a failed agent keeps why it ended; a done or cancelled one keeps no reason', () => {
  expect(agentEnded(spawn(), 'a1', 'max_tokens', 9)[0]).toMatchObject({ status: 'failed', endReason: 'max_tokens' })
  expect(agentEnded(spawn(), 'a1', 'answer', 9)[0]!.endReason).toBeUndefined()
  expect(agentEnded(spawn(), 'a1', 'aborted', 9)[0]!.endReason).toBeUndefined()
})
