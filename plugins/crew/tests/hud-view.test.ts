import { expect, test } from 'claude-code/testing'
import { bandRows, type AgentRecord, type PlanDisplay, type PlanProjection, type Snapshot } from '../hooks/hud/view'
import { parsePlan } from '../hooks/hud/plan'

const now = Date.parse('2026-10-12T12:00:00Z')
// A snapshot with nothing in it; a test names only what it exercises, so a new field never touches the others.
const band = (changes: Partial<Snapshot> = {}) => bandRows({ plans: [], agents: [], now, columns: 60, ...changes })
const text = (rows: ReturnType<typeof bandRows>) => rows.rows.map(row => row.map(s => s.text).join('')).join('\n')
const plan: PlanProjection = {
  name: 'crew-hud', groups: [{ heading: 'PR 1 - HUD band', done: 2, running: 2, left: 3,
    runningSteps: [{ id: 'T3', owner: 'crew:developer' }, { id: 'T4', owner: 'crew:developer' }], unknownStates: false }],
}
const agent = (changes: Partial<AgentRecord> = {}): AgentRecord => ({ id: 'a', type: 'crew:developer', model: 'sonnet',
  effort: 'medium', startedAt: now - 187_000, status: 'running', ...changes })

test('band collapses idle sections, but represents loading and parse errors', () => {
  expect(band().rows).toEqual([])
  expect(text(band({ plans: [{ state: 'loading' }, { state: 'unknown' }] }))).toBe('Plan loading\nPlan unknown')
  expect(text(band({ agents: [agent({ status: 'ended' })] }))).toBe('')
})

test('width-sensitive rows include every running step and agent without truncation', () => {
  const many = { ...plan, groups: [{ ...plan.groups[0]!, runningSteps: Array.from({ length: 40 }, (_, i) =>
    ({ id: `T${i}`, owner: 'crew:developer' })) }] }
  for (const width of [40, 60, 84, 120]) {
    const rows = band({ plans: [many], columns: width, agents: Array.from({ length: 20 }, (_, i) =>
      agent({ id: `${i}`, type: 'crew:developer-codex', model: 'cx/gpt-6-sol-medium' })) })
    const output = text(rows)
    for (let i = 0; i < 40; i++) expect(output).toContain(`T${i} crew:developer`)
    expect(output).not.toContain('more')
    expect(rows.rows.every(row => row.map(s => s.text).join('').length <= width)).toBe(true)
    expect(output.split('crew:developer-codex').length - 1).toBe(20)
  }
  expect(text(band({ plans: [plan], columns: 120 }))).toContain('  |  T3 crew:developer  T4 crew:developer')
  expect(text(band({ plans: [plan] }))).toContain('\n    T3 crew:developer')
})

test('agent model and elapsed are observed only with evidence; timestamps cross one hour', () => {
  const output = text(band({ columns: 120, agents: [agent({ startedAt: now - 3_599_000 }), agent({ id: 'b',
    observedModel: 'claude-opus-4-1-20260205', startedAt: now - 3_600_000 }),
    agent({ id: 'c', model: undefined, effort: undefined, startedAt: undefined, seenAt: now - 4_000 }),
    agent({ id: 'd', startedAt: now + 100_000 })] }))
  expect(output).toContain('59:59')
  expect(output).toContain('1:00:00')
  expect(output).toContain('requested sonnet  observed claude-opus-4-1-20260205')
  expect(output).toContain('requested unknown  effort unknown  seen 0:04')
  expect(output).toContain('0:00')
})

test('parser owner lead survives the view while unknown owners remain hidden', () => {
  const parsed = parsePlan('hud.md', '## Steps\n### Delivery\n- T9 (lead, after: —) commit — state: implementing\n- T10 (untrusted, after: —) commit — state: implementing', { home: '', root: '' })
  const output = text(band({ plans: [parsed] }))
  expect(output).toContain('T9 lead')
  expect(output).toContain('T10 ?')
})

test('untrusted projection and models never reach display', () => {
  const malicious = { ...plan, name: '/Users/private/token', groups: [{ ...plan.groups[0]!, heading: 'https://host/secret',
    runningSteps: [{ id: 'evil\u001b', owner: 'crew:unknown' }] }] }
  const output = text(band({ plans: [malicious], columns: 120, agents: [agent({ model: 'sk-secret', observedModel: 'https://bad', effort: 'high\u001b' })] }))
  for (const secret of ['/Users/', 'https:', 'sk-secret', '\u001b']) expect(output).not.toContain(secret)
  expect(output).toContain('Plan ?')
  expect(output).toContain('requested ?  observed ?  effort unknown')
})

