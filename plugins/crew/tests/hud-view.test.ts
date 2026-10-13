import { expect, test } from 'claude-code/testing'
import { bandRows, paneRows, type AgentRecord, type PlanDisplay, type PlanProjection, type Snapshot } from '../hooks/hud/view'
import { parsePlan } from '../hooks/hud/plan'

const now = Date.parse('2026-10-12T12:00:00Z')
// A snapshot with nothing in it; a test names only what it exercises, so a new field never touches the others.
const EMPTY: Snapshot = { plans: [], agents: [], now, columns: 60 }
const snap = (changes: Partial<Snapshot> = {}): Snapshot => ({ ...EMPTY, ...changes })
const band = (changes: Partial<Snapshot> = {}) => bandRows(snap(changes))
const pane = (changes: Partial<Snapshot> = {}, maxRows?: number) => paneRows(snap(changes), maxRows)
const text = (rows: { rows: { text: string }[][] }) => rows.rows.map(row => row.map(s => s.text).join('')).join('\n')
const styled = (rows: { rows: { text: string; style: string }[][] }) => rows.rows.map(row => row.map(s => `${s.style}|${s.text}`).join(''))
const stepOf = (id: string, state: string, after: string[] = [], owner = 'main') => ({ id, owner, after, state })
const plan: PlanProjection = {
  name: 'crew-hud', groups: [{ heading: 'PR 1 - HUD', done: 2, running: 2, left: 3, unknownStates: false, steps: [
    stepOf('T1', 'verified'), stepOf('T2', 'verified', ['T1']),
    stepOf('T3', 'implementing', ['T2'], 'crew:digger'), stepOf('T4', 'implementing', ['T2'], 'crew:digger'),
    stepOf('T5', 'queued', ['T3', 'T4']), stepOf('T6', 'queued', ['T5']), stepOf('T7', 'blocked', ['T5']),
  ] }],
}
const agent = (changes: Partial<AgentRecord> = {}): AgentRecord => ({ id: 'a', type: 'crew:digger', model: 'haiku',
  effort: 'medium', startedAt: now - 187_000, status: 'running', ...changes })

test('the band is empty when nothing is active, and says when a plan is loading or cannot be read', () => {
  expect(band().rows).toEqual([])
  expect(text(band({ plans: [{ state: 'loading' }, { state: 'unknown' }] }))).toBe('crew  plan loading  |  plan unknown')
  expect(text(band({ agents: [agent({ status: 'ended' }), agent({ type: 'general-purpose' })] }))).toBe('')
})

test('the band is one line with the totals, the running steps and the running agents', () => {
  expect(text(band({ plans: [plan], agents: [agent()], columns: 120 })))
    .toBe('crew  2 done / 2 running / 3 left  |  T3 crew:digger  T4 crew:digger  |  1 agent')
  expect(text(band({ plans: [plan, { state: 'loading' }], agents: [agent(), agent({ id: 'b' })], columns: 200 })))
    .toBe('crew  2 done / 2 running / 3 left  |  plan loading  |  T3 crew:digger  T4 crew:digger  |  2 agents')
})

test('the band wraps by width and names every running step without truncation', () => {
  const steps = Array.from({ length: 40 }, (_, i) => stepOf(`T${i}`, 'implementing', [], 'crew:digger'))
  const many: PlanProjection = { name: 'p', groups: [{ heading: 'h', done: 0, running: 40, left: 0, unknownStates: false, steps }] }
  for (const width of [20, 40, 60, 120]) {
    const rows = band({ plans: [many], columns: width })
    const output = text(rows)
    for (let i = 0; i < 40; i++) expect(output).toContain(`T${i}`)
    expect(output).not.toContain('more')
    expect(rows.rows.every(row => row.map(s => s.text).join('').length <= width)).toBe(true)
  }
})

test('the pane draws each deliverable as a tree under its counts line, with the rail dim and each body by state', () => {
  expect(styled(pane({ plans: [plan], columns: 80 }))).toEqual([
    'heading|Crew',
    'heading|Plansecondary|  crew-hud',
    'plain|PR 1 - HUDsecondary|  2 done / 2 running / 3 left',
    'secondary|  secondary|● T1 main  done',
    'secondary|  └─ secondary|● T2 main  done',
    'secondary|     ├─ warning|◎ T3 crew:digger  working',
    'secondary|     │  └─ secondary|○ T5 main  waits T3  <- T4',
    'secondary|     │     ├─ secondary|○ T6 main  waits T5',
    'secondary|     │     └─ error|■ T7 main  blocked',
    'secondary|     └─ warning|◎ T4 crew:digger  working',
    'secondary|0 agents',
  ])
})

test('a step a running agent was spawned for says so, by role', () => {
  const output = text(pane({ plans: [plan], columns: 100, agents: [agent({ planStep: 'T3' }),
    agent({ id: 'b', type: 'crew:planner-codex', planStep: 'T4' }), agent({ id: 'c', planStep: 'T3', status: 'ended' })] }))
  expect(output).toContain('◎ T3 crew:digger  working  ← digger')
  expect(output).toContain('◎ T4 crew:digger  working  ← planner-codex')
})

