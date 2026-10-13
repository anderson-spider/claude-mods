import { expect, test } from 'claude-code/testing'
import type { SessionHudCard } from '../types'
import { cardView, modelName, type CrewSummary, type Snapshot } from '../hooks/view'

const now = Date.parse('2026-10-13T12:00:00Z')
const HOUR = 3_600_000
const at = (ms: number) => new Date(now + ms).toISOString()
const full: SessionHudCard = {
  model: 'claude-opus-5-5', effort: 'medium', context: { tokens: 200_000, window: 1_000_000, percent: 20 }, cache: 95, cost: 4.59,
  limits: [{ kind: 'seven_day', percentUsed: 60, resetsAt: at(84 * HOUR) }, { kind: 'five_hour', percentUsed: 74, resetsAt: at(38 * 60_000) }],
  lastTurnMs: 5_000, lastTurnCost: 0.16, edits: 2, errors: 1,
}
const crew: CrewSummary = { agents: 1, done: 7, running: 1, left: 1, steps: ['L1 main'] }
const view = (changes: Partial<Snapshot> = {}) => cardView({ card: full, crew, now, columns: 110, ...changes })
const text = (rows: { text: string }[][]) => rows.map(row => row.map(s => s.text).join(''))

test('the card is three rows wide: model, context, cache and cost; both windows side by side; the turn and the plan', () => {
  const card = view()
  const [model, bars, ends] = text(card.top)
  expect(model).toMatch(/^● Opus 5\.5 · medium {3}ctx ━{8} 20% {3}cache 95% +\$4\.59$/u)
  expect(bars).toMatch(/^5h {2}━+│━+ 74% +7d {2}━+│━+ 60% ▲10$/u)
  expect(ends).toMatch(/^ {4}38m left · ~85% at reset +3d 12h left · 100% in 2d 8h$/u)
  expect(text(card.bottom)).toEqual([expect.stringMatching(/^last turn 5s · 1 agent · 2 edits · 1 error · \+\$0\.16 +plan 7 done · 1 running · 1 left {2}L1 main$/u)])
  expect([...card.top, ...card.bottom].every(row => row.reduce((n, s) => n + s.text.length, 0) <= 106)).toBe(true)
})

test('the bar is lit to the percent used and its tick marks the time passed', () => {
  const [, bars] = view({ columns: 60 }).top
  const five = bars!.filter(s => s.style === 'bar' || s.style === 'track' || s.style === 'tick')
  expect(five.map(s => s.style)).toEqual(['bar', 'track', 'tick', 'track'])
  const width = five.reduce((n, s) => n + s.text.length, 0)
  // 74% used of a five-hour window with 38 minutes left: lit to 74% and ticked at 87% of the bar.
  expect(five[0]!.text.length).toBe(Math.round(0.74 * width))
  expect(five[0]!.text.length + five[1]!.text.length).toBe(Math.round((1 - 38 / 300) * width))
})

test('a narrow card stacks the windows and shrinks the plan to its counts', () => {
  const card = view({ columns: 70 })
  expect(text(card.top).map(line => line.slice(0, 4))).toEqual(['● Op', '5h  ', '    ', '7d  ', '    '])
  expect(text(card.bottom)[0]).toMatch(/plan 7\/1\/1/u)
  expect([...card.top, ...card.bottom].every(row => row.reduce((n, s) => n + s.text.length, 0) <= 66)).toBe(true)
})

test('what the host has not reported is left out instead of drawn as zero', () => {
  const bare = cardView({ card: { limits: [], edits: 0, errors: 0 }, now, columns: 110 })
  expect(bare).toEqual({ top: [], bottom: [] })
  const early = cardView({ card: { model: 'claude-opus-5-5', limits: [], edits: 0, errors: 0 }, now, columns: 110 })
  expect(text(early.top)).toEqual(['● Opus 5.5'])
  expect(text(early.bottom)).toEqual(['0 edits · 0 errors'])
  const noCrew = cardView({ card: full, now, columns: 110 })
  expect(text(noCrew.bottom)[0]).toBe('last turn 5s · 2 edits · 1 error · +$0.16')
})

test('only Claude model ids reach the screen, named by family and version', () => {
  expect([modelName('claude-opus-5-5'), modelName('claude-haiku-4-5-20251001'), modelName('sonnet'), modelName(undefined)])
    .toEqual(['Opus 5.5', 'Haiku 4.5', 'Sonnet', undefined])
  for (const hostile of ['gpt-6-astra', '/Users/me', 'claude-opus-5-5\u001b[31m']) expect(modelName(hostile)).toBe('?')
  const card = cardView({ card: { ...full, model: '/Users/me/secret', effort: 'loud\u001b' }, now, columns: 110 })
  expect(text(card.top)[0]).toMatch(/^● \? {3}ctx/u)
})

test('a spend limit and malformed figures never reach the screen as numbers', () => {
  const card = cardView({ card: { ...full, cost: Number.NaN, cache: Number.NaN, lastTurnCost: -1, edits: 1.5, errors: Number.NaN,
    limits: [{ kind: 'spend_limit', percentUsed: 30 }] }, now, columns: 110 })
  const all = [...text(card.top), ...text(card.bottom)].join('\n')
  expect(all).not.toMatch(/NaN|spend|1\.5|-1/u)
  expect(all).toContain('0 edits · 0 errors')
})
