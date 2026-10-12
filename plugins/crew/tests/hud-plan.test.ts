import { expect, test } from 'claude-code/testing'
import {
  choosePlan,
  isPlanPath,
  kindOf,
  overflowText,
  parsePlan,
  pinMatches,
  planChanges,
  planNameOf,
  planProblem,
  planView,
  skippedNote,
  verificationGap,
  waitingOnYou,
  waveFooter,
  type ParsedPlan,
  type PlanCandidate,
  type PlanView,
} from '../hooks/hud/plan'
import { agentCompleted, agentSpawned, agentStepped, askOpened, consultStarted, defaultSession, turnStarted } from '../hooks/hud/state'
import type { AgentCard, Consult, Session } from '../hooks/hud/types'
import { cellWidth } from '../hooks/hud/width'
import { CREW_HARNESS, PROXY_REWRITE } from './hud-fixtures'

const NOW = Date.parse('2026-10-12T12:00:00Z')
const step = (id: string, state: string, after = '—', owner = 'crew:developer', text = `do ${id}`, note = '') =>
  `- ${id} (${owner}, after: ${after}) ${text} — state: ${state}${note ? ` (${note})` : ''}`

const view = (plan: ParsedPlan, agents: AgentCard[] = [], now = NOW): PlanView => planView(plan, 'p', { agents, now })

// ------------------------------------------------------------------ parser on the real plans

