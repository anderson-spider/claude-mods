import { expect, test } from 'claude-code/testing'
import type { SpiderAgent, SpiderMain, SpiderRun, SpiderTask } from '../types'
import { DEFAULTS } from '../hooks/config'
import { paneLines } from '../hooks/pane'
import type { Piece } from '../hooks/text'

const RUN: SpiderRun = {
  runId: 'r', title: 'Auth', phase: 'execute', startedAt: 0,
  tasks: [{ id: 'T1', title: 'Build login', owner: 'worker', after: [], state: 'running', attempts: 1, errors: [], agentIds: ['a1'] }],
}
const WORKER: SpiderAgent = {
  agentId: 'a1', type: 'spider-team:spider-worker', tier: 'worker', taskId: 'T1', model: 'claude-sonnet-5-5', effort: 'high', plannedEffort: 'medium',
  status: 'running', startedAt: 0, lastUpdate: 0, usage: { input: 1_000, output: 500, cacheRead: 180_000, cacheWrite: 1_900 }, requests: 3,
  costUsd: 0.05, contextTokens: 42_000, steps: { done: 2, total: 5 },
}
const EXPLORE: SpiderAgent = { agentId: 'a2', type: 'Explore', status: 'done', startedAt: 0, endedAt: 61_000, lastUpdate: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, requests: 0 }
const MAIN: SpiderMain = { model: 'claude-opus-5-5', usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0 }, costUsd: 1, contextTokens: 200_000, contextWindow: 500_000 }
const all = (lines: Piece[][]) => lines.map(l => l.map(p => p.text).join('')).join('\n')
const draw = (over: Partial<Parameters<typeof paneLines>[0]> = {}) =>
  paneLines({ run: RUN, agents: [WORKER, EXPLORE], main: MAIN, config: DEFAULTS, compact: false, columns: 100, lang: 'en', now: 272_000, frame: 0, ...over })

test('the expanded pane lists agents with model, planned → actual effort, steps, tokens, context, cost and duration; unknowns read N/A', () => {
  const out = all(draw())
  expect(out).toContain('Auth')
  expect(out).toContain('spider-worker')
  expect(out).toContain('Sonnet 5.5')
  expect(out).toContain('medium → high')
  expect(out).toContain('2/5 40%')
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
  const rows = lines.filter(l => l.some(p => p.text.includes('spider-worker') || p.text.includes('Explore')))
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
  expect(out).toContain('spider-worker')
  expect(all(draw({ run: null, agents: [], lang: 'pt-BR' }))).toContain('Nenhum agente')
})

test('with animations off the bar stands still and a running agent keeps a fixed mark', () => {
  const off = { ...DEFAULTS, animations: false }
  const open = { ...RUN, tasks: [] }
  expect(all(draw({ run: open, frame: 3, config: off }))).toBe(all(draw({ run: open, frame: 0, config: off })))
  expect(all(draw({ config: off }))).toContain('● running')
})

test('the task list shows blocked in warning, failed with its error and accepted with its evidence, cancelled only with the run', () => {
  const task = (id: string, state: SpiderTask['state'], over: Partial<SpiderTask> = {}): SpiderTask => ({ id, title: `Task ${id}`, owner: 'worker', after: [], state, attempts: 1, errors: [], agentIds: [], ...over })
  const run: SpiderRun = { ...RUN, tasks: [
    task('T1', 'completed', { evidence: 'tests pass' }), task('T2', 'pending', { after: ['T3'] }), task('T3', 'failed', { errors: ['old', 'timed out'] }),
    task('T4', 'running', { agentIds: ['a1'] }), task('T5', 'cancelled'), task('T6', 'cancelled', { cancelledWithRun: true }),
  ] }
  const lines = draw({ run })
  const line = (id: string) => lines.find(l => l[0]?.text === `${id} Task ${id}`)
  expect(line('T1')!.map(x => x.text).join('')).toBe('T1 Task T1 · worker · accepted · tests pass')
  expect(line('T2')!.some(x => x.style === 'warn' && x.text.includes('blocked'))).toBe(true)
  expect(line('T3')!.some(x => x.style === 'error' && x.text.includes('failed'))).toBe(true)
  expect(line('T3')!.map(x => x.text).join('')).toContain('timed out')
  expect(line('T4')!.map(x => x.text).join('')).toBe('T4 Task T4 · worker · running (2/5)')
  expect(line('T5')).toBeUndefined()
  expect(line('T6')!.map(x => x.text).join('')).toBe('T6 Task T6 · worker · cancelled')
})

test("the run's agents come first and the session's other agents follow under their own label", () => {
  const before = { ...EXPLORE, agentId: 'a0', startedAt: -5_000 }
  const rows = all(draw({ agents: [before, WORKER] })).split('\n')
  const at = (text: string) => rows.findIndex(r => r.includes(text))
  expect(at('spider-worker')).toBeLessThan(at('OTHER AGENTS'))
  expect(at('OTHER AGENTS')).toBeLessThan(at('Explore'))
  expect(all(draw())).not.toContain('OTHER AGENTS')
  expect(all(draw({ run: null, agents: [before] }))).not.toContain('OTHER AGENTS')
  expect(all(draw({ agents: [before], lang: 'pt-BR' }))).toContain('OUTROS AGENTES')
})
