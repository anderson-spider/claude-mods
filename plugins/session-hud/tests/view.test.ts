import { expect, test } from 'claude-code/testing'
import type { SessionHudCard } from '../types'
import { agentCells, cacheCells, contextOf, headCells, modelName, shownLimits, turnCells } from '../hooks/view'
import type { Row } from '../hooks/view'

const now = Date.parse('2026-10-13T12:00:00Z')
const full: SessionHudCard = {
  model: 'claude-opus-5-5', effort: 'medium', context: { tokens: 200_000, window: 1_000_000, percent: 20 }, cache: 95,
  limits: [{ kind: 'seven_day', percentUsed: 60 }, { kind: 'five_hour', percentUsed: 74 }],
  lastTurnMs: 5_000, edits: 2, errors: 1, turns: 0, agents: [], history: [],
}
const text = (row: Row) => row.map(s => s.text).join('')

test('the context is measured against the window the host compacts at, and its tokens are shown', () => {
  expect(contextOf({ ...full, context: { tokens: 440_000, window: 1_000_000, percent: 44 }, contextWindow: 500_000 })).toEqual({ percent: 88, used: 440_000, window: 500_000 })
  expect(contextOf({ ...full, context: { tokens: 520_000, window: 1_000_000, percent: 52 }, contextWindow: 500_000 })?.percent).toBe(104)
  expect(contextOf({ ...full, context: { window: 1_000_000, percent: 44 } })).toEqual({ percent: 44 })
})

test('while a turn runs the dot turns yellow and the turn time counts; between turns it is green with no time', () => {
  const running = headCells({ ...full, turnStartedAt: now - 12_000 }, now, true)
  expect(running[0]).toEqual({ text: '● ', style: 'warning' })
  expect(text(running)).toBe('● Opus 5.5 · medium · working 12s')
  const idle = headCells({ ...full, turnStartedAt: now - 12_000 }, now, false)
  expect(idle[0]).toEqual({ text: '● ', style: 'success' })
  expect(text(idle)).toBe('● Opus 5.5 · medium')
})

test('what the host has not reported is left out instead of drawn as zero', () => {
  const bare: SessionHudCard = { limits: [], edits: 0, errors: 0, turns: 0, agents: [], history: [] }
  expect([headCells(bare, now, false), cacheCells(bare), agentCells(bare)]).toEqual([[], [], []])
  expect(contextOf(bare)).toBeUndefined()
  expect(text(turnCells(bare))).toBe('0 edits · 0 errors')
  expect(text(turnCells(full))).toBe('last turn 5s · 2 edits · 1 error')
})

test('only Claude model ids reach the screen, named by family and version', () => {
  expect([modelName('claude-opus-5-5'), modelName('claude-haiku-4-5-20251001'), modelName('sonnet'), modelName(undefined)])
    .toEqual(['Opus 5.5', 'Haiku 4.5', 'Sonnet', undefined])
  for (const hostile of ['gpt-6-astra', '/Users/me', 'claude-opus-5-5\u001b[31m']) expect(modelName(hostile)).toBe('?')
  expect(text(headCells({ ...full, model: '/Users/me/secret', effort: 'loud\u001b' }, now, false))).toBe('● ?')
})

test('a spend limit and malformed figures never reach the screen as numbers', () => {
  const card: SessionHudCard = { ...full, cache: Number.NaN, edits: 1.5, errors: Number.NaN, limits: [{ kind: 'spend_limit', percentUsed: 30 }, ...full.limits] }
  expect(cacheCells(card)).toEqual([])
  expect(text(turnCells(card))).toBe('last turn 5s · 0 edits · 0 errors')
  expect(shownLimits(card).map(limit => limit.kind)).toEqual(['five_hour', 'seven_day'])
})

test('the running agents are grouped by type, model and effort, the most first; none running draws nothing', () => {
  const sonnet = 'claude-sonnet-4-5', haiku = 'claude-haiku-4-5-20251001'
  const row = (agents: SessionHudCard['agents']) => agentCells({ ...full, agents })
  expect(text(row([{ id: 'a', model: sonnet }, { id: 'b', model: haiku }, { id: 'c', model: sonnet }]))).toBe('3 agents: Sonnet 4.5 ×2, Haiku 4.5')
  expect(text(row([{ id: 'a', model: 'claude-opus-5-5' }]))).toBe('1 agent: Opus 5.5')
  expect(text(row([{ id: 'a', model: haiku }, { id: 'b', model: sonnet }]))).toBe('2 agents: Haiku 4.5, Sonnet 4.5')
  expect(row([{ id: 'a', model: sonnet }]).filter(s => s.style === 'model').map(s => s.text)).toEqual(['Sonnet 4.5'])
  expect(text(row([{ id: 'a', type: 'spider-team:reviewer', model: 'claude-opus-5-5', effort: 'high' }, { id: 'b', type: 'spider-team:reviewer', model: 'claude-opus-5-5', effort: 'high' },
    { id: 'c', type: 'Explore', model: haiku, effort: 'medium' }]))).toBe('3 agents: spider-team:reviewer Opus 5.5 · high ×2, Explore Haiku 4.5 · medium')
  expect(row([])).toEqual([])
})

test('an agent whose model or type is unknown or not a name is drawn as ?, and an unknown effort is left out', () => {
  const drawn = text(agentCells({ ...full, agents: [{ id: 'a' }, { id: 'b', model: '/Users/me/secret' }, { id: 'c', model: 'claude-sonnet-4-5' }] }))
  expect(drawn).toBe('3 agents: ? ×2, Sonnet 4.5')
  expect(text(agentCells({ ...full, agents: [{ id: 'a', type: '/Users/me secret', model: 'claude-sonnet-4-5', effort: 'loud' }] }))).toBe('1 agent: ? Sonnet 4.5')
})
