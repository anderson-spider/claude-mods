import { expect, test } from 'claude-code/testing'
import { EMPTY, HISTORY, agentBegan, agentEnded, agentStepped, began, cacheUsed, compactedNow, completed, measured, reconciled, spawned, stepped, switched, timed, tooled, touchedCache, windowed } from '../hooks/card'

test('a measurement keeps the context and the readable windows, and nothing of a cost', () => {
  const card = measured(EMPTY, { context: { tokens: 10, window: 100, percent: 10 }, cost: { usd: 1.5 },
    rateLimits: [{ kind: 'five_hour', percentUsed: 12, resetsAt: '2026-10-13T13:00:00Z' }, { kind: 'seven_day', percentUsed: Number.NaN }] } as never)
  expect(card).toEqual({ ...EMPTY, context: { tokens: 10, window: 100, percent: 10 },
    limits: [{ kind: 'five_hour', percentUsed: 12, resetsAt: '2026-10-13T13:00:00Z' }] })
  expect(measured(card, { context: { window: 100 }, rateLimits: [] })).toMatchObject({ context: { window: 100 }, limits: [] })
})

test('a step brings the effort, the model that answered and the cache share; a step without usage keeps them', () => {
  const card = stepped(EMPTY, 'high', { model: 'claude-opus-5-5', input_tokens: 10, cache_read_input_tokens: 950, cache_creation_input_tokens: 40 })
  expect(card).toMatchObject({ effort: 'high', model: 'claude-opus-5-5', cache: 95 })
  expect(stepped(card, 3, null)).toEqual(card)
})

test('the compaction window is kept when positive, and the turn start is cleared when it ends', () => {
  expect(windowed(EMPTY, 500_000)).toMatchObject({ contextWindow: 500_000 })
  for (const bad of [0, -1, Number.NaN, undefined, '500000']) expect(windowed(EMPTY, bad)).toEqual(EMPTY)
  const running = timed(began(EMPTY), 1_000)
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

test('a turn keeps its first prompt and its last prompt plus output, and joins the history when it ends, the last twelve kept', () => {
  const usage = (input: number, read: number, output: number) =>
    ({ model: 'claude-opus-5-5', input_tokens: input, output_tokens: output, cache_read_input_tokens: read, cache_creation_input_tokens: 0 })
  const running = stepped(stepped(began(EMPTY), 'high', usage(100, 1_000, 50)), 'high', usage(400, 1_100, 30))
  expect(running.pending).toEqual({ before: 1_100, after: 1_530, output: 80 })
  const done = completed(running, 10)
  expect(done.history).toEqual([{ before: 1_100, after: 1_530, output: 80 }])
  expect(done.pending).toBeUndefined()
  expect(completed(began(done), 10).history).toHaveLength(1)
  let card = EMPTY
  for (let i = 0; i < HISTORY + 3; i++) card = completed(stepped(began(card), 'high', usage(i, 0, 1)), 1)
  expect(card.history).toHaveLength(HISTORY)
  expect(card.history[0]!.before).toBe(3)
  expect(stepped(EMPTY, 'high', { ...usage(1, 1, 1), output_tokens: Number.NaN }).pending).toBeUndefined()
})

test('a step that reads or writes the cache marks when; a switch keeps only a 5m or 1h lifetime and forgets the use on another model', () => {
  const read = { model: 'claude-opus-5-5', input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 10, cache_creation_input_tokens: 0 }
  expect([touchedCache(read), touchedCache({ ...read, cache_read_input_tokens: 0 }), touchedCache(null)]).toEqual([true, false, false])
  expect(cacheUsed(EMPTY, 42).cacheUsedAt).toBe(42)
  expect(cacheUsed(EMPTY, Number.NaN)).toBe(EMPTY)
  const used = cacheUsed(EMPTY, 42)
  expect(switched(used, '1h', 'claude-opus-5-5', 'claude-opus-5-5')).toEqual({ ...used, cacheTtl: '1h' })
  expect(switched(used, '5m', 'claude-sonnet-4-5', 'claude-opus-5-5')).toEqual({ ...EMPTY, cacheTtl: '5m' })
  expect(switched(EMPTY, '2h', 'a', 'a')).toEqual(EMPTY)
})

test('a compaction marks the next turn to join the history, once, and waits through a turn with no usage', () => {
  const usage = { model: 'claude-opus-5-5', input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
  const waiting = completed(began(compactedNow(EMPTY)), 1)
  expect(waiting).toMatchObject({ compacted: true, history: [] })
  const marked = completed(stepped(began(waiting), 'high', usage), 1)
  expect(marked.history).toEqual([{ before: 10, after: 11, output: 1, compacted: true }])
  expect(marked.compacted).toBeUndefined()
  expect(completed(stepped(began(marked), 'high', usage), 1).history[1]).toEqual({ before: 10, after: 11, output: 1 })
})