// Characterization: the whole rows (style and text) for a mixed snapshot, pinned across widths. A refactor of
// the view must leave every line below as it is.
const mixedPlans: PlanDisplay[] = [
  { state: 'loading' },
  { name: 'crew-hud', groups: [
    { heading: 'PR 1 - HUD band', done: 2, running: 2, left: 3, unknownStates: false,
      runningSteps: [{ id: 'T3', owner: 'crew:developer' }, { id: 'T4', owner: 'lead' }] },
    { heading: 'PR 2 - a rather long deliverable heading that must wrap at narrow widths', done: -1, running: 1.5, left: 4, unknownStates: true,
      runningSteps: [{ id: 'evil\u001b', owner: 'crew:unknown' }, { id: 'C5a', owner: 'crew:architect' }] },
    { heading: 'quiet', done: 1, running: 0, left: 0, unknownStates: false, runningSteps: [] },
  ] },
  { name: '/Users/x/token', groups: [{ heading: 'https://h/s', done: 0, running: 0, left: 1, unknownStates: false, runningSteps: [] }] },
  { state: 'unknown' },
]
const mixedAgents: AgentRecord[] = [
  agent({ id: 'z', startedAt: now - 5_000 }),
  agent({ id: 'b', type: 'crew:developer-codex', model: 'cx/gpt-6-sol-medium', observedModel: 'cx/gpt-6-sol-medium', effort: 'high', startedAt: now - 3_700_000 }),
  agent({ id: 'c', model: undefined, effort: undefined, startedAt: undefined, seenAt: now - 4_000 }),
  agent({ id: 'd', startedAt: now - 5_000, observedModel: 'claude-opus-4-1-20260205' }),
  agent({ id: 'e', status: 'ended' }),
  agent({ id: 'f', type: 'general-purpose' }),
  agent({ id: 'g', type: 'crew:nope', model: 'sk-secret', effort: 'high\u001b' }),
  agent({ id: 'h', startedAt: Number.NaN }),
]
const lines = (rows: ReturnType<typeof bandRows>) => rows.rows.map(row => row.map(s => `${s.style}|${s.text}`).join(''))

