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

test('the pane draws each deliverable as a tree under a counts line, with the rail dim and each body by state', () => {
  expect(styled(pane({ plans: [plan], columns: 80 }))).toEqual([
    'heading|Plan crew-hud',
    'plain|  PR 1 - HUD  2 done / 2 running / 3 left',
    'secondary|    secondary|● T1 main  done',
    'secondary|    └─ secondary|● T2 main  done',
    'secondary|       ├─ warning|◎ T3 crew:digger  working',
    'secondary|       │  └─ secondary|○ T5 main  waits T3  <- T4',
    'secondary|       │     ├─ secondary|○ T6 main  waits T5',
    'secondary|       │     └─ error|■ T7 main  blocked',
    'secondary|       └─ warning|◎ T4 crew:digger  working',
  ])
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
  expect(text(cut).split('\n').at(-1)).toBe('  … 6 more rows')
  expect(pane({ plans: [plan], columns: 80 }, 100).rows).toHaveLength(9)
})

test('the pane lists the running crew agents after the plans, with the model and the elapsed time as observed', () => {
  const output = text(pane({ columns: 120, agents: [agent({ startedAt: now - 3_599_000 }), agent({ id: 'b',
    observedModel: 'claude-opus-4-1-20260205', startedAt: now - 3_600_000 }),
    agent({ id: 'c', model: undefined, effort: undefined, startedAt: undefined, seenAt: now - 4_000 }),
    agent({ id: 'd', startedAt: now + 100_000 }), agent({ id: 'e', status: 'ended' }), agent({ id: 'f', type: 'general-purpose' })] }))
  expect(output.split('\n')[0]).toBe('Agents')
  expect(output).toContain('59:59')
  expect(output).toContain('1:00:00')
  expect(output).toContain('requested haiku  observed claude-opus-4-1-20260205')
  expect(output).toContain('requested unknown  effort unknown  seen 0:04')
  expect(output).toContain('0:00')
  expect(output.split('\n')).toHaveLength(5)
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
  expect(text(paneRows(view))).toContain('Plan ?')
  expect(text(paneRows(view))).toContain('requested ?  observed ?  effort unknown')
  expect(text(paneRows(view))).toContain('◎ T1 ?  working')
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
  expect(named('n'.repeat(120))).toBe(`Plan ${'n'.repeat(120)}`)
  expect(named('n'.repeat(121))).toBe('Plan ?')
})
