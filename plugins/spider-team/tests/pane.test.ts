import { expect, test } from 'claude-code/testing'
import type { SpiderAgent, SpiderMain, SpiderRun, SpiderTask } from '../types'
import { DEFAULTS } from '../hooks/config'
import { FRAME, paneLines, paneModel, rowsOf } from '../hooks/pane'
import type { Piece } from '../hooks/text'

const RUN: SpiderRun = {
  runId: 'r', title: 'Auth', phase: 'execute', startedAt: 0,
  tasks: [{ id: 'T1', title: 'Build login', owner: 'worker', after: [], state: 'running', attempts: 1, errors: [], agentIds: ['a1'] }],
}
const WORKER: SpiderAgent = {
  agentId: 'a1', type: 'spider-team:spider-worker', tier: 'worker', taskId: 'T1', model: 'claude-sonnet-5-5', effort: 'high', plannedEffort: 'medium',
  status: 'running', startedAt: 0, lastUpdate: 0, usage: { input: 1_000, output: 500, cacheRead: 180_000, cacheWrite: 1_900 }, requests: 3,
  costUsd: 0.05, contextTokens: 42_000, contextWindow: 200_000, steps: { done: 2, total: 5, note: 'writing tests' },
  activity: { tools: ['Grep', 'Read', 'Edit'], calls: 9, errors: 1 },
}
const EXPLORE: SpiderAgent = { agentId: 'a2', type: 'Explore', status: 'done', startedAt: 0, endedAt: 61_000, lastUpdate: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, requests: 0 }
const MAIN: SpiderMain = { model: 'claude-opus-5-5', effort: 'medium', usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0 }, costUsd: 1, contextTokens: 200_000, contextWindow: 500_000, busySince: 0 }
const all = (lines: Piece[][]) => lines.map(l => l.map(p => p.text).join('')).join('\n')
type View = Parameters<typeof paneLines>[0]
const view = (over: Partial<View> = {}): View => ({ run: RUN, agents: [WORKER, EXPLORE], main: MAIN, config: DEFAULTS, columns: 110, lang: 'en', now: 272_000, frame: 0, ...over })
const draw = (over: Partial<View> = {}) => paneLines(view(over))
const card = (key: string, over: Partial<View> = {}) => paneModel(view(over)).cards.find(c => c.key === key)

test('the pane is cards in order, each in its tone: session, plan, running, finished, planned and the timeline', () => {
  const run: SpiderRun = { ...RUN, tasks: [...RUN.tasks, { id: 'T2', title: 'Review', owner: 'reviewer', after: ['T1'], state: 'pending', attempts: 1, errors: [], agentIds: [] }] }
  expect(paneModel(view({ run })).cards.map(c => [c.key, c.tone])).toEqual([
    ['session', 'claude'], ['plan', 'suggestion'], ['running', 'success'], ['finished', 'inactive'], ['planned', 'warning'], ['timeline', 'merged'],
  ])
  const header = paneModel(view()).header
  expect(header[0]).toEqual({ text: ' SPIDER ', style: 'badge' })
  expect(all([header])).toMatch(/^ SPIDER {3}Panel · Auth · Execute +● 1 running$/)
  expect([...all([header])].length).toBe(110)
  expect(all([paneModel(view()).footer])).toBe('2 agents')
})

test("the session card shows Main's model, effort and state, its context gauge and tokens, then the costs and the run's time", () => {
  const lines = card('session')!.lines
  expect(all([lines[0]!])).toMatch(/^Opus 5\.5 · medium +● working$/)
  expect(lines[0]![0]).toEqual({ text: 'Opus 5.5', style: 'title', tone: 'claude' })
  expect(all([lines[1]!])).toMatch(/^ctx ▰+▱+ 40% {3}10↑ 10↓$/)
  expect(all([lines[2]!])).toBe('cost ~$1.00   subagents ~$0.05   Session ~$1.05   time 04:32')
  expect(all(card('session', { main: { ...MAIN, busySince: undefined }, lang: 'pt-BR' })!.lines)).toContain('○ ocioso')
  expect(all([card('session', { columns: 60 })!.lines[2]!])).toBe('cost ~$1.00   sub ~$0.05   time 04:32')
  const quiet = all(card('session', { config: { ...DEFAULTS, showCost: false, showTokens: false, showContext: false } })!.lines)
  expect(quiet).not.toContain('$')
  expect(quiet).not.toContain('ctx')
})

