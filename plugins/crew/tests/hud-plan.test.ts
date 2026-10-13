import { expect, test } from 'claude-code/testing'
import { parsePlan, selectPlans } from '../hooks/hud/plan'
import { SPECIALISTS } from '../hooks/agents'

const context = { home: '/Users/jane', root: '/Users/jane/work/app' }
const step = (id: string, owner: string, state: string) => `- ${id} (${owner}, after: —) secret action — state: ${state}`
const parse = (text: string, basename = 'crew-hud.md') => parsePlan(basename, text, context)

test('each known state is counted and skipped is done; running steps retain only id and owner', () => {
  const states = ['verified', 'committed', 'skipped', 'implementing', 'queued', 'blocked']
  const plan = parse(['## Steps', '### Release', ...states.map((state, i) => step(`T${i}`, 'main', state))].join('\n'))
  expect(plan).toEqual({ name: 'crew-hud', open: true, groups: [{
    heading: 'Release', done: 3, running: 1, left: 2, unknownStates: false,
    runningSteps: [{ id: 'T3', owner: 'main' }],
  }] })
  expect(JSON.stringify(plan)).not.toContain('secret action')
})

test('only headings within Steps and steps outside fences count; repeated headings remain distinct', () => {
  const plan = parse([
    '### Ignore', step('X1', 'main', 'queued'), '## Steps', step('P1', 'main', 'queued'),
    '### Build', step('A1', 'main', 'verified'), '```md', '### hidden', step('A2', 'main', 'queued'), '```',
    '~~~', step('A3', 'main', 'queued'), '~~~', '### Build', step('B1', 'main', 'implementing'),
    '## Next', step('N1', 'main', 'queued'),
  ].join('\n'))
  expect(plan.groups).toEqual([
    { heading: 'crew-hud', done: 0, running: 0, left: 1, runningSteps: [], unknownStates: false },
    { heading: 'Build', done: 1, running: 0, left: 0, runningSteps: [], unknownStates: false },
    { heading: 'Build', done: 0, running: 1, left: 0, runningSteps: [{ id: 'B1', owner: 'main' }], unknownStates: false },
  ])
})

test('invalid lines are ignored, duplicates keep first, and the final state marker wins', () => {
  const plan = parse(['## Steps', step('T1', 'main', 'queued'), step('T1', 'main', 'verified'),
    '- bad-id (main, after: —) action — state: implementing',
    '- T2 (main, after: wrong) action — state: implementing',
    '- T3 (main, after: —) action without state',
    '- T4 (main, after: —) action — state: verified — state: implementing (retry)',
    step('T5', 'main', 'not-real'),
  ].join('\n'))
  expect(plan.groups[0]).toEqual({ heading: 'crew-hud', done: 0, running: 1, left: 2,
    runningSteps: [{ id: 'T4', owner: 'main' }], unknownStates: true })
})

test('allowlisted helper roles, twins and main retain their names; strangers and removed roles become ?', () => {
  const owners = ['main', ...SPECIALISTS.flatMap(s => [`crew:${s.name}`, `crew:${s.name}-codex`]), 'crew:stranger', 'lead', 'crew:developer', 'crew:architect']
  const plan = parse(['## Steps', ...owners.map((owner, i) => step(`T${i}`, owner, 'implementing'))].join('\n'))
  expect(plan.groups[0]!.runningSteps.map(s => s.owner)).toEqual([...owners.slice(0, -4), '?', '?', '?', '?'])
})

test('the audit and QA states of the old flow are no longer known: they count as left with a ?', () => {
  const plan = parse(['## Steps', step('T1', 'main', 'ready for QA'), step('T2', 'main', 'fixes requested')].join('\n'))
  expect(plan.groups[0]).toMatchObject({ running: 0, left: 2, unknownStates: true })
})

test('hostile file names and headings are redacted, ASCII-only and bounded', () => {
  const token = ['ghp_', 'a1b2c3d4e5f6g7h8i9j0k1l2m3n4'].join('')
  const plan = parse(`## Steps\n### /Users/jane/private ${token} \u001b[31m é ${'Z'.repeat(500)}\n${step('A1', 'main', 'blocked')}`,
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
    { basename: 'z.md', text: `## Steps\n${step('Z1', 'main', 'queued')}` },
    { basename: 'closed.md', text: `## Steps\n${step('C1', 'main', 'skipped')}` },
    { basename: 'empty.md', text: '## Steps\n### Empty' },
    { basename: 'a.md', text: `## Steps\n${step('A1', 'main', 'implementing')}` },
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
    const plan = parse(`## Steps\n### ${sample}\n${step('T1', 'main', 'blocked')}`, `${sample}.md`)
    expect(plan.name).toBe('?')
    expect(plan.groups[0]!.heading).toBe('?')
    expect(JSON.stringify(plan)).not.toContain('internal.example.test')
    expect(JSON.stringify(plan)).not.toContain('secret')
  }
})

test('nested notes and trailing spaces do not change closed or running states', () => {
  const closed = parse(`## Steps\n${step('T1', 'main', 'verified (passed tests (mock))  ')}`)
  expect(closed.groups[0]!.done).toBe(1)
  expect(closed.open).toBe(false)
  const running = parse(`## Steps\n${step('T2', 'main', 'implementing (running (mock))  ')}`)
  expect(running.groups[0]!.running).toBe(1)
  expect(running.groups[0]!.runningSteps).toEqual([{ id: 'T2', owner: 'main' }])
  expect(running.groups[0]!.unknownStates).toBe(false)
})

test('a malformed step-only plan is unknown, unlike empty or fully closed plans', () => {
  const malformed = '## Steps\n- T1 (main, after: —) action without state'
  const parsed = parse(malformed)
  expect(parsed.malformed).toBe(true)
  expect(parsed.groups).toEqual([])
  expect(parsed.open).toBe(true)
  expect(selectPlans([{ basename: 'broken.md', text: malformed }], context)).toEqual([{ state: 'unknown' }])
  expect(selectPlans([{ basename: 'empty.md', text: '## Steps' },
    { basename: 'closed.md', text: `## Steps\n${step('T1', 'main', 'skipped')}` }], context)).toEqual([])
})
