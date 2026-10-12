import { expect, test } from 'claude-code/testing'
import { parsePlan, selectPlans } from '../hooks/hud/plan'
import { SPECIALISTS } from '../hooks/agents'

const context = { home: '/Users/jane', root: '/Users/jane/work/app' }
const step = (id: string, owner: string, state: string) => `- ${id} (${owner}, after: —) secret action — state: ${state}`
const parse = (text: string, basename = 'crew-hud.md') => parsePlan(basename, text, context)

test('each known state is counted and skipped is done; running steps retain only id and owner', () => {
  const states = ['verified', 'committed', 'skipped', 'implementing', 'ready for QA', 'fixes requested', 'queued', 'blocked']
  const plan = parse(['## Steps', '### Release', ...states.map((state, i) => step(`T${i}`, 'crew:developer', state))].join('\n'))
  expect(plan).toEqual({ name: 'crew-hud', open: true, groups: [{
    heading: 'Release', done: 3, running: 3, left: 2, unknownStates: false,
    runningSteps: [3, 4, 5].map(i => ({ id: `T${i}`, owner: 'crew:developer' })),
  }] })
  expect(JSON.stringify(plan)).not.toContain('secret action')
})

test('only headings within Steps and steps outside fences count; repeated headings remain distinct', () => {
  const plan = parse([
    '### Ignore', step('X1', 'lead', 'queued'), '## Steps', step('P1', 'lead', 'queued'),
    '### Build', step('A1', 'lead', 'verified'), '```md', '### hidden', step('A2', 'lead', 'queued'), '```',
    '~~~', step('A3', 'lead', 'queued'), '~~~', '### Build', step('B1', 'lead', 'implementing'),
    '## Next', step('N1', 'lead', 'queued'),
  ].join('\n'))
  expect(plan.groups).toEqual([
    { heading: 'crew-hud', done: 0, running: 0, left: 1, runningSteps: [], unknownStates: false },
    { heading: 'Build', done: 1, running: 0, left: 0, runningSteps: [], unknownStates: false },
    { heading: 'Build', done: 0, running: 1, left: 0, runningSteps: [{ id: 'B1', owner: 'lead' }], unknownStates: false },
  ])
})

test('invalid lines are ignored, duplicates keep first, and the final state marker wins', () => {
  const plan = parse(['## Steps', step('T1', 'lead', 'queued'), step('T1', 'lead', 'verified'),
    '- bad-id (lead, after: —) action — state: implementing',
    '- T2 (lead, after: wrong) action — state: implementing',
    '- T3 (lead, after: —) action without state',
    '- T4 (lead, after: —) action — state: verified — state: fixes requested (retry)',
    step('T5', 'lead', 'not-real'),
  ].join('\n'))
  expect(plan.groups[0]).toEqual({ heading: 'crew-hud', done: 0, running: 1, left: 2,
    runningSteps: [{ id: 'T4', owner: 'lead' }], unknownStates: true })
})

test('allowlisted specialist roles, twins and lead retain their names; strangers become ?', () => {
  const owners = ['lead', ...SPECIALISTS.flatMap(s => [`crew:${s.name}`, `crew:${s.name}-codex`]), 'crew:stranger', 'developer']
  const plan = parse(['## Steps', ...owners.map((owner, i) => step(`T${i}`, owner, 'implementing'))].join('\n'))
  expect(plan.groups[0]!.runningSteps.map(s => s.owner)).toEqual([...owners.slice(0, -2), '?', '?'])
})

test('hostile file names and headings are redacted, ASCII-only and bounded', () => {
  const token = ['ghp_', 'a1b2c3d4e5f6g7h8i9j0k1l2m3n4'].join('')
  const plan = parse(`## Steps\n### /Users/jane/private ${token} \u001b[31m é ${'Z'.repeat(500)}\n${step('A1', 'lead', 'blocked')}`,
    `/Users/jane/private/${token}.md`)
  for (const value of [plan.name, plan.groups[0]!.heading]) {
    expect(value).not.toContain('/Users/jane')
    expect(value).not.toContain(token)
    expect(value.length).toBeLessThanOrEqual(120)
    expect(/^[\x20-\x7e]+$/.test(value)).toBe(true)
  }
})

test('selection orders by file name and hides fully closed and empty plans', () => {
  const files = [
    { basename: 'z.md', text: `## Steps\n${step('Z1', 'lead', 'queued')}` },
    { basename: 'closed.md', text: `## Steps\n${step('C1', 'lead', 'skipped')}` },
    { basename: 'empty.md', text: '## Steps\n### Empty' },
    { basename: 'a.md', text: `## Steps\n${step('A1', 'lead', 'implementing')}` },
  ]
  expect(selectPlans(files, context).map(p => 'state' in p ? p.state : p.name)).toEqual(['a', 'z'])
  expect(files[0]!.basename).toBe('z.md')
})

test('scheme URLs, hostnames and paths never survive in names or headings', () => {
  const samples = [
    'Deploy https://internal.example.test/private/project',
    'ssh://login:secret@internal.example.test/path?token=secret',
    'internal.example.test/private',
    'relative ./private/project',
    'path /var/private/project',
  ]
  for (const sample of samples) {
    const plan = parse(`## Steps\n### ${sample}\n${step('T1', 'lead', 'blocked')}`, `${sample}.md`)
    expect(plan.name).toBe('?')
    expect(plan.groups[0]!.heading).toBe('?')
    expect(JSON.stringify(plan)).not.toContain('internal.example.test')
    expect(JSON.stringify(plan)).not.toContain('secret')
  }
})

test('nested notes and trailing spaces do not change closed or running states', () => {
  const closed = parse(`## Steps\n${step('T1', 'lead', 'verified (passed tests (mock))  ')}`)
  expect(closed.groups[0]!.done).toBe(1)
  expect(closed.open).toBe(false)
  const running = parse(`## Steps\n${step('T2', 'lead', 'implementing (running (mock))  ')}`)
  expect(running.groups[0]!.running).toBe(1)
  expect(running.groups[0]!.runningSteps).toEqual([{ id: 'T2', owner: 'lead' }])
  expect(running.groups[0]!.unknownStates).toBe(false)
})

test('a malformed step-only plan is unknown, unlike empty or fully closed plans', () => {
  const malformed = '## Steps\n- T1 (lead, after: —) action without state'
  const parsed = parse(malformed)
  expect(parsed.malformed).toBe(true)
  expect(parsed.groups).toEqual([])
  expect(parsed.open).toBe(true)
  expect(selectPlans([{ basename: 'broken.md', text: malformed }], context)).toEqual([{ state: 'unknown' }])
  expect(selectPlans([{ basename: 'empty.md', text: '## Steps' },
    { basename: 'closed.md', text: `## Steps\n${step('T1', 'lead', 'skipped')}` }], context)).toEqual([])
})
