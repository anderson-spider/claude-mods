import { expect, test } from 'claude-code/testing'
import type { SpiderAgent, SpiderMain, SpiderRun, SpiderTask } from '../types'
import { DEFAULTS } from '../hooks/config'
import { FRAME, paneLines, paneModel } from '../hooks/pane'
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
const MAIN: SpiderMain = { model: 'claude-opus-5-5', usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0 }, costUsd: 1, contextTokens: 200_000, contextWindow: 500_000 }
const all = (lines: Piece[][]) => lines.map(l => l.map(p => p.text).join('')).join('\n')
const view = (over: Partial<Parameters<typeof paneLines>[0]> = {}) => ({ run: RUN, agents: [WORKER, EXPLORE], main: MAIN, config: DEFAULTS, columns: 110, lang: 'en' as const, now: 272_000, frame: 0, ...over })
const draw = (over: Partial<Parameters<typeof paneLines>[0]> = {}) => paneLines(view(over))
const section = (key: string, over: Partial<Parameters<typeof paneLines>[0]> = {}) => paneModel(view(over)).sections.find(s => s.key === key)

test('the pane is sections in order: plan, running, recent, timeline and totals, each in its theme colour', () => {
  expect(paneModel(view()).sections.map(s => [s.key, s.border])).toEqual([
    ['plan', 'suggestion'], ['running', 'success'], ['recent', 'subtle'], ['timeline', 'merged'], ['totals', 'subtle'],
  ])
  const header = all([paneModel(view()).header])
  expect(header).toMatch(/^Auth · Execute +● 1 running · 1 recent$/)
  expect([...header].length).toBe(110)
  expect(all([paneModel(view()).footer])).toBe('2 agents')
})

test('the pane shows each running agent with model, planned → actual effort, context, steps, tokens, cost and duration; unknown figures are left out', () => {
  const out = all(section('running')!.lines)
  expect(out).toContain('worker')
  expect(out).toContain('T1')
  expect(out).toContain('Sonnet 5.5 · medium → high')
  expect(out).toContain('ctx ')
  expect(out).toContain(' 21%')
  expect(out).toContain('2/5 steps')
  expect(out).toContain('↑182.9K ↓500')
  expect(out).toContain('~$0.05')
  expect(out).toContain('04:32')
  const recent = all(section('recent')!.lines)
  expect(recent).toMatch(/✓ Explore .*01:01/)
  expect(recent).not.toContain('N/A')
  expect(recent).not.toContain('$')
  expect(recent).toContain('3 min ago')
  for (const line of draw().map(l => l.map(p => p.text).join(''))) expect([...line].length).toBeLessThanOrEqual(110)
})

test("a running agent's activity line shows its note, its latest tools, its calls and its failed calls", () => {
  const lines = section('running')!.lines
  const activity = lines.find(l => l.some(p => p.text === 'Edit'))!
  expect(all([activity])).toBe('   └ writing tests · Grep · Read · Edit  9 calls  ✗ 1')
  expect(activity.find(p => p.text === 'Edit')!.style).toBe('plain')
  expect(activity.find(p => p.text === 'Grep')!.style).toBe('dim')
  expect(activity.find(p => p.text.includes('✗'))!.style).toBe('error')
  const one = section('running', { agents: [{ ...WORKER, steps: undefined, activity: { tools: ['Bash'], calls: 1, errors: 0 } }], lang: 'pt-BR' })!.lines
  expect(all([one.at(-1)!])).toBe('   └ Bash  1 chamada')
  const quiet = section('running', { agents: [{ ...WORKER, steps: undefined, activity: undefined }] })!.lines
  expect(all(quiet)).not.toContain('└')
})

test('a narrow pane puts an agent figures on a second line and every line fits', () => {
  const lines = section('running', { columns: 60 })!.lines
  expect(all([lines[0]!])).toMatch(/worker .*Sonnet 5\.5.*04:32$/)
  expect(all([lines[0]!])).not.toContain('ctx')
  expect(all([lines[1]!])).toContain('ctx ')
  for (const line of draw({ columns: 60 }).map(l => l.map(p => p.text).join(''))) expect([...line].length).toBeLessThanOrEqual(60)
  for (const s of paneModel(view({ columns: 60 })).sections) for (const line of s.lines) expect([...all([line])].length).toBeLessThanOrEqual(60 - FRAME)
})

test('options hide cost, tokens and context, and the totals with all three', () => {
  const config = { ...DEFAULTS, showCost: false, showTokens: false, showContext: false }
  const out = all(draw({ config }))
  expect(out).not.toContain('$')
  expect(out).not.toContain('182.9K')
  expect(out).not.toContain('ctx')
  expect(out).toContain('2/5 steps')
  expect(section('totals', { config })).toBeUndefined()
})

test('the totals have a header row and Main, the subagents and the session', () => {
  const out = all(section('totals')!.lines)
  expect(out).toMatch(/^ +Tokens +Cost +Context\n/)
  expect(out).toMatch(/Main +20 +~\$1\.00 +40%/)
  expect(out).toMatch(/Subagents +183\.4K +~\$0\.05/)
  expect(out).toMatch(/Session/)
})

test('the spinner moves only for running agents with animations on', () => {
  expect(all(draw({ frame: 1 }))).toContain('⠙')
  expect(all(draw({ frame: 1, config: { ...DEFAULTS, animations: false } }))).not.toContain('⠙')
  expect(all(draw({ config: { ...DEFAULTS, animations: false } }))).toContain('● worker')
})

