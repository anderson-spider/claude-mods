import { expect, test } from 'claude-code/testing'
import { EMPTY, agentBegan, agentEnded, agentStepped, began, completed, measured, reconciled, spawned, stepped, tooled, windowed } from '../hooks/card'

test('a measurement keeps the context, the readable windows and the cost; the turn cost runs from the baseline', () => {
  const card = measured(EMPTY, { context: { tokens: 10, window: 100, percent: 10 }, cost: { usd: 1.5 },
    rateLimits: [{ kind: 'five_hour', percentUsed: 12, resetsAt: '2026-10-13T13:00:00Z' }, { kind: 'seven_day', percentUsed: Number.NaN }] }, 1.25)
  expect(card).toEqual({ ...EMPTY, context: { tokens: 10, window: 100, percent: 10 }, cost: 1.5, lastTurnCost: 0.25,
    limits: [{ kind: 'five_hour', percentUsed: 12, resetsAt: '2026-10-13T13:00:00Z' }] })
  expect(measured(card, { context: { window: 100 }, rateLimits: [] }, undefined)).toMatchObject({ cost: 1.5, lastTurnCost: 0.25, limits: [] })
})

test('a step brings the effort, the model that answered and the cache share; a step without usage keeps them', () => {
  const card = stepped(EMPTY, 'high', { model: 'claude-opus-5-5', input_tokens: 10, cache_read_input_tokens: 950, cache_creation_input_tokens: 40 })
  expect(card).toMatchObject({ effort: 'high', model: 'claude-opus-5-5', cache: 95 })
  expect(stepped(card, 3, null)).toEqual(card)
})

test('the session start is kept from a measurement, and each step adds its output tokens', () => {
  expect(measured(EMPTY, { context: { window: 100 }, rateLimits: [], startedAt: 1_000 }, undefined)).toMatchObject({ startedAt: 1_000 })
  const usage = { model: 'claude-opus-5-5', input_tokens: 1, output_tokens: 300, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
  expect(stepped(stepped(EMPTY, 'high', usage), 'high', usage).output).toBe(600)
  expect(stepped(EMPTY, 'high', { ...usage, output_tokens: Number.NaN }).output).toBe(0)
})

test('the compaction window is kept when positive, and the turn start is cleared when it ends', () => {
  expect(windowed(EMPTY, 500_000)).toMatchObject({ contextWindow: 500_000 })
  for (const bad of [0, -1, Number.NaN, undefined, '500000']) expect(windowed(EMPTY, bad)).toEqual(EMPTY)
  const running = began(EMPTY, 1_000)
  expect(running).toMatchObject({ turnStartedAt: 1_000 })
  expect(completed(running, 5_000)).toEqual({ ...EMPTY, lastTurnMs: 5_000, turns: 1 })
  expect(completed(running, Number.NaN)).toEqual({ ...EMPTY, turns: 1 })
})

test('a turn keeps its duration and counts; an edit or an error counts, a refused edit and a plain call do not', () => {
  expect(completed(EMPTY, 5_000)).toMatchObject({ lastTurnMs: 5_000, turns: 1 })
  expect(completed(EMPTY, Number.NaN)).toEqual({ ...EMPTY, turns: 1 })
  expect(tooled(EMPTY, 'Edit', {})).toMatchObject({ edits: 1, errors: 0 })
  expect(tooled(EMPTY, 'Write', { deny: 'no' })).toEqual(EMPTY)
  expect(tooled(EMPTY, 'Bash', { isError: true })).toMatchObject({ edits: 0, errors: 1 })
  expect(tooled(EMPTY, 'Read', {})).toEqual(EMPTY)
})

test('a spawned agent runs on its model; a turn start adds one unknown, a step names the model that answered and adds none, its end removes it', () => {
  const one = spawned(EMPTY, 'a1', 'claude-sonnet-4-5')
  expect(one.agents).toEqual([{ id: 'a1', model: 'claude-sonnet-4-5' }])
  expect(spawned(one, 'a1', 'haiku').agents).toEqual([{ id: 'a1', model: 'haiku' }])
  expect(agentBegan(one, 'a1')).toBe(one)
  const two = agentBegan(one, 'a2')
  expect(two.agents).toEqual([{ id: 'a1', model: 'claude-sonnet-4-5' }, { id: 'a2' }])
  expect(agentStepped(two, 'a2', 'claude-haiku-4-5').agents).toEqual([{ id: 'a1', model: 'claude-sonnet-4-5' }, { id: 'a2', model: 'claude-haiku-4-5' }])
  expect(agentStepped(two, 'a3', 'claude-opus-5-5')).toBe(two)
  expect(agentStepped(agentEnded(two, 'a2'), 'a2', 'claude-haiku-4-5').agents).toEqual([{ id: 'a1', model: 'claude-sonnet-4-5' }])
  expect(agentStepped(two, 'a1', undefined)).toBe(two)
  expect(agentEnded(two, 'a1').agents).toEqual([{ id: 'a2' }])
  expect(agentEnded(two, 'gone')).toBe(two)
})

test('ids and models that are not strings are left out', () => {
  for (const bad of [undefined, 3, '', null]) {
    expect(spawned(EMPTY, bad, 'claude-sonnet-4-5')).toEqual(EMPTY)
    expect(agentBegan(EMPTY, bad)).toEqual(EMPTY)
    expect(agentEnded(spawned(EMPTY, 'a1', 'haiku'), bad).agents).toHaveLength(1)
  }
  expect(spawned(EMPTY, 'a1', 42).agents).toEqual([{ id: 'a1' }])
  expect(agentStepped(spawned(EMPTY, 'a1', 'haiku'), 'a1', Number.NaN).agents).toEqual([{ id: 'a1', model: 'haiku' }])
})

test('the agent list removes the agents it shows idle or ended, keeps the ones it does not list and adds none', () => {
  const card = ['run', 'wait', 'idle', 'done', 'fail', 'kill', 'flow'].reduce((c, id) => spawned(c, id, 'haiku'), EMPTY)
  const list = [{ id: 'run', status: 'running' }, { id: 'wait', status: 'waiting' }, { id: 'idle', status: 'idle' },
    { id: 'done', status: 'completed' }, { id: 'fail', status: 'failed' }, { id: 'kill', status: 'killed' }, { id: 'new', status: 'running' }]
  expect(reconciled(card, list).agents.map(agent => agent.id)).toEqual(['run', 'wait', 'flow'])
  expect(reconciled(card, [])).toBe(card)
})
