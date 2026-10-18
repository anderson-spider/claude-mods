import { expect, test } from 'claude-code/testing'
import type { SpiderAgent, SpiderMain, SpiderRun } from '../types'
import { DEFAULTS } from '../hooks/config'
import { paneLines } from '../hooks/pane'
import type { Piece } from '../hooks/text'

const RUN: SpiderRun = {
  runId: 'r', title: 'Auth', phase: 'execute', startedAt: 0,
  tasks: [{ id: 'T1', title: 'Build login', owner: 'opus', after: [], state: 'running', attempts: 1, errors: [], agentIds: ['a1'] }],
}
const OPUS: SpiderAgent = {
  agentId: 'a1', type: 'spider-team:spider-opus', tier: 'opus', taskId: 'T1', model: 'claude-opus-5-5', effort: 'medium', plannedEffort: 'high',
  status: 'running', startedAt: 0, lastUpdate: 0, usage: { input: 1_000, output: 500, cacheRead: 180_000, cacheWrite: 1_900 }, requests: 3,
  costUsd: 0.05, contextTokens: 42_000, steps: { done: 2, total: 5 },
}
const EXPLORE: SpiderAgent = { agentId: 'a2', type: 'Explore', status: 'done', startedAt: 0, endedAt: 61_000, lastUpdate: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, requests: 0 }
const MAIN: SpiderMain = { model: 'claude-opus-5-5', usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0 }, costUsd: 1, contextTokens: 200_000, contextWindow: 500_000 }
const all = (lines: Piece[][]) => lines.map(l => l.map(p => p.text).join('')).join('\n')
const draw = (over: Partial<Parameters<typeof paneLines>[0]> = {}) =>
  paneLines({ run: RUN, agents: [OPUS, EXPLORE], main: MAIN, config: DEFAULTS, compact: false, columns: 100, lang: 'en', now: 272_000, frame: 0, ...over })

test('the expanded pane lists agents with model, planned → actual effort, steps, tokens, context, cost and duration; unknowns read N/A', () => {
  const out = all(draw())
  expect(out).toContain('Auth')
  expect(out).toContain('spider-opus')
  expect(out).toContain('Opus 5.5')
  expect(out).toContain('high → medium')
  expect(out).toContain('2/5')
  expect(out).toContain('183.4K')
  expect(out).toContain('42.0K')
  expect(out).toContain('~$0.05')
  expect(out).toContain('04:32')
  expect(out).toContain('01:01')
  expect(out).toMatch(/Explore.*N\/A/)
  expect(out).toContain('T1 Build login')
  expect(out).toMatch(/Main.*~\$1\.00.*40%/)
  for (const line of out.split('\n')) expect([...line].length).toBeLessThanOrEqual(100)
})

test('compact mode draws one line per agent', () => {
  const lines = draw({ compact: true })
  const rows = lines.filter(l => l.some(p => p.text.includes('spider-opus') || p.text.includes('Explore')))
  expect(rows.length).toBe(2)
  expect(all(lines)).not.toContain('183.4K')
})

test('options hide cost, tokens and context', () => {
  const out = all(draw({ config: { ...DEFAULTS, showCost: false, showTokens: false, showContext: false } }))
  expect(out).not.toContain('$')
  expect(out).not.toContain('183.4K')
  expect(out).not.toContain('42.0K')
  expect(out).toContain('2/5')
})

test('the spinner moves only for running agents with animations on', () => {
  expect(all(draw({ frame: 1 }))).toContain('⠙')
  expect(all(draw({ frame: 1, config: { ...DEFAULTS, animations: false } }))).not.toContain('⠙')
})

test('without a run the pane still lists agents', () => {
  const out = all(draw({ run: null }))
  expect(out).toContain('No spider-team run')
  expect(out).toContain('spider-opus')
  expect(all(draw({ run: null, agents: [], lang: 'pt-BR' }))).toContain('Nenhum agente')
})