test('a running agent has a row in its role tone with model, an attempt block and time, then its activity and figures', () => {
  const lines = card('running')!.lines
  const row = lines[0]!
  expect(all([row])).toMatch(/^⠋ worker +Sonnet 5\.5 +▮ +04:32 +T1 writing tests$/)
  expect(row.find(p => p.text.startsWith('worker'))).toMatchObject({ style: 'title', tone: 'suggestion' })
  expect(row.find(p => p.text === '▮')).toMatchObject({ style: 'bar', tone: 'suggestion' })
  expect(all([lines[1]!])).toBe('  └ medium → high · 2/5 steps · Grep · Read · Edit  9 calls  ✗ 1  ctx 21%  182.9K↑ 500↓  ~$0.05')
  expect(lines[1]!.find(p => p.text === 'Edit')!.style).toBe('plain')
  expect(lines[1]!.find(p => p.text.includes('✗'))!.style).toBe('error')
  expect(card('running')!.count).toBe('1')
  for (const c of paneModel(view({ columns: 60 })).cards) for (const line of c.lines) expect([...all([line])].length).toBeLessThanOrEqual(60 - FRAME)
})

test('an agent shows one block per attempt at its task: earlier ones done or failed, the current in its tone', () => {
  const run: SpiderRun = { ...RUN, tasks: [{ ...RUN.tasks[0]!, attempts: 2, agentIds: ['old', 'a1'] }] }
  const old: SpiderAgent = { ...WORKER, agentId: 'old', status: 'failed', endedAt: 1_000 }
  const blocks = card('running', { run, agents: [old, WORKER] })!.lines[0]!.filter(p => p.text === '▮')
  expect(blocks.map(p => p.tone)).toEqual(['error', 'suggestion'])
})

test('finished agents show how they ended, why a failed one did and when, and the card counts what it leaves out', () => {
  const failed: SpiderAgent = { ...EXPLORE, agentId: 'f', status: 'failed', endReason: 'max_tokens', endedAt: 200_000 }
  const rows = card('finished', { agents: [WORKER, failed, EXPLORE] })!.lines
  expect(rows[0]![0]).toEqual({ text: '●', style: 'error' })
  expect(all([rows[0]!])).toMatch(/Explore .*max_tokens · 1 min ago$/)
  expect(all([rows[1]!])).toMatch(/^● Explore .*01:01 +3 min ago$/)
  const many = Array.from({ length: 9 }, (_, i) => ({ ...EXPLORE, agentId: `d${i}`, endedAt: 1_000 * i }))
  const lines = card('finished', { agents: many })!.lines
  expect(lines.length).toBe(7)
  expect(all([lines.at(-1)!])).toBe('  +3 more')
})

test("planned agents are the role tasks no agent has taken yet, with the role's model and a hollow block", () => {
  const task = (id: string, owner: SpiderTask['owner'], over: Partial<SpiderTask> = {}): SpiderTask => ({ id, title: `Task ${id}`, owner, after: [], state: 'pending', attempts: 1, errors: [], agentIds: [], ...over })
  const run: SpiderRun = { ...RUN, tasks: [...RUN.tasks, task('T2', 'reviewer', { after: ['T1'] }), task('T3', 'main'), task('T4', 'planner', { state: 'cancelled' })] }
  const planned = card('planned', { run, lang: 'pt-BR' })!
  expect(planned.title).toBe('Agentes · planejados')
  expect(planned.count).toBe('1')
  expect(all(planned.lines)).toMatch(/^● reviewer +Opus 5\.5 +▯ +— +T2 Task T2$/)
  expect(planned.lines[0]!.find(p => p.text.startsWith('reviewer'))!.tone).toBe('planMode')
})

test('the plan card counts accepted tasks, draws a gauge and is a tree: blocked tasks name what they wait for, failed show the error', () => {
  const task = (id: string, state: SpiderTask['state'], over: Partial<SpiderTask> = {}): SpiderTask => ({ id, title: `Task ${id}`, owner: 'worker', after: [], state, attempts: 1, errors: [], agentIds: [], ...over })
  const run: SpiderRun = { ...RUN, tasks: [
    task('T1', 'completed', { evidence: 'tests pass' }), task('T2', 'pending', { after: ['T1', 'T3'] }), task('T3', 'failed', { after: ['T1'], errors: ['old', 'timed out'] }),
    task('T4', 'running', { agentIds: ['a1'], after: ['T1'] }), task('T5', 'cancelled'), task('T6', 'cancelled', { cancelledWithRun: true }),
  ] }
  const plan = card('plan', { run })!
  expect(plan.count).toBe('1/5')
  expect(all([plan.aside])).toBe('✗ 1  ▰▱▱▱▱▱ 20%')
  const rows = all(plan.lines).split('\n')
  expect(rows[0]).toBe('✓ T1 Task T1  worker · accepted')
  expect(rows[1]).toBe('│  tests pass')
  expect(rows).toContain('├─ ✗ T3 Task T3  worker · failed')
  expect(rows).toContain('│  └─ ○ T2 Task T2  worker · blocked  waits T3')
  expect(rows.some(r => r.includes('timed out'))).toBe(true)
  expect(rows).toContain('└─ ◎ T4 Task T4  worker · running (2/5)  ← worker')
  expect(rows.some(r => r.includes('T5'))).toBe(false)
  expect(rows).toContain('– T6 Task T6  worker · cancelled')
})