test('without a run the pane still lists agents, and without agents it says so', () => {
  const out = all(draw({ run: null }))
  expect(out).toContain('No spider-team run')
  expect(out).toContain('worker')
  expect(paneModel(view({ run: null })).sections.some(s => s.key === 'plan')).toBe(false)
  expect(all(draw({ run: null, agents: [], lang: 'pt-BR' }))).toContain('Nenhum agente')
})

test('the plan is a tree with counts: blocked tasks name what they wait for, failed show the error, accepted their evidence, cancelled only with the run', () => {
  const task = (id: string, state: SpiderTask['state'], over: Partial<SpiderTask> = {}): SpiderTask => ({ id, title: `Task ${id}`, owner: 'worker', after: [], state, attempts: 1, errors: [], agentIds: [], ...over })
  const run: SpiderRun = { ...RUN, tasks: [
    task('T1', 'completed', { evidence: 'tests pass' }), task('T2', 'pending', { after: ['T1', 'T3'] }), task('T3', 'failed', { after: ['T1'], errors: ['old', 'timed out'] }),
    task('T4', 'running', { agentIds: ['a1'], after: ['T1'] }), task('T5', 'cancelled'), task('T6', 'cancelled', { cancelledWithRun: true }),
  ] }
  const plan = section('plan', { run })!
  expect(all([plan.aside])).toBe('1 accepted / 1 running / 1 left / 1 failed / 1 cancelled')
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
  const line = all(section('plan', { run, columns: 60 })!.lines.slice(0, 1))
  expect(line).toContain('…')
  expect(line).toContain('worker · running')
})

test("the run's agents come first and the session's other agents follow under their own label", () => {
  const before = { ...EXPLORE, agentId: 'a0', startedAt: -5_000 }
  const keys = paneModel(view({ agents: [before, WORKER] })).sections.map(s => s.key)
  expect(keys.indexOf('running')).toBeLessThan(keys.indexOf('others'))
  expect(all(section('others', { agents: [before, WORKER] })!.lines)).toContain('Explore')
  expect(section('others')).toBeUndefined()
  expect(section('others', { run: null, agents: [before] })).toBeUndefined()
  expect(section('others', { agents: [before], lang: 'pt-BR' })!.title).toBe('Outros agentes · 1')
})

test('a failed agent shows why it ended, and the recent list counts what it leaves out', () => {
  const failed: SpiderAgent = { ...EXPLORE, agentId: 'f', status: 'failed', endReason: 'max_tokens', endedAt: 200_000 }
  const row = section('recent', { agents: [WORKER, failed] })!.lines[0]!
  expect(row[0]).toEqual({ text: '✗', style: 'error' })
  expect(row.find(p => p.text === 'max_tokens')!.style).toBe('error')
  const many = Array.from({ length: 9 }, (_, i) => ({ ...EXPLORE, agentId: `d${i}`, endedAt: 1_000 * i }))
  const lines = section('recent', { agents: many })!.lines
  expect(lines.length).toBe(7)
  expect(all([lines.at(-1)!])).toBe('  +3 more')
})

test('the timeline draws a bar per agent in the last 15 minutes, with an axis and a legend', () => {
  const now = 20 * 60_000
  const old = { ...EXPLORE, agentId: 'old', endedAt: 60_000 }
  const failed: SpiderAgent = { ...EXPLORE, agentId: 'f', status: 'failed', startedAt: 10 * 60_000, endedAt: 12 * 60_000 }
  const lines = section('timeline', { now, agents: [{ ...WORKER, startedAt: 18 * 60_000 }, failed, old] })!.lines
  expect(lines.length).toBe(4)
  expect(lines[0]!.some(p => p.style === 'ok' && p.text.includes('━'))).toBe(true)
  expect(lines[1]!.some(p => p.style === 'error' && p.text.includes('━'))).toBe(true)
  expect(all([lines[2]!])).toMatch(/−15m.*−10m.*−5m.*now$/)
  expect(all([lines[3]!])).toContain('running')
  expect(section('timeline', { now: 60 * 60_000, agents: [old] })).toBeUndefined()
})

test('tasks the run cancelled stay counted, and a failed agent keeps its reason and age at 110 columns', () => {
  const run: SpiderRun = { ...RUN, phase: 'cancelled', tasks: [{ ...RUN.tasks[0]!, state: 'cancelled', cancelledWithRun: true }] }
  expect(all([section('plan', { run })!.aside])).toBe('0 accepted / 0 running / 0 left / 1 cancelled')
  const failed: SpiderAgent = { ...WORKER, contextWindow: undefined, status: 'failed', endReason: 'max_tokens', endedAt: 92_000 }
  const row = all([section('recent', { agents: [failed] })!.lines[0]!])
  expect(row).toContain('max_tokens  3 min ago')
  const busy = section('running', { columns: 100, agents: [{ ...WORKER, contextWindow: undefined }] })!.lines
  expect(all(busy)).toContain('~$0.05')
})

test('with a run but only outside agents the pane does not claim there are none', () => {
  const before = { ...EXPLORE, agentId: 'a0', startedAt: -5_000 }
  expect(paneModel(view({ agents: [before] })).sections.map(s => s.key)).not.toContain('running')
})