const GOLDEN: Record<string, readonly string[]> = {
  'mixed@10': [
    'heading|Plan',
    'heading|loading',
    'heading|Plan',
    'heading|crew-hud',
    'plain|  PR 1 -',
    'plain|HUD band',
    'plain|2 done / 2',
    'plain| running /',
    'plain| 3 left',
    'warning|    T3 cre',
    'warning|  w:develo',
    'warning|  per',
    'warning|    T4',
    'warning|  lead',
    'plain|  PR 2 - a',
    'plain| rather',
    'plain|long deliv',
    'plain|erable',
    'plain|heading',
    'plain|that must',
    'plain|wrap at',
    'plain|narrow',
    'plain|widths  0',
    'plain|done / 0',
    'plain|running /',
    'plain|4 left ?',
    'warning|    ? ?',
    'warning|    C5a cr',
    'warning|  ew:archi',
    'warning|  tect',
    'plain|  quiet  1',
    'plain| done / 0',
    'plain|running /',
    'plain|0 left',
    'heading|Plan ?',
    'plain|  ?  0',
    'plain|done / 0',
    'plain|running /',
    'plain|1 left',
    'heading|Plan',
    'heading|unknown',
    'heading|Agents',
    'plain|  crew:dev',
    'plain|  eloper-c',
    'plain|  odex  re',
    'plain|  quested',
    'plain|  cx/gpt-6',
    'plain|  -sol-med',
    'plain|  ium',
    'plain|  observed',
    'plain|   cx/gpt-',
    'plain|  6-sol-me',
    'plain|  dium',
    'plain|  effort',
    'plain|  high',
    'plain|  1:01:40',
    'plain|  ?  reque',
    'plain|  sted ?',
    'plain|  effort',
    'plain|  unknown',
    'plain|   3:07',
    'plain|  crew:dev',
    'plain|  eloper',
    'plain|  requeste',
    'plain|  d sonnet',
    'plain|    observ',
    'plain|  ed claud',
    'plain|  e-opus-4',
    'plain|  -1-20260',
    'plain|  205',
    'plain|  effort',
    'plain|  medium',
    'plain|  0:05',
    'plain|  crew:dev',
    'plain|  eloper',
    'plain|  requeste',
    'plain|  d sonnet',
    'plain|    effort',
    'plain|   medium',
    'plain|   0:05',
    'plain|  crew:dev',
    'plain|  eloper',
    'plain|  requeste',
    'plain|  d',
    'plain|  unknown',
    'plain|   effort',
    'plain|  unknown',
    'plain|   seen',
    'plain|  0:04',
    'plain|  crew:dev',
    'plain|  eloper',
    'plain|  requeste',
    'plain|  d sonnet',
    'plain|    effort',
    'plain|   medium',
    'plain|   unknown',
  ],
  'mixed@40': [
    'heading|Plan loading',
    'heading|Plan crew-hud',
    'plain|  PR 1 - HUD band  2 done / 2 running /',
    'plain|3 left',
    'warning|    T3 crew:developer',
    'warning|    T4 lead',
    'plain|  PR 2 - a rather long deliverable',
    'plain|heading that must wrap at narrow widths',
    'plain| 0 done / 0 running / 4 left ?',
    'warning|    ? ?',
    'warning|    C5a crew:architect',
    'plain|  quiet  1 done / 0 running / 0 left',
    'heading|Plan ?',
    'plain|  ?  0 done / 0 running / 1 left',
    'heading|Plan unknown',
    'heading|Agents',
    'plain|  crew:developer-codex  requested',
    'plain|  cx/gpt-6-sol-medium  observed',
    'plain|  cx/gpt-6-sol-medium  effort high',
    'plain|  1:01:40',
    'plain|  ?  requested ?  effort unknown  3:07',
    'plain|  crew:developer  requested sonnet',
    'plain|  observed claude-opus-4-1-20260205',
    'plain|  effort medium  0:05',
    'plain|  crew:developer  requested sonnet',
    'plain|  effort medium  0:05',
    'plain|  crew:developer  requested unknown',
    'plain|  effort unknown  seen 0:04',
    'plain|  crew:developer  requested sonnet',
    'plain|  effort medium  unknown',
  ],
  'mixed@60': [
    'heading|Plan loading',
    'heading|Plan crew-hud',
    'plain|  PR 1 - HUD band  2 done / 2 running / 3 left',
    'warning|    T3 crew:developer',
    'warning|    T4 lead',
    'plain|  PR 2 - a rather long deliverable heading that must wrap at',
    'plain| narrow widths  0 done / 0 running / 4 left ?',
    'warning|    ? ?',
    'warning|    C5a crew:architect',
    'plain|  quiet  1 done / 0 running / 0 left',
    'heading|Plan ?',
    'plain|  ?  0 done / 0 running / 1 left',
    'heading|Plan unknown',
    'heading|Agents',
    'plain|  crew:developer-codex  requested cx/gpt-6-sol-medium',
    'plain|  observed cx/gpt-6-sol-medium  effort high  1:01:40',
    'plain|  ?  requested ?  effort unknown  3:07',
    'plain|  crew:developer  requested sonnet  observed',
    'plain|  claude-opus-4-1-20260205  effort medium  0:05',
    'plain|  crew:developer  requested sonnet  effort medium  0:05',
    'plain|  crew:developer  requested unknown  effort unknown  seen',
    'plain|  0:04',
    'plain|  crew:developer  requested sonnet  effort medium  unknown',
  ],
  'mixed@99': [
    'heading|Plan loading',
    'heading|Plan crew-hud',
    'plain|  PR 1 - HUD band  2 done / 2 running / 3 left',
    'warning|    T3 crew:developer',
    'warning|    T4 lead',
    'plain|  PR 2 - a rather long deliverable heading that must wrap at narrow widths  0 done / 0 running / 4',
    'plain|left ?',
    'warning|    ? ?',
    'warning|    C5a crew:architect',
    'plain|  quiet  1 done / 0 running / 0 left',
    'heading|Plan ?',
    'plain|  ?  0 done / 0 running / 1 left',
    'heading|Plan unknown',
    'heading|Agents',
    'plain|  crew:developer-codex  requested cx/gpt-6-sol-medium  observed cx/gpt-6-sol-medium  effort high',
    'plain|  1:01:40',
    'plain|  ?  requested ?  effort unknown  3:07',
    'plain|  crew:developer  requested sonnet  observed claude-opus-4-1-20260205  effort medium  0:05',
    'plain|  crew:developer  requested sonnet  effort medium  0:05',
    'plain|  crew:developer  requested unknown  effort unknown  seen 0:04',
    'plain|  crew:developer  requested sonnet  effort medium  unknown',
  ],
  'mixed@100': [
    'heading|Plan loading',
    'heading|Plan crew-hud',
    'plain|  PR 1 - HUD band  2 done / 2 running / 3 left  |  T3 crew:developer  T4 lead',
    'plain|  PR 2 - a rather long deliverable heading that must wrap at narrow widths  0 done / 0 running / 4',
    'plain|left ?',
    'warning|    ? ?',
    'warning|    C5a crew:architect',
    'plain|  quiet  1 done / 0 running / 0 left',
    'heading|Plan ?',
    'plain|  ?  0 done / 0 running / 1 left',
    'heading|Plan unknown',
    'heading|Agents',
    'plain|  crew:developer-codex  requested cx/gpt-6-sol-medium  observed cx/gpt-6-sol-medium  effort high',
    'plain|  1:01:40',
    'plain|  ?  requested ?  effort unknown  3:07',
    'plain|  crew:developer  requested sonnet  observed claude-opus-4-1-20260205  effort medium  0:05',
    'plain|  crew:developer  requested sonnet  effort medium  0:05',
    'plain|  crew:developer  requested unknown  effort unknown  seen 0:04',
    'plain|  crew:developer  requested sonnet  effort medium  unknown',
  ],
  'mixed@120': [
    'heading|Plan loading',
    'heading|Plan crew-hud',
    'plain|  PR 1 - HUD band  2 done / 2 running / 3 left  |  T3 crew:developer  T4 lead',
    'plain|  PR 2 - a rather long deliverable heading that must wrap at narrow widths  0 done / 0 running / 4 left ?',
    'warning|    ? ?',
    'warning|    C5a crew:architect',
    'plain|  quiet  1 done / 0 running / 0 left',
    'heading|Plan ?',
    'plain|  ?  0 done / 0 running / 1 left',
    'heading|Plan unknown',
    'heading|Agents',
    'plain|  crew:developer-codex  requested cx/gpt-6-sol-medium  observed cx/gpt-6-sol-medium  effort high  1:01:40',
    'plain|  ?  requested ?  effort unknown  3:07',
    'plain|  crew:developer  requested sonnet  observed claude-opus-4-1-20260205  effort medium  0:05',
    'plain|  crew:developer  requested sonnet  effort medium  0:05',
    'plain|  crew:developer  requested unknown  effort unknown  seen 0:04',
    'plain|  crew:developer  requested sonnet  effort medium  unknown',
  ],
  'mixed@NaN': [
    'heading|Plan loading',
    'heading|Plan crew-hud',
    'plain|  PR 1 - HUD band  2 done / 2 running / 3 left',
    'warning|    T3 crew:developer',
    'warning|    T4 lead',
    'plain|  PR 2 - a rather long deliverable heading that must wrap at',
    'plain| narrow widths  0 done / 0 running / 4 left ?',
    'warning|    ? ?',
    'warning|    C5a crew:architect',
    'plain|  quiet  1 done / 0 running / 0 left',
    'heading|Plan ?',
    'plain|  ?  0 done / 0 running / 1 left',
    'heading|Plan unknown',
    'heading|Agents',
    'plain|  crew:developer-codex  requested cx/gpt-6-sol-medium',
    'plain|  observed cx/gpt-6-sol-medium  effort high  1:01:40',
    'plain|  ?  requested ?  effort unknown  3:07',
    'plain|  crew:developer  requested sonnet  observed',
    'plain|  claude-opus-4-1-20260205  effort medium  0:05',
    'plain|  crew:developer  requested sonnet  effort medium  0:05',
    'plain|  crew:developer  requested unknown  effort unknown  seen',
    'plain|  0:04',
    'plain|  crew:developer  requested sonnet  effort medium  unknown',
  ],
  'plans@60': [
    'heading|Plan loading',
    'heading|Plan crew-hud',
    'plain|  PR 1 - HUD band  2 done / 2 running / 3 left',
    'warning|    T3 crew:developer',
    'warning|    T4 lead',
    'plain|  PR 2 - a rather long deliverable heading that must wrap at',
    'plain| narrow widths  0 done / 0 running / 4 left ?',
    'warning|    ? ?',
    'warning|    C5a crew:architect',
    'plain|  quiet  1 done / 0 running / 0 left',
    'heading|Plan ?',
    'plain|  ?  0 done / 0 running / 1 left',
    'heading|Plan unknown',
  ],
  'plans@120': [
    'heading|Plan loading',
    'heading|Plan crew-hud',
    'plain|  PR 1 - HUD band  2 done / 2 running / 3 left  |  T3 crew:developer  T4 lead',
    'plain|  PR 2 - a rather long deliverable heading that must wrap at narrow widths  0 done / 0 running / 4 left ?',
    'warning|    ? ?',
    'warning|    C5a crew:architect',
    'plain|  quiet  1 done / 0 running / 0 left',
    'heading|Plan ?',
    'plain|  ?  0 done / 0 running / 1 left',
    'heading|Plan unknown',
  ],
  'agents@60': [
    'heading|Agents',
    'plain|  crew:developer-codex  requested cx/gpt-6-sol-medium',
    'plain|  observed cx/gpt-6-sol-medium  effort high  1:01:40',
    'plain|  ?  requested ?  effort unknown  3:07',
    'plain|  crew:developer  requested sonnet  observed',
    'plain|  claude-opus-4-1-20260205  effort medium  0:05',
    'plain|  crew:developer  requested sonnet  effort medium  0:05',
    'plain|  crew:developer  requested unknown  effort unknown  seen',
    'plain|  0:04',
    'plain|  crew:developer  requested sonnet  effort medium  unknown',
  ],
  'agents@120': [
    'heading|Agents',
    'plain|  crew:developer-codex  requested cx/gpt-6-sol-medium  observed cx/gpt-6-sol-medium  effort high  1:01:40',
    'plain|  ?  requested ?  effort unknown  3:07',
    'plain|  crew:developer  requested sonnet  observed claude-opus-4-1-20260205  effort medium  0:05',
    'plain|  crew:developer  requested sonnet  effort medium  0:05',
    'plain|  crew:developer  requested unknown  effort unknown  seen 0:04',
    'plain|  crew:developer  requested sonnet  effort medium  unknown',
  ],
}