test('a dependency on another deliverable is read from the whole plan', () => {
  const two: PlanProjection = { name: 'p', groups: [
    { heading: 'A', done: 0, running: 1, left: 0, unknownStates: false, steps: [stepOf('A1', 'implementing')] },
    { heading: 'B', done: 0, running: 0, left: 1, unknownStates: false, steps: [stepOf('B1', 'queued', ['A1'])] },
  ] }
  expect(text(pane({ plans: [two], columns: 80 }))).toContain('○ B1 main  waits A1  <- A1')
})

test('rows are cut to the width with an ellipsis, and the viewport hides what does not fit behind one line', () => {
  const rows = pane({ plans: [plan], columns: 24 })
  expect(rows.rows.every(row => row.map(s => s.text).join('').length <= 24)).toBe(true)
  expect(text(rows)).toContain('…')
  const cut = pane({ plans: [plan], columns: 80 }, 4)
  expect(cut.rows).toHaveLength(4)
  expect(text(cut).split('\n').at(-1)).toBe('  … 8 more rows')
  expect(pane({ plans: [plan], columns: 80 }, 100).rows).toHaveLength(11)
})

test('the pane lists the running crew agents after the plans, with the model and the elapsed time as observed', () => {
  const output = text(pane({ columns: 120, agents: [agent({ startedAt: now - 3_599_000 }), agent({ id: 'b',
    observedModel: 'claude-opus-4-1-20260205', startedAt: now - 3_600_000 }),
    agent({ id: 'c', model: undefined, effort: undefined, startedAt: undefined, seenAt: now - 4_000 }),
    agent({ id: 'd', startedAt: now + 100_000 }), agent({ id: 'f', type: 'general-purpose' })] }))
  expect(output).toContain('Agents · running 4')
  expect(output).toContain('haiku · medium  59:59')
  expect(output).toContain('claude-opus-4-1-20260205 · medium  requested haiku  1:00:00')
  expect(output).toContain('unknown  seen 0:04')
  expect(output).toContain('haiku · medium  0:00')
  expect(output).not.toContain('general')
  expect(output.split('\n').at(-1)).toBe('4 agents')
})

test('a running agent shows its context, output, steps, last three calls and failures; a twin with none says so', () => {
  const busy = agent({ planStep: 'A4', inTokens: 18_400, outTokens: 1_200, steps: 6, toolCount: 9, failures: 1,
    tools: [{ name: 'Grep', failed: false }, { name: 'Read', failed: true }, { name: 'mcp', failed: false }, { name: 'Bash', failed: false }] })
  const wide = pane({ columns: 120, agents: [busy, agent({ id: 'b', type: 'crew:planner-codex', model: 'gpt-6-astra', effort: 'high' })] })
  const lines = text(wide).split('\n')
  expect(lines.find(l => l.includes('digger') && l.includes('A4'))).toMatch(/^[●○] digger {2}A4 {2}haiku · medium {2}3:07 {2}ctx 18\.4k {2}out 1\.2k {2}6 steps$/u)
  expect(lines).toContain('  └ Read · mcp · Bash  9 calls  ✗ 1')
  expect(lines.find(l => l.includes('planner'))).toMatch(/^[●○] planner·codex {2}gpt-6-astra · high {2}3:07$/u)
  expect(lines).toContain('  └ no tool events or tokens reported')
  const narrow = text(pane({ columns: 60, agents: [busy] })).split('\n')
  expect(narrow).toContain('  ctx 18.4k  out 1.2k  6 steps')
  expect(narrow.every(l => l.length <= 56 || l === 'Crew')).toBe(true)
  const none = text(pane({ columns: 120, agents: [agent()] })).split('\n')
  expect(none).toContain('  └ no calls yet')
})

test('the dot beats once a second: it is lit on even seconds and hollow on odd ones', () => {
  const lit = text(pane({ columns: 80, now: 2_000, agents: [agent({ startedAt: 0 })] }))
  const hollow = text(pane({ columns: 80, now: 3_000, agents: [agent({ startedAt: 0 })] }))
  expect(lit).toContain('● digger')
  expect(hollow).toContain('○ digger')
})

test('the recent box lists the last five ended agents, newest first, and marks max_tokens as failed', () => {
  const ended = (n: number, changes: Partial<AgentRecord> = {}) => agent({ id: `e${n}`, status: 'ended', startedAt: now - 600_000,
    endedAt: now - n * 60_000, steps: n, inTokens: 41_000, outTokens: 3_200, planStep: `A${n}`, ...changes })
  const output = text(pane({ columns: 140, agents: [ended(6), ended(5), ended(4), ended(3), ended(2), ended(1, { stop: 'max_tokens' })] })).split('\n')
  expect(output).toContain('Recent · 5')
  const rows = output.filter(l => /^[●✗] digger/u.test(l))
  expect(rows).toHaveLength(5)
  expect(rows[0]).toBe('✗ digger  A1  haiku · medium  9:00  ctx 41.0k  out 3.2k  1 step  max_tokens  1 min ago')
  expect(rows[4]).toContain('A5')
  const recent = output.slice(output.indexOf('Recent · 5'), output.indexOf('Last 15 minutes'))
  expect(recent.join('\n')).not.toContain('A6')
})

