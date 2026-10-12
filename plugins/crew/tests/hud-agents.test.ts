import { expect, test } from 'claude-code/testing'
import {
  FINISHED_MAX,
  activityOf,
  consultingText,
  elapsedOf,
  finishedInline,
  finishedRows,
  fmtAgo,
  jobStrip,
  newestConsults,
  plannedFor,
  reviewRecent,
  runningEmptyText,
  runningRows,
} from '../hooks/hud/agents-view'
import {
  agentCompleted,
  agentDenied,
  agentMessaged,
  agentSpawned,
  agentStepped,
  agentTool,
  consultEnded,
  consultStarted,
} from '../hooks/hud/state'
import type { AgentCard, Consult } from '../hooks/hud/types'

const T0 = Date.parse('2026-10-12T12:00:00Z')
const MIN = 60_000
const glyphs = (cells: { glyph: string }[]) => cells.map(c => c.glyph).join('')

const spawn = (list: AgentCard[], id: string, over: Partial<Parameters<typeof agentSpawned>[1]> = {}) =>
  agentSpawned(list, { id, type: 'crew:developer', description: `T2: task ${id}`, now: T0, ...over })
const end = (list: AgentCard[], id: string, reason: string, now = T0 + MIN) => agentCompleted(list, { id, reason, now })

// ------------------------------------------------------------------ job strips

test('a strip is one cell per job of the type, oldest first, then one planned cell per queued step', () => {
  let list = spawn([], 'a', { now: T0 })
  list = end(list, 'a', 'answer', T0 + 10)
  list = spawn(list, 'b', { now: T0 + 20 })
  list = end(list, 'b', 'error', T0 + 30)
  list = spawn(list, 'c', { now: T0 + 40 })
  list = spawn(list, 'd', { now: T0 + 50 })
  list = end(list, 'd', 'aborted', T0 + 60)
  const strip = jobStrip(list, 'crew:developer', 2)
  expect(glyphs(strip.cells)).toBe('▰✗▶▪▱▱')
  expect(strip.more).toBe(0)
  expect(strip.cells.map(c => c.tone)).toEqual(['ok', 'bad', 'role', 'dim', 'dim', 'dim'])
  // another type has its own strip
  expect(glyphs(jobStrip(list, 'crew:tester', 1).cells)).toBe('▱')
  expect(jobStrip(list, 'crew:tester', 0)).toEqual({ cells: [], more: 0 })
})

test('beyond six glyphs the oldest finished jobs are folded into +N; running and planned cells stay', () => {
  let list: AgentCard[] = []
  for (let i = 0; i < 6; i++) {
    list = spawn(list, `a${i}`, { now: T0 + i * 100 })
    list = end(list, `a${i}`, i === 2 ? 'error' : 'answer', T0 + i * 100 + 50)
  }
  list = spawn(list, 'live', { now: T0 + 1000 })
  const strip = jobStrip(list, 'crew:developer', 2)
  expect(strip.more).toBe(3)
  expect(glyphs(strip.cells)).toBe('▰▰▰▶▱▱')
  expect(strip.cells).toHaveLength(6)
  // folding just the oldest keeps the failure after it
  expect(glyphs(jobStrip(list, 'crew:developer', 0).cells)).toBe('▰✗▰▰▰▶')
  expect(jobStrip(list, 'crew:developer', 0).more).toBe(1)
  // too many planned cells fold last
  expect(jobStrip(list, 'crew:developer', 9, 6).cells.every(c => c.glyph === '▱' || c.glyph === '▶')).toBe(true)
  expect(jobStrip(list, 'crew:developer', 9, 6).cells).toHaveLength(6)
})

test('plannedFor counts the queued steps an owner type has', () => {
  const steps = [
    { owner: 'crew:developer', state: 'queued' },
    { owner: 'crew:developer', state: 'queued' },
    { owner: 'crew:developer', state: 'implementing' },
    { owner: 'crew:tester', state: 'queued' },
    { owner: 'lead', state: 'queued' },
    { owner: 'crew:developer-codex', state: 'queued' },
  ]
  expect(plannedFor(steps, 'crew:developer')).toBe(2)
  expect(plannedFor(steps, 'crew:developer-codex')).toBe(1)
  expect(plannedFor(steps, 'crew:architect')).toBe(0)
})

// ------------------------------------------------------------------ running rows

