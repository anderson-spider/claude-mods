import { expect, test } from 'claude-code/testing'
import { EMPTY, began, completed, measured, stepped, tooled, windowed } from '../hooks/card'

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

test('the compaction window is kept when positive, and the turn start is cleared when it ends', () => {
  expect(windowed(EMPTY, 500_000)).toMatchObject({ contextWindow: 500_000 })
  for (const bad of [0, -1, Number.NaN, undefined, '500000']) expect(windowed(EMPTY, bad)).toEqual(EMPTY)
  const running = began(EMPTY, 1_000)
  expect(running).toMatchObject({ turnStartedAt: 1_000 })
  expect(completed(running, 5_000)).toEqual({ ...EMPTY, lastTurnMs: 5_000 })
  expect(completed(running, Number.NaN)).toEqual(EMPTY)
})

test('a turn keeps its duration; an edit or an error counts, a refused edit and a plain call do not', () => {
  expect(completed(EMPTY, 5_000)).toMatchObject({ lastTurnMs: 5_000 })
  expect(completed(EMPTY, Number.NaN)).toEqual(EMPTY)
  expect(tooled(EMPTY, 'Edit', {})).toMatchObject({ edits: 1, errors: 0 })
  expect(tooled(EMPTY, 'Write', { deny: 'no' })).toEqual(EMPTY)
  expect(tooled(EMPTY, 'Bash', { isError: true })).toMatchObject({ edits: 0, errors: 1 })
  expect(tooled(EMPTY, 'Read', {})).toEqual(EMPTY)
})