test('a mixed snapshot yields these exact rows, styles and wrapping at every width', () => {
  const given = { mixed: [mixedPlans, mixedAgents], plans: [mixedPlans, []], agents: [[], mixedAgents] } as const
  for (const key of Object.keys(GOLDEN)) {
    const [kind, width] = key.split('@') as [keyof typeof given, string]
    const [plans, agents] = given[kind]
    expect(lines(band({ plans, agents, columns: Number(width) }))).toEqual(GOLDEN[key]!)
  }
})

test('the view reads the snapshot and leaves it as it was', () => {
  const snapshot = { plans: mixedPlans, agents: mixedAgents, now, columns: 60 }
  const before = JSON.stringify(snapshot)
  expect(lines(bandRows(snapshot))).toEqual(GOLDEN['mixed@60']!)
  expect(JSON.stringify(snapshot)).toBe(before)
})

test('width edges: the minimum is four cells, a NaN width reads as sixty, and one row joins only when it fits', () => {
  expect(band({ plans: [plan], columns: 3 })).toEqual(band({ plans: [plan], columns: 4 }))
  expect(band({ plans: [plan], columns: 4 }).rows.every(row => row.map(s => s.text).join('').length <= 4)).toBe(true)
  expect(band({ plans: [plan], columns: Number.NaN })).toEqual(band({ plans: [plan], columns: 60 }))
  // "  <heading>  0 done / 0 running / 0 left  |  T1 lead" is the heading plus 43 cells.
  const joined = (heading: string, columns: number) => text(band({ columns,
    plans: [{ name: 'p', groups: [{ heading, done: 0, running: 0, left: 0, unknownStates: false, runningSteps: [{ id: 'T1', owner: 'lead' }] }] }] }))
  expect(joined('h'.repeat(57), 100)).toContain('  |  T1 lead')
  expect(joined('h'.repeat(58), 100)).not.toContain('|')
  expect(joined('h'.repeat(56), 99)).not.toContain('|')
})

test('a label of 120 cells shows and a longer one is replaced', () => {
  const named = (name: string) => text(band({ columns: 400, plans: [{ name, groups: [] }] }))
  expect(named('n'.repeat(120))).toBe(`Plan ${'n'.repeat(120)}`)
  expect(named('n'.repeat(121))).toBe('Plan ?')
})