test('proxy-rewrite: every step line parses, T3b included', () => {
  const plan = parsePlan(PROXY_REWRITE)
  expect(plan.steps.map(s => s.id)).toEqual(['T0', 'T1', 'T2', 'T3', 'T4', 'T5', 'T3b', 'R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'J1', 'R7', 'A1'])
  expect(plan.skipped).toBe(0)
  const by = (id: string) => plan.steps.find(s => s.id === id)
  expect(by('T0')).toMatchObject({ owner: 'lead', after: [], state: 'committed', note: '0d98253' })
  expect(by('T1')).toMatchObject({ owner: 'crew:developer', after: [], state: 'committed', note: 'b125c1a' })
  expect(by('T3b')).toMatchObject({ owner: 'crew:developer', after: ['T5'], state: 'committed', note: '8fbf796' })
  expect(by('R1')).toMatchObject({ after: ['T3b'], state: 'implementing', note: '' })
  expect(by('T4')).toMatchObject({ owner: 'crew:tester', after: ['T3'], state: 'verified', note: 'all pass; gaps listed for T5' })
  expect(by('T5')).toMatchObject({ owner: 'crew:architect', state: 'committed', note: expect.stringContaining('108d9fb, with T3 and CI; review') })
  expect(by('R4')?.after).toEqual(['R1', 'R2', 'T3b'])
  expect(by('R1')?.after).toEqual(['T3b'])
  expect(by('A1')).toMatchObject({ after: ['R7'], state: 'queued', note: '' })
  expect(by('J1')?.after).toEqual(['R6'])
})

test('proxy-rewrite: the note ends at its closing parenthesis and the text after it is ignored', () => {
  const plan = parsePlan(PROXY_REWRITE)
  // T2: `committed (742f80e). Audit notes carried forward: …` with parentheses further on
  const t2 = plan.steps.find(s => s.id === 'T2')
  expect(t2?.state).toBe('committed')
  expect(t2?.note).toBe('742f80e')
  // R2: a note with `;`, `:` and an em dash inside
  const r2 = plan.steps.find(s => s.id === 'R2')
  expect(r2?.state).toBe('committed')
  expect(r2?.note.startsWith('7e01256; follow-up for R7')).toBe(true)
  expect(r2?.note).toContain(' — .crew/reviews/proxy-rewrite-r2.md finding 1')
})

test('proxy-rewrite: a long step text keeps its backticked paths and stops before ` — state:`', () => {
  const t3 = parsePlan(PROXY_REWRITE).steps.find(s => s.id === 'T3')
  expect(t3?.text.startsWith('contract suite `proxy/contract/` (tag `contract`)')).toBe(true)
  expect(t3?.text.endsWith('running `vet`/`test -race -tags contract`')).toBe(true)
  expect(t3?.state).toBe('ready for QA')
})

test('proxy-rewrite waves: one id list per numbered item, asides in parentheses ignored', () => {
  const { waves } = parsePlan(PROXY_REWRITE)
  expect(waves).toHaveLength(13)
  expect(waves[0]).toEqual(['T0', 'T1'])
  expect(waves[5]).toEqual(['T3b', 'R2'])
  // "R1, R3 (after T3b; separate directories, stable exported APIs)": T3b is an aside, not a member
  expect(waves[6]).toEqual(['R1', 'R3'])
  expect(waves[7]).toEqual(['R4'])
  expect(waves[12]).toEqual(['A1'])
})

test('crew-harness: steps, external dependency, waves', () => {
  const plan = parsePlan(CREW_HARNESS)
  expect(plan.steps.map(s => s.id)).toEqual(['C0', 'Q1', 'Q2', 'H1', 'H2', 'H3', 'D1', 'L1', 'L2', 'L3', 'A1', 'P1'])
  expect(plan.skipped).toBe(0)
  const by = (id: string) => plan.steps.find(s => s.id === id)
  expect(by('C0')).toMatchObject({ state: 'committed', note: 'b5985e1' })
  expect(by('Q1')).toMatchObject({ after: [], state: 'committed', note: '6c0d18a' })
  expect(by('Q2')).toMatchObject({ after: ['C0', 'Q1'], state: 'implementing' })
  expect(by('P1')).toMatchObject({ after: ['R6'], owner: 'crew:developer' })
  // R6 is the proxy plan's step: the plan does not hold it
  expect(plan.steps.some(s => s.id === 'R6')).toBe(false)
  expect(plan.waves).toHaveLength(6)
  expect(plan.waves[1]).toEqual(['Q2', 'H1'])
  expect(plan.waves[5]).toEqual(['A1'])
})

// ------------------------------------------------------------------ parser on edges

test('the state is read after the last ` — state:` even when the text holds a dash', () => {
  const plan = parsePlan('- X1 (crew:developer, after: —) split it — then test it — state: queued')
  expect(plan.steps[0]).toMatchObject({ text: 'split it — then test it', state: 'queued' })
  const tricky = parsePlan('- X1 (lead, after: —) explain what `— state: done` means — state: verified (ok)')
  expect(tricky.steps[0]).toMatchObject({ state: 'verified', note: 'ok', text: 'explain what `— state: done` means' })
})

test('ids accept an optional lowercase suffix; owners lead, crew:<role> and crew:<role>-codex', () => {
  const text = [
    step('T3b', 'queued', 'T3', 'crew:tester-codex'),
    step('R12', 'queued', 'T3b, R1', 'lead'),
    step('AB10', 'queued', '—', 'crew:code-reader-codex'),
  ].join('\n')
  const plan = parsePlan(text)
  expect(plan.steps.map(s => [s.id, s.owner, s.after])).toEqual([
    ['T3b', 'crew:tester-codex', ['T3']],
    ['R12', 'lead', ['T3b', 'R1']],
    ['AB10', 'crew:code-reader-codex', []],
  ])
})

test('no dependency can be written —, -, none or left out; ids come split by commas or spaces', () => {
  const lines = [
    '- A1 (lead, after: —) a — state: queued',
    '- A2 (lead, after: -) a — state: queued',
    '- A3 (lead, after: none) a — state: queued',
    '- A4 (lead) a — state: queued',
    '- A5 (lead, after: A1,A2  A3) a — state: queued',
    '- A6 (lead, after: A1, junk, a2) a — state: queued',
  ]
  const plan = parsePlan(lines.join('\n'))
  expect(plan.steps.map(s => s.after)).toEqual([[], [], [], [], ['A1', 'A2', 'A3'], ['A1']])
})

test('states are case-insensitive and all seven are read', () => {
  const states = ['queued', 'Implementing', 'READY FOR QA', 'fixes requested', 'verified', 'Blocked', 'committed']
  const plan = parsePlan(states.map((s, i) => `- S${i} (lead, after: —) x — state: ${s}`).join('\n'))
  expect(plan.steps.map(s => s.state)).toEqual(['queued', 'implementing', 'ready for QA', 'fixes requested', 'verified', 'blocked', 'committed'])
})

test('notes: none, nested parentheses, and an unbalanced one that runs to the end', () => {
  const plan = parsePlan(
    [
      '- N1 (lead, after: —) a — state: queued',
      '- N2 (lead, after: —) a — state: blocked (needs Go (1.27) on CI) and more text',
      '- N3 (lead, after: —) a — state: blocked (needs a thing',
      '- N4 (lead, after: —) a — state: queued trailing words, no note',
    ].join('\n'),
  )
  expect(plan.steps.map(s => s.note)).toEqual(['', 'needs Go (1.27) on CI', 'needs a thing', ''])
})

test('a bad line is skipped and counted, never an error', () => {
  const text = [
    '- B1 (lead, after: —) fine — state: queued',
    '- B2 (lead, after: —) no state marker at all',
    '- B3 (lead, after: —) unknown state — state: wip',
    '- B4 (somebody, after: —) bad owner — state: queued',
    '- B1 (lead, after: —) duplicate id — state: queued',
    '- B5 (lead, after: —) fine too — state: queued',
    '- not a step line',
    '- B6 without parenthesis — state: queued',
    '* B7 (lead, after: —) star bullet — state: queued',
  ].join('\n')
  const plan = parsePlan(text)
  expect(plan.steps.map(s => s.id)).toEqual(['B1', 'B5', 'B7'])
  expect(plan.skipped).toBe(4)
})

test('lines in code fences are ignored; indented bullets still count', () => {
  const text = ['```', '- F1 (lead, after: —) in a fence — state: queued', '```', '  - F2 (lead, after: —) indented — state: queued'].join('\n')
  expect(parsePlan(text).steps.map(s => s.id)).toEqual(['F2'])
})

test('parsePlan never throws on odd input', () => {
  for (const text of ['', '\n\n', '## Waves', '## Waves\n1.', '- (', '- T1 (', '—'.repeat(5000), 'x'.repeat(100_000), '- T1 (lead, after: —) ' + ' — state: '.repeat(2000), '\u0000￿']) {
    expect(parsePlan(text).steps.length).toBeGreaterThanOrEqual(0)
  }
  expect(parsePlan('')).toEqual({ steps: [], waves: [], skipped: 0 })
})

test('waves: a ## Waves heading with a numbered list; other lists and later headings do not count', () => {
  const text = ['## Plan', '1. not a wave', '## Waves', '1. A1, A2', '2) A3 (after A1; no overlap), A4', '- bullet is not a wave', '## Notes', '1. A9'].join('\n')
  expect(parsePlan(text).waves).toEqual([['A1', 'A2'], ['A3', 'A4']])
  expect(parsePlan('## Waves (run order)\n1. B1').waves).toEqual([['B1']])
  expect(parsePlan('no waves here').waves).toEqual([])
})

// ------------------------------------------------------------------ names and paths

test('plan names, paths and pins', () => {
  expect(planNameOf('/repo/.crew/plans/proxy-rewrite.md')).toBe('proxy-rewrite')
  expect(planNameOf('proxy-rewrite.md')).toBe('proxy-rewrite')
  expect(isPlanPath('/repo/.crew/plans/x.md')).toBe(true)
  expect(isPlanPath('.crew/plans/x.md')).toBe(true)
  expect(isPlanPath('/repo/.crew/plans/sub/x.md')).toBe(false)
  expect(isPlanPath('/repo/.crew/reviews/x.md')).toBe(false)
  expect(isPlanPath('/repo/.crew/plans/x.txt')).toBe(false)
  expect(pinMatches('proxy-rewrite', '/r/.crew/plans/proxy-rewrite.md')).toBe(true)
  expect(pinMatches('proxy-rewrite.md', '/r/.crew/plans/proxy-rewrite.md')).toBe(true)
  expect(pinMatches('proxy', '/r/.crew/plans/proxy-rewrite.md')).toBe(false)
})

// ------------------------------------------------------------------ active plan

const DAY = 86_400_000
const cand = (name: string, over: Partial<PlanCandidate> = {}): PlanCandidate => ({
  path: `/r/.crew/plans/${name}.md`,
  mtimeMs: NOW - DAY,
  text: step('A1', 'queued'),
  pinned: false,
  writtenAt: null,
  ...over,
})
const finished = step('A1', 'committed', '—', 'crew:developer', 'x', 'abc')

test('a pin wins over everything', () => {
  const pick = choosePlan([cand('a', { writtenAt: NOW }), cand('b', { pinned: true, mtimeMs: NOW - 30 * DAY, text: finished }), cand('c')], NOW)
  expect(pick).toEqual({ path: '/r/.crew/plans/b.md', why: 'pin' })
})

test('without a pin, the plan the session wrote last wins, even a finished or old one', () => {
  const pick = choosePlan(
    [cand('a', { writtenAt: NOW - 5000 }), cand('b', { writtenAt: NOW - 1000, text: finished, mtimeMs: NOW - 40 * DAY }), cand('c', { mtimeMs: NOW })],
    NOW,
  )
  expect(pick).toEqual({ path: '/r/.crew/plans/b.md', why: 'written' })
})

test('without either, the newest plan changed in the last 7 days that has an unfinished step', () => {
  const pick = choosePlan(
    [
      cand('old', { mtimeMs: NOW - 8 * DAY }), // too old
      cand('done', { mtimeMs: NOW - 10, text: finished }), // newest but finished
      cand('mid', { mtimeMs: NOW - 2 * DAY }),
      cand('new', { mtimeMs: NOW - DAY }),
      cand('empty', { mtimeMs: NOW - 5, text: 'no steps in the expected form' }),
    ],
    NOW,
  )
  expect(pick).toEqual({ path: '/r/.crew/plans/new.md', why: 'recent' })
})

test('no candidates, or none qualifying, gives none; ties break on the path', () => {
  expect(choosePlan([], NOW)).toBeNull()
  expect(choosePlan([cand('old', { mtimeMs: NOW - 9 * DAY }), cand('done', { text: finished })], NOW)).toBeNull()
  expect(choosePlan([cand('b'), cand('a')], NOW)?.path).toBe('/r/.crew/plans/a.md')
  expect(choosePlan([cand('b', { writtenAt: NOW }), cand('a', { writtenAt: NOW })], NOW)?.path).toBe('/r/.crew/plans/a.md')
})

test('a pin naming no candidate is ignored by the choice (no candidate is pinned)', () => {
  expect(choosePlan([cand('a')], NOW)).toEqual({ path: '/r/.crew/plans/a.md', why: 'recent' })
})

// ------------------------------------------------------------------ buckets

test('kindOf: done, now, blocked, next and waits, with an external id counting as not done', () => {
  const plan = parsePlan(
    [
      step('A1', 'committed', '—', 'lead', 'a', 'sha'),
      step('A2', 'verified'),
      step('A3', 'implementing'),
      step('A4', 'ready for QA'),
      step('A5', 'fixes requested'),
      step('A6', 'blocked'),
      step('A7', 'queued', 'A1, A2'),
      step('A8', 'queued', 'A1, A3'),
      step('A9', 'queued', 'X9'),
      step('B1', 'queued'),
    ].join('\n'),
  )
  const byId = new Map(plan.steps.map(s => [s.id, s]))
  const k = (id: string) => kindOf(byId.get(id) as never, byId)
  expect(k('A1')).toEqual({ kind: 'done', bucket: 'done' })
  expect(k('A2')).toEqual({ kind: 'done', bucket: 'done' })
  expect(k('A3')).toEqual({ kind: 'implementing', bucket: 'now' })
  expect(k('A4')).toEqual({ kind: 'qa', bucket: 'now' })
  expect(k('A5')).toEqual({ kind: 'fixes', bucket: 'now' })
  expect(k('A6')).toEqual({ kind: 'blocked', bucket: 'blocked' })
  expect(k('A7')).toEqual({ kind: 'next', bucket: 'next' })
  expect(k('A8')).toEqual({ kind: 'waits', bucket: 'waits' })
  expect(k('A9')).toEqual({ kind: 'waits', bucket: 'waits' })
  expect(k('B1')).toEqual({ kind: 'next', bucket: 'next' })
})

test('planView on proxy-rewrite: progress, current and next wave, groups', () => {
  const v = view(parsePlan(PROXY_REWRITE))
  expect(v.total).toBe(16)
  expect(v.done).toBe(7) // T0 T1 T2 T4 T5 T3b R2; T3 waits for QA
  expect(v.committed).toBe(6) // T4 is verified, not committed
  expect(v.allDone).toBe(false)
  expect(v.waveCount).toBe(13)
  expect(v.waveNo).toBe(3)
  expect(v.thisWave).toEqual(['T3'])
  expect(v.nextWave).toEqual(['R1', 'R3']) // waves 4 to 6 hold only finished steps
  expect(v.now.rows.map(r => [r.step.id, r.kind, r.right])).toEqual([
    ['T3', 'qa', { kind: 'qa', text: 'QA' }],
    ['R1', 'implementing', { kind: 'none', text: '' }],
    ['R3', 'implementing', { kind: 'none', text: '' }],
  ])
  expect(v.now.more).toBe(0)
  expect(v.next.rows).toEqual([])
  expect(v.blocked.rows).toEqual([])
  expect(v.waits.rows.map(r => [r.step.id, r.right.text])).toEqual([['R4', 'on R1'], ['R5', 'on R3 R4']])
  expect(v.waits.more).toBe(4)
  expect(v.waits.moreIds).toEqual(['R6', 'J1', 'R7', 'A1'])
  expect(v.lists.qa.map(s => s.id)).toEqual(['T3'])
  expect(v.lists.waits).toHaveLength(6)
  expect(v.strip.map(c => c.glyph).join('')).toBe('▰▰▰◇▰▰▰▶▰▶······')
  expect(v.skipped).toBe(0)
})

test('planView on crew-harness: external dependency waits, ready and implementing groups', () => {
  const v = view(parsePlan(CREW_HARNESS))
  expect(v.done).toBe(2)
  expect(v.waveNo).toBe(2)
  expect(v.thisWave).toEqual(['Q2', 'H1'])
  expect(v.nextWave).toEqual(['H2', 'L2'])
  expect(v.now.rows.map(r => r.step.id)).toEqual(['Q2', 'H1'])
  expect(v.now.rows[0]?.right).toEqual({ kind: 'none', text: '' })
  // H2 waits on H1; L2 waits on Q2; P1 waits on R6, which the plan does not hold
  const p1 = v.lists.waits.find(s => s.id === 'P1')
  expect(p1).toBeDefined()
  const waits = planView(parsePlan(CREW_HARNESS), 'p', { agents: [], now: NOW }).waits
  expect(waits.rows.length + waits.more).toBe(v.lists.waits.length)
})

test('now rows are ordered fixes, then QA, then implementing, capped at 3 with the rest counted', () => {
  const plan = parsePlan(
    [
      step('A1', 'implementing'),
      step('A2', 'ready for QA'),
      step('A3', 'implementing'),
      step('A4', 'fixes requested'),
      step('A5', 'ready for QA'),
    ].join('\n'),
  )
  const v = view(plan)
  expect(v.now.rows.map(r => r.step.id)).toEqual(['A4', 'A2', 'A5'])
  expect(v.now.more).toBe(2)
  expect(v.now.moreIds).toEqual(['A1', 'A3'])
  expect(v.now.rows.map(r => r.right.text)).toEqual(['fixes', 'QA', 'QA'])
})

test('blocked and next and waits are capped at 2 each; blocked rows show the note as the label', () => {
  const lines: string[] = []
  for (const id of ['B1', 'B2', 'B3']) lines.push(step(id, 'blocked', '—', 'crew:developer', `rewrite ${id}`, `needs Go 1.27 on CI for ${id}`))
  for (const id of ['N1', 'N2', 'N3']) lines.push(step(id, 'queued'))
  for (const id of ['W1', 'W2', 'W3']) lines.push(step(id, 'queued', 'B1'))
  const v = view(parsePlan(lines.join('\n')))
  expect(v.blocked.rows.map(r => r.step.id)).toEqual(['B1', 'B2'])
  expect(v.blocked.more).toBe(1)
  expect(v.blocked.rows[0]?.label).toBe('needs Go 1.27 on CI for B1')
  expect(v.blocked.rows[0]?.right).toEqual({ kind: 'blocked', text: 'blocked' })
  expect(v.next.rows.map(r => r.step.id)).toEqual(['N1', 'N2'])
  expect(v.next.rows[0]?.right).toEqual({ kind: 'ready', text: 'ready' })
  expect(v.next.more).toBe(1)
  expect(v.waits.rows.map(r => r.step.id)).toEqual(['W1', 'W2'])
  // a dependency that is blocked shows ⊘
  expect(v.waits.rows[0]?.right.text).toBe('on ⊘B1')
})

test('the waits text: one, two, many, external', () => {
  const waitsOf = (after: string) =>
    view(parsePlan([step('A1', 'implementing'), step('A2', 'implementing'), step('A3', 'implementing'), step('W1', 'queued', after)].join('\n')))
      .waits.rows[0]?.right.text
  expect(waitsOf('A1')).toBe('on A1')
  expect(waitsOf('A1, A2')).toBe('on A1 A2')
  expect(waitsOf('A1, A2, A3')).toBe('on A1 +2')
  // two ids that do not fit in 8 cells fall back to the first and a count
  expect(waitsOf('R12, R13')).toBe('on R12 +1')
  expect(waitsOf('Z9')).toBe('on Z9')
  // a done dependency is not listed
  expect(waitsOf('A1, D9')).toBe('on A1 D9')
})

// ------------------------------------------------------------------ right column and links

const spawn = (list: AgentCard[], id: string, description: string, type = 'crew:developer', now = NOW - 192_000) =>
  agentSpawned(list, { id, type, description, now })

test('a now row shows the elapsed time of its linked running agent', () => {
  const plan = parsePlan([step('T2', 'implementing'), step('T3', 'implementing')].join('\n'))
  const agents = spawn([], 'a1', 'T2: contract injection point')
  const v = view(plan, agents)
  expect(v.now.rows.map(r => r.right)).toEqual([
    { kind: 'elapsed', text: '3:12' },
    { kind: 'none', text: '' },
  ])
})

test('a failed linked agent shows ✗ failed while the file still says implementing', () => {
  const plan = parsePlan(step('T2', 'implementing'))
  let agents = spawn([], 'a1', 'T2: x')
  agents = agentCompleted(agents, { id: 'a1', reason: 'error', now: NOW - 1000 })
  expect(view(plan, agents).now.rows[0]?.right).toEqual({ kind: 'failed', text: '✗ failed' })
  // a later running agent on the same step wins
  agents = spawn(agents, 'a2', 'T2: again', 'crew:developer', NOW - 5000)
  expect(view(plan, agents).now.rows[0]?.right).toEqual({ kind: 'elapsed', text: '0:05' })
  // a step awaiting QA keeps QA after a failed developer (the state says the work moved on)
  const qa = parsePlan(step('T2', 'ready for QA'))
  const failedOnly = agentCompleted(spawn([], 'a1', 'T2: x'), { id: 'a1', reason: 'error', now: NOW })
  expect(view(qa, failedOnly).now.rows[0]?.right).toEqual({ kind: 'qa', text: 'QA' })
  // an answer is not a failure
  const done = agentCompleted(spawn([], 'a1', 'T2: x'), { id: 'a1', reason: 'answer', now: NOW })
  expect(view(plan, done).now.rows[0]?.right).toEqual({ kind: 'none', text: '' })
})

test('rows carry the owner column and the short label', () => {
  const plan = parsePlan(
    [
      step('A1', 'implementing', '—', 'crew:developer-codex', '`hooks/hud/plan.ts` (parser; views) — more'),
      step('A2', 'implementing', '—', 'lead', 'write the docs: README and AGENTS'),
      step('A3', 'implementing', '—', 'crew:code-reader-codex', 'find it'),
    ].join('\n'),
  )
  const rows = view(plan).now.rows
  expect(rows.map(r => r.owner)).toEqual(['developer·cx', 'lead', 'reader·cx'])
  expect(rows.map(r => r.label)).toEqual(['hooks/hud/plan.ts', 'write the docs', 'find it'])
})

// ------------------------------------------------------------------ strip

test('the strip has one cell per step in file order', () => {
  const plan = parsePlan(
    [
      step('A1', 'committed', '—', 'lead', 'a', 'x'),
      step('A2', 'implementing'),
      step('A3', 'ready for QA'),
      step('A4', 'fixes requested'),
      step('A5', 'queued', 'A1'),
      step('A6', 'queued', 'A2'),
      step('A7', 'blocked'),
    ].join('\n'),
  )
  expect(view(plan).strip.map(c => c.glyph).join('')).toBe('▰▶◇↺▱·⊘')
})

test('beyond 30 steps the strip is a 30-cell gauge: verified green, in progress amber, rest planned', () => {
  const lines: string[] = []
  for (let i = 1; i <= 40; i++) lines.push(step(`S${i}`, i <= 20 ? 'verified' : i <= 24 ? 'implementing' : 'queued', i > 20 ? `S${i - 1}` : '—'))
  const v = view(parsePlan(lines.join('\n')))
  expect(v.total).toBe(40)
  expect(v.strip).toHaveLength(30)
  expect(v.strip.filter(c => c.tone === 'ok')).toHaveLength(15) // 20/40 of 30
  expect(v.strip.filter(c => c.tone === 'warn')).toHaveLength(3) // 4/40 of 30
  expect(v.strip.filter(c => c.glyph === '▱')).toHaveLength(12)
  expect(v.strip.map(c => c.glyph).join('')).toBe('▰'.repeat(18) + '▱'.repeat(12))
})

test('all steps verified: allDone, no current wave', () => {
  const plan = parsePlan([step('A1', 'verified'), step('A2', 'committed', 'A1', 'crew:developer', 'x', 'sha'), '', '## Waves', '1. A1', '2. A2'].join('\n'))
  const v = view(plan)
  expect(v.allDone).toBe(true)
  expect(v.done).toBe(2)
  expect(v.committed).toBe(1)
  expect(v.waveNo).toBeNull()
  expect(v.thisWave).toEqual([])
  expect(waveFooter(v, 52)).toBeNull()
})

// ------------------------------------------------------------------ footers and problems

test('waveFooter and overflowText fit their width', () => {
  const v = view(parsePlan(PROXY_REWRITE))
  expect(waveFooter(v, 52)).toBe('this wave: T3 · next wave: R1, R3')
  const harness = view(parsePlan(CREW_HARNESS))
  expect(waveFooter(harness, 52)).toBe('this wave: Q2, H1 · next wave: H2, L2')
  for (const w of [10, 24, 30, 40]) expect(cellWidth(waveFooter(harness, w) ?? '')).toBeLessThanOrEqual(w)
  expect(overflowText('waiting', v.waits, 52)).toBe('+4 more waiting: R6, J1, R7, A1')
  expect(overflowText('waiting', v.waits, 24).length).toBeLessThanOrEqual(24)
  expect(overflowText('waiting', v.waits, 24).endsWith('…')).toBe(true)
  expect(overflowText('waiting', v.next, 52)).toBe('')
})

test('plan problems and the skipped-line count', () => {
  expect(planProblem('proxy-rewrite', null)).toBe('Plan proxy-rewrite: the file could not be read.')
  expect(planProblem('proxy-rewrite', parsePlan('nothing'))).toBe('Plan proxy-rewrite: no steps in the expected form.')
  expect(planProblem('p', parsePlan(step('A1', 'queued')))).toBeNull()
  expect(skippedNote(0)).toBe('')
  expect(skippedNote(1)).toBe('1 line not read')
  expect(skippedNote(3)).toBe('3 lines not read')
})

test('planChanges logs a line per state change between two reads', () => {
  const before = parsePlan([step('T2', 'queued'), step('T3', 'queued', 'T2'), step('T4', 'verified')].join('\n'))
  const after = parsePlan([step('T2', 'implementing'), step('T3', 'queued', 'T2'), step('T4', 'committed'), step('T5', 'queued')].join('\n'))
  expect(planChanges(null, after, NOW)).toEqual([])
  expect(planChanges(before, after, NOW)).toEqual([
    { at: NOW, who: 'plan', kind: 'plan', text: 'T2 queued → implementing' },
    { at: NOW, who: 'plan', kind: 'plan', text: 'T4 verified → committed' },
  ])
  expect(planChanges(after, after, NOW)).toEqual([])
})

// ------------------------------------------------------------------ S2: the verification gap

const consult = (list: Consult[] = [], id = 'c1') => consultStarted(list, { id, type: 'crew:architect', description: 'T2 approach', now: NOW })

test('S2: steps awaiting QA with no tester or architect running', () => {
  const v = view(parsePlan([step('R2', 'ready for QA'), step('R3', 'implementing')].join('\n')))
  expect(verificationGap(v, [], [])).toBe('R2 awaits QA · no tester or architect running')
  // developers running do not count as verifiers
  expect(verificationGap(v, spawn([], 'd1', 'R3: x'), [])).toBe('R2 awaits QA · no tester or architect running')
  // a tester, a twin of one, an architect or a running consult clears it
  expect(verificationGap(v, spawn([], 't1', 'R2: qa', 'crew:tester'), [])).toBeNull()
  expect(verificationGap(v, spawn([], 't1', 'R2: qa', 'crew:tester-codex'), [])).toBeNull()
  expect(verificationGap(v, spawn([], 'x1', 'R2: audit', 'crew:architect'), [])).toBeNull()
  expect(verificationGap(v, [], consult())).toBeNull()
  // a tester that finished does not
  const ended = agentCompleted(spawn([], 't1', 'R2: qa', 'crew:tester'), { id: 't1', reason: 'answer', now: NOW })
  expect(verificationGap(v, ended, [])).toBe('R2 awaits QA · no tester or architect running')
  // nothing awaits QA
  expect(verificationGap(view(parsePlan(step('R3', 'implementing'))), [], [])).toBeNull()
})

test('S2 names several steps', () => {
  const lines = ['R1', 'R2', 'R3', 'R4', 'R5', 'R6'].map(id => step(id, 'ready for QA'))
  expect(verificationGap(view(parsePlan(lines.slice(0, 2).join('\n'))), [], [])).toBe('R1, R2 await QA · no tester or architect running')
  expect(verificationGap(view(parsePlan(lines.join('\n'))), [], [])).toBe('R1, R2, R3, R4, +2 await QA · no tester or architect running')
})

// ------------------------------------------------------------------ S1: Waiting on you

const idle = (): Session => defaultSession(NOW)
const waiting = (plan: string, agents: AgentCard[] = [], consults: Consult[] = [], session: Session = idle()) =>
  waitingOnYou(plan === '' ? null : view(parsePlan(plan)), session, agents, consults)

test('S1: steps ready, with the count and ids', () => {
  expect(waiting([step('T3', 'queued'), step('R1', 'queued'), step('R2', 'queued')].join('\n'))).toEqual({
    kind: 'ready',
    text: '3 steps ready: T3, R1, R2',
  })
  expect(waiting(step('T3', 'queued'))).toEqual({ kind: 'ready', text: '1 step ready: T3' })
  const many = ['A1', 'A2', 'A3', 'A4', 'A5', 'A6'].map(id => step(id, 'queued')).join('\n')
  expect(waiting(many)?.text).toBe('6 steps ready: A1, A2, A3, A4, +2')
})

test('S1: a blocked step first, with its note; then fixes; then QA', () => {
  const blocked = step('R4', 'blocked', '—', 'crew:developer', 'x', 'needs Go 1.27 on CI')
  expect(waiting([step('T3', 'queued'), blocked].join('\n'))).toEqual({ kind: 'blocked', text: 'R4 blocked: needs Go 1.27 on CI' })
  expect(waiting(step('R4', 'blocked'))?.text).toBe('R4 blocked')
  expect(waiting([step('R4', 'blocked'), step('R5', 'blocked')].join('\n'))?.text).toBe('2 steps blocked: R4, R5')
  expect(waiting([step('R3', 'fixes requested'), step('R2', 'ready for QA')].join('\n'))).toEqual({ kind: 'fixes', text: 'R3 needs fixes' })
  expect(waiting(step('R2', 'ready for QA'))).toEqual({ kind: 'qa', text: 'R2 awaits QA' })
  expect(waiting([step('R2', 'ready for QA'), step('R3', 'ready for QA')].join('\n'))?.text).toBe('2 steps await QA: R2, R3')
})

test('S1 holds only when nothing runs and the main loop is idle', () => {
  const plan = step('T3', 'queued')
  expect(waiting(plan, spawn([], 'a1', 'T3: x'))).toBeNull()
  expect(waiting(plan, [], consult())).toBeNull()
  expect(waiting(plan, [], [], turnStarted(idle(), { now: NOW }))).toBeNull()
  // an agent that ended no longer blocks it
  expect(waiting(plan, agentCompleted(spawn([], 'a1', 'T3: x'), { id: 'a1', reason: 'answer', now: NOW }))?.kind).toBe('ready')
  // no plan, or nothing for the person to move
  expect(waiting('')).toBeNull()
  expect(waiting([step('T3', 'implementing'), step('T4', 'queued', 'T3')].join('\n'))).toBeNull()
  expect(waiting(step('T3', 'verified'))).toBeNull()
})

test('S1: a pending permission ask shows even while agents run, with or without a plan', () => {
  const session = askOpened(idle(), { id: 'k1', who: 'developer', tool: 'Bash' })
  expect(waiting('', [], [], session)).toEqual({ kind: 'ask', text: 'developer asks to run Bash' })
  expect(waiting(step('T3', 'implementing'), spawn([], 'a1', 'T3: x'), [], turnStarted(session, { now: NOW }))?.kind).toBe('ask')
})

test('a step-stepped agent is not idle: agentStepped keeps the round running', () => {
  const agents = agentStepped(spawn([], 'a1', 'T3: x'), { id: 'a1', model: 'claude-sonnet-5-5', now: NOW })
  expect(waiting(step('T3', 'queued'), agents)).toBeNull()
})