test('a long task title is cut so its owner and state stay in view', () => {
  const run = { ...RUN, tasks: [{ ...RUN.tasks[0]!, title: 'x'.repeat(200) }] }
  const line = all(card('plan', { run, columns: 60 })!.lines.slice(0, 1))
  expect(line).toContain('…')
  expect(line).toContain('worker · running')
})

test("the timeline has a lane per role, Main first, lit in one-minute buckets where it worked, and an axis", () => {
  const now = 20 * 60_000
  const main: SpiderMain = { ...MAIN, busySince: undefined, turns: [[6 * 60_000, 7 * 60_000]] }
  const old = { ...EXPLORE, agentId: 'old', endedAt: 60_000 }
  const lines = card('timeline', { now, main, agents: [{ ...WORKER, startedAt: 18 * 60_000 }, old] })!.lines
  expect(lines.map(l => l[0]!.text.trim())).toEqual(['main', 'worker', ''])
  expect(lines[0]![0]!.tone).toBe('claude')
  const cw = (110 - FRAME - 12) / 15 | 0
  expect(all([lines[0]!]).slice(12)).toBe(`${'·'.repeat(cw)}${'━'.repeat(cw)}${'·'.repeat(13 * cw)}`)
  expect(all([lines[1]!]).slice(12).endsWith(`${'·'.repeat(cw)}${'━'.repeat(2 * cw)}`)).toBe(true)
  expect(lines[1]!.find(p => p.text.includes('━'))!.tone).toBe('suggestion')
  expect(all([lines[2]!])).toMatch(/^ +−15m +now$/)
  expect(card('timeline', { now: 60 * 60_000, main: { ...MAIN, busySince: undefined }, agents: [old] })).toBeUndefined()
})

test('without a run the pane still lists agents, and without agents it says so', () => {
  const out = all(draw({ run: null }))
  expect(out).toContain('no spider-team run')
  expect(out).toContain('worker')
  expect(paneModel(view({ run: null })).cards.some(c => c.key === 'plan')).toBe(false)
  expect(all(draw({ run: null, agents: [], lang: 'pt-BR' }))).toContain('Nenhum agente')
})

test('the spinner and the rail move only while agents run with animations on', () => {
  expect(all(draw({ frame: 1 }))).toContain('⠙')
  expect(paneModel(view()).motion).toBe(true)
  const still = view({ frame: 1, config: { ...DEFAULTS, animations: false } })
  expect(all(paneLines(still))).not.toContain('⠙')
  expect(paneModel(still).motion).toBe(false)
  expect(paneModel(view({ agents: [EXPLORE] })).motion).toBe(false)
})

test('short of rows the pane drops the timeline first, then the finished and the planned agents', () => {
  const run: SpiderRun = { ...RUN, tasks: [...RUN.tasks, { id: 'T2', title: 'Review', owner: 'reviewer', after: ['T1'], state: 'pending', attempts: 1, errors: [], agentIds: [] }] }
  const keys = (rows: number) => paneModel(view({ run, rows })).cards.map(c => c.key)
  const full = paneModel(view({ run })).cards
  expect(keys(rowsOf(full))).toContain('timeline')
  expect(keys(rowsOf(full) - 1)).toEqual(['session', 'plan', 'running', 'finished', 'planned'])
  expect(keys(1)).toEqual(['session', 'plan', 'running'])
})

test('tasks the run cancelled stay in the plan counts', () => {
  const task = (id: string, state: SpiderTask['state']): SpiderTask => ({ id, title: id, owner: 'main', after: [], state, attempts: 1, errors: [], agentIds: [] })
  const run: SpiderRun = { ...RUN, phase: 'cancelled', tasks: [task('T1', 'completed'), { ...task('T2', 'cancelled'), cancelledWithRun: true }, task('T3', 'cancelled')] }
  const plan = card('plan', { run, agents: [] })!
  expect(plan.count).toBe('1/2')
  expect(all(plan.lines)).toContain('– T2 T2  main · cancelled')
})