test('the activity line: starting, the last tool with context, a denial in red', () => {
  let list = spawn([], 'a')
  expect(activityOf(list[0] as AgentCard, 200_000)).toEqual({ kind: 'starting', text: 'starting…', ctxPct: null })
  list = agentStepped(list, { id: 'a', usage: { input_tokens: 82_000 }, now: T0 })
  expect(activityOf(list[0] as AgentCard, 200_000)).toEqual({ kind: 'idle', text: '', ctxPct: 41 })
  list = agentTool(list, 'a', 'Edit internal/config/contract_on.go')
  expect(activityOf(list[0] as AgentCard, 200_000)).toEqual({ kind: 'tool', text: 'Edit internal/config/contract_on.go', ctxPct: 41 })
  list = agentDenied(list, 'a', 'Bash git push')
  expect(activityOf(list[0] as AgentCard, 200_000)).toEqual({ kind: 'denied', text: '✗ denied Bash git push', ctxPct: 41 })
  // a tool before the first usage is not "starting"
  expect(activityOf(agentTool(spawn([], 'b'), 'b', 'Read x')[0] as AgentCard, 0).kind).toBe('tool')
})

test('running rows: oldest first, with name, clock, strip and activity', () => {
  let list = spawn([], 'b', { type: 'crew:code-reader-codex', description: 'where is it?', now: T0 + 10 * MIN })
  list = spawn(list, 'a', { now: T0 + 7 * MIN })
  list = spawn(list, 'done', { type: 'crew:tester', now: T0 })
  list = end(list, 'done', 'answer', T0 + 1)
  const rows = runningRows(list, { now: T0 + 10 * MIN + 21_000, window: 200_000, planned: type => (type === 'crew:developer' ? 2 : 0) })
  expect(rows.map(r => [r.card.id, r.name, r.elapsed])).toEqual([
    ['a', 'developer', '3:21'],
    ['b', 'reader·cx', '0:21'],
  ])
  expect(glyphs(rows[0]?.strip.cells ?? [])).toBe('▶▱▱')
  expect(rows[0]?.activity.kind).toBe('starting')
})

test('elapsed counts from the current job\'s start: to now while it runs, to its last end once finished, across its rounds', () => {
  let list = spawn([], 'a')
  expect(elapsedOf(list[0] as AgentCard, T0 + 5000)).toBe(5000)
  list = end(list, 'a', 'answer', T0 + 3000)
  expect(elapsedOf(list[0] as AgentCard, T0 + 99_000)).toBe(3000)
  // A background task wakes the agent: the same run goes on, so its clock keeps counting from the spawn.
  list = agentStepped(list, { id: 'a', usage: { input_tokens: 1 }, now: T0 + 10_000 })
  expect(elapsedOf(list[0] as AgentCard, T0 + 12_000)).toBe(12_000)
  list = end(list, 'a', 'answer', T0 + 33_000)
  expect(elapsedOf(list[0] as AgentCard, T0 + 99_000)).toBe(33_000)
  // The lead sends fixes: a new job, and the clock starts at its first step.
  list = agentStepped(agentMessaged(list, 'a'), { id: 'a', usage: { input_tokens: 1 }, now: T0 + 26 * MIN })
  expect(elapsedOf(list[0] as AgentCard, T0 + 26 * MIN + 10_000)).toBe(10_000)
  list = end(list, 'a', 'answer', T0 + 30 * MIN)
  expect(finishedRows(list, { planned: () => 0 })[0]?.duration).toBe('4:00')
})

test('a finished row of an agent that ended twice shows spawn to last end, as the running clock counted', () => {
  // The live case: ended at 11 s, woke for a background Bash, ended again at 33 s; the row used to read the last round.
  let list = spawn([], 'a')
  list = end(list, 'a', 'answer', T0 + 11_000)
  expect(finishedRows(list, { planned: () => 0 })[0]?.duration).toBe('0:11')
  list = agentStepped(list, { id: 'a', usage: { input_tokens: 1 }, now: T0 + 31_000 })
  expect(runningRows(list, { now: T0 + 32_000, window: 0, planned: () => 0 })[0]?.elapsed).toBe('0:32')
  list = end(list, 'a', 'answer', T0 + 33_000)
  expect((list[0] as AgentCard).rounds).toHaveLength(2)
  expect(finishedRows(list, { planned: () => 0 })[0]?.duration).toBe('0:33')
})

test('the empty running card', () => {
  expect(runningEmptyText([], T0)).toBe('No agents yet; delegated work shows here.')
  const ended = end(spawn([], 'a'), 'a', 'answer', T0 + 1000)
  expect(runningEmptyText(ended, T0 + 1000 + 2 * MIN)).toBe('Nothing running · last agent ended 2 min ago')
  expect(runningEmptyText(ended, T0 + 1500)).toBe('Nothing running · last agent ended just now')
  expect(fmtAgo(59_000)).toBe('just now')
  expect(fmtAgo(3 * 3_600_000)).toBe('3 h ago')
  expect(runningEmptyText(spawn([], 'a'), T0)).toBe('Nothing running')
})

// ------------------------------------------------------------------ finished rows