test('the timeline puts each agent that ran in the last fifteen minutes on one bar, running to the edge', () => {
  const rows = text(pane({ columns: 60, agents: [
    agent({ id: 'r', planStep: 'A4', startedAt: now - 60_000 }),
    agent({ id: 'e', type: 'crew:challenger', status: 'ended', startedAt: now - 600_000, endedAt: now - 300_000 }),
    agent({ id: 'old', status: 'ended', startedAt: now - 3_600_000, endedAt: now - 3_000_000 }),
  ] })).split('\n')
  const at = rows.indexOf('Last 15 minutes')
  expect(at).toBeGreaterThan(0)
  const bars = rows.slice(at + 1, at + 3)
  expect(bars[0]).toMatch(/^challenger {6}·+█+·+$/u)
  expect(bars[1]).toMatch(/^digger A4 {7}·+█+$/u)
  expect(rows[at + 3]).toMatch(/^ {16}-15m +-10m +-5m +now$/u)
  expect(rows.join('\n')).not.toMatch(/old/u)
})

test('parser owner main survives the view while unknown owners and states stay hidden', () => {
  const parsed = parsePlan('hud.md', '## Steps\n### Delivery\n- T9 (main, after: —) commit — state: implementing\n- T10 (untrusted, after: T9) commit — state: whatever', { home: '', root: '' })
  const output = text(pane({ plans: [parsed], columns: 120 }))
  expect(output).toContain('◎ T9 main  working')
  expect(output).toContain('? T10 ?  ?')
  expect(text(band({ plans: [parsed], columns: 120 }))).toContain('T9 main')
})

test('untrusted projection and models never reach display', () => {
  const malicious: PlanProjection = { name: '/Users/private/token', groups: [{ heading: 'https://host/secret', done: 0, running: 1, left: 0,
    unknownStates: false, steps: [stepOf('evil\u001b', 'implementing', [], 'crew:unknown'), stepOf('T1', 'implementing', ['evil\u001b', 'T0\u001b'], 'crew:unknown')] }] }
  const view = snap({ plans: [malicious], columns: 120, agents: [agent({ model: 'sk-secret', observedModel: 'https://bad', effort: 'high\u001b' })] })
  for (const output of [text(paneRows(view)), text(bandRows(view))]) {
    for (const secret of ['/Users/', 'https:', 'sk-secret', '\u001b', 'crew:unknown']) expect(output).not.toContain(secret)
  }
  expect(text(paneRows(view))).toContain('Plan  ?')
  expect(text(paneRows(view))).toMatch(/digger {2}\? {2}\d/u)
  expect(text(paneRows(view))).toContain('◎ T1 ?  working')
})

test('activity numbers and names that are not what the hooks write never reach the screen', () => {
  const hostile = agent({ steps: 1.5, inTokens: Number.NaN, outTokens: -3, toolCount: Number.POSITIVE_INFINITY, failures: Number.NaN,
    planStep: '/Users/private', tools: [{ name: 'rm -rf /Users/private', failed: false }, { name: 'mcp__srv__tool', failed: false }] })
  const output = text(pane({ columns: 120, agents: [hostile] }))
  expect(output).not.toMatch(/NaN|Infinity|private|srv|rm -rf|1\.5|-3/u)
  expect(output).toContain('└ ? · ? ')
})

test('the view reads the snapshot and leaves it as it was', () => {
  const view = snap({ plans: [plan, { state: 'loading' }] as PlanDisplay[], agents: [agent()] })
  const before = JSON.stringify(view)
  paneRows(view)
  bandRows(view)
  expect(JSON.stringify(view)).toBe(before)
})

test('width edges: the minimum is four cells and a NaN width reads as sixty', () => {
  expect(band({ plans: [plan], columns: 3 })).toEqual(band({ plans: [plan], columns: 4 }))
  expect(band({ plans: [plan], columns: 4 }).rows.every(row => row.map(s => s.text).join('').length <= 4)).toBe(true)
  expect(band({ plans: [plan], columns: Number.NaN })).toEqual(band({ plans: [plan], columns: 60 }))
  expect(pane({ plans: [plan], columns: Number.NaN })).toEqual(pane({ plans: [plan], columns: 60 }))
})

test('a label of 120 cells shows and a longer one is replaced', () => {
  const named = (name: string) => text(pane({ columns: 400, plans: [{ name, groups: [] }] }))
  expect(named('n'.repeat(120))).toContain(`Plan  ${'n'.repeat(120)}`)
  expect(named('n'.repeat(121))).toContain('Plan  ?')
})