test('finished rows: one per type with nothing live, most recent first, with the task by outcome', () => {
  let list = spawn([], 'tc', { type: 'crew:tester-codex', description: 'T0 allowlist check', now: T0 })
  list = end(list, 'tc', 'answer', T0 + 106_000)
  list = spawn(list, 'r', { type: 'crew:research', description: 'compare libs', now: T0 + 200_000 })
  list = agentStepped(list, { id: 'r', stopReason: 'max_tokens', now: T0 + 210_000 })
  list = end(list, 'r', 'error', T0 + 330_000)
  list = spawn(list, 'd', { type: 'crew:designer', description: 'HUD spec', now: T0 + 400_000 })
  list = end(list, 'd', 'aborted', T0 + 412_000)
  list = spawn(list, 'live', { type: 'crew:developer' })
  const rows = finishedRows(list, { planned: () => 0 })
  expect(rows.map(r => [r.name, r.glyph, r.duration, r.task])).toEqual([
    ['designer', '■', '0:12', 'stopped · HUD spec'],
    ['research', '✗', '2:10', 'failed · max_tokens'],
    ['tester·cx', '✓', '1:46', 'T0 allowlist check'],
  ])
  expect(rows.map(r => r.status)).toEqual(['stopped', 'failed', 'done'])
  expect(rows.map(r => glyphs(r.strip.cells))).toEqual(['▪', '✗', '▰'])
  expect(FINISHED_MAX).toBe(5)
})

test('a type with a live agent has no finished row; the latest ended job speaks for a type', () => {
  let list = end(spawn([], 'a', { now: T0 }), 'a', 'error', T0 + 10)
  list = spawn(list, 'b', { now: T0 + 20, description: 'second' })
  list = end(list, 'b', 'answer', T0 + 40)
  const rows = finishedRows(list, { planned: () => 0 })
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({ status: 'done', task: 'second' })
  expect(glyphs(rows[0]?.strip.cells ?? [])).toBe('✗▰')
  // now one is running again
  expect(finishedRows(spawn(list, 'c', { now: T0 + 50 }), { planned: () => 0 })).toEqual([])
})

test('a failure without a named cause says error; the inline form at level 4', () => {
  const list = end(spawn([], 'a', { type: 'crew:tester-codex' }), 'a', 'error')
  expect(finishedRows(list, { planned: () => 0 })[0]?.task).toBe('failed · error')
  let more = spawn(list, 'b', { type: 'crew:research', now: T0 + 1 })
  more = end(more, 'b', 'answer', T0 + 100)
  more = spawn(more, 'c', { type: 'crew:designer', now: T0 + 2 })
  more = end(more, 'c', 'answer', T0 + 90)
  more = spawn(more, 'd', { type: 'crew:code-reader', now: T0 + 3 })
  more = end(more, 'd', 'answer', T0 + 80)
  const rows = finishedRows(more, { planned: () => 0 })
  expect(finishedInline(rows, 3)).toBe('done: tester·cx ✗ · research ▰ · designer ▰ · +1')
  expect(finishedInline(rows.slice(0, 1), 3)).toBe('done: tester·cx ✗')
  expect(finishedInline([], 3)).toBe('')
})

// ------------------------------------------------------------------ review

const consults = (): Consult[] => {
  let list = consultStarted([], { id: 'c1', type: 'crew:architect', description: 'T1 module path', now: T0 })
  list = consultEnded(list, { id: 'c1', now: T0 + MIN, answer: 'Approve: clean' })
  list = consultStarted(list, { id: 'c2', type: 'crew:architect-codex', description: 'T2 approach', now: T0 + 20 * MIN })
  list = consultEnded(list, { id: 'c2', now: T0 + 22 * MIN, answer: 'Fixes: races' })
  list = consultStarted(list, { id: 'c3', type: 'crew:architect', description: 'T3 audit', now: T0 + 40 * MIN })
  return list
}

test('newest consults first, capped', () => {
  expect(newestConsults(consults(), 2).map(c => c.id)).toEqual(['c3', 'c2'])
  expect(newestConsults(consults(), 9).map(c => c.id)).toEqual(['c3', 'c2', 'c1'])
  expect(newestConsults([], 3)).toEqual([])
})

test('the mini Review line: a consult running or ended in the last ten minutes', () => {
  const list = consults()
  expect(reviewRecent(list, T0 + 41 * MIN)?.id).toBe('c3')
  const done = consultEnded(list, { id: 'c3', now: T0 + 41 * MIN, answer: 'Reject: no' })
  expect(reviewRecent(done, T0 + 45 * MIN)?.id).toBe('c3')
  expect(reviewRecent(done, T0 + 52 * MIN)).toBeNull()
  expect(reviewRecent([], T0)).toBeNull()
})

test('a running consult\'s text carries the clock and what it is about', () => {
  const c = consults()[2] as Consult
  expect(consultingText(c, T0 + 40 * MIN + 72_000)).toBe('consulting · 1:12 · T3 audit')
  expect(consultingText({ ...c, description: '', stepId: 'T3' }, T0 + 40 * MIN)).toBe('consulting · 0:00 · T3')
  expect(consultingText({ ...c, description: '', stepId: null }, T0 + 40 * MIN)).toBe('consulting · 0:00')
})
