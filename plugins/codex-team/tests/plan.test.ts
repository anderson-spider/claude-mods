import { expect, test } from 'claude-code/testing'
import { parsePlan } from '../hooks/plan'

const plan = (steps: string) => `# Plan\n## Steps\n### Feature\n${steps}`

test('Steps headings with work become ordered deliverables and keep every cross-project dependency and note', () => {
  const parsed = parsePlan('# Plan\n### Ignored\n- ignored (main, after: —) ignore — state: queued\n## Steps\n### Empty\n### Feature\n- build-feature (dev-fix, after: —) Build — state: implementing\n### Review\n- inspect-feature (architect-fix, after: build-feature) Review — state: blocked (needs an answer)\n## Other\n- ignored (main, after: —) ignore — state: queued', 'feature')
  expect(parsed).toEqual({ id: 'feature', deliverables: [
    { id: 'T1', title: 'Feature', steps: [{ id: 'build-feature', owner: 'dev-fix', after: [], action: 'Build', state: 'implementing', note: '' }] },
    { id: 'T2', title: 'Review', steps: [{ id: 'inspect-feature', owner: 'architect-fix', after: ['build-feature'], action: 'Review', state: 'blocked', note: 'needs an answer' }] },
  ] })
})

test('unknown dependencies, duplicates, cycles, malformed steps, owners and states are validation errors', () => {
  for (const steps of [
    '- build (main, after: missing) Build — state: queued',
    '- build (main, after: —) Build — state: queued\n- build (main, after: —) Again — state: queued',
    '- build (main, after: review) Build — state: queued\n- review (architect, after: build) Review — state: queued',
    '- build (main, after: build) Build — state: queued',
    '- build (unknown, after: —) Build — state: queued',
    '- build (dev-xxxxxxxxxxxxxxxxxxxxxxx, after: —) Build — state: queued',
    '- build (main, after: —) Build — state: bogus',
    '- build (main, after: —) Build',
    '- BadId (main, after: —) Build — state: queued',
    '- build (main, after: other invalid) Build — state: queued',
  ]) expect(() => parsePlan(plan(steps))).toThrow()
  expect(() => parsePlan(plan('- build (main, after: missing) Build — state: queued'))).toThrow('unknown dependency: build -> missing')
  expect(() => parsePlan('## Steps\n- build (main, after: —) Build — state: queued')).toThrow()
  expect(() => parsePlan('## Steps\n### Empty')).toThrow('plan has no steps')
})

test('all accepted owners and states parse and fenced examples never become steps', () => {
  const owners = ['main', 'dev-fix', 'analyst', 'analyst-fix', 'architect', 'architect-fix', 'git-master']
  const states = ['queued', 'implementing', 'verified', 'blocked', 'committed', 'skipped']
  const text = owners.map((owner, i) => `- step-${i} (${owner}, after: —) Action — state: ${states[i % states.length]}`).join('\n')
  expect(parsePlan(plan('```md\n- fake (main, after: —) Example — state: queued\n```\n' + text)).deliverables[0]!.steps).toHaveLength(owners.length)
})

test('Dispatches and every other section outside Steps are ignored even when they contain step-shaped lines', () => {
  const parsed = parsePlan(`## Dispatches
### Before
- build: agent slug=fix report=/path delivery=confirmed — open
- outside-before (main, after: missing) Ignore — state: bogus
## Steps
### Feature
- build (dev-fix, after: —) Build — state: implementing
## Dispatches
### After
- build: agent slug=fix report=/path delivery=confirmed — open
- outside-after (main, after: missing) Ignore — state: bogus
## Checks
- outside-check (main, after: —) Ignore — state: queued`)
  expect(parsed.deliverables.map(group => group.title)).toEqual(['Feature'])
  expect(parsed.deliverables.flatMap(group => group.steps.map(step => step.id))).toEqual(['build'])
})

test('nested and mixed fences close only with the opening marker and enough characters', () => {
  for (const [open, inner, close] of [
    ['````md', '```', '````'], ['~~~md', '```', '~~~'], ['~~~~md', '~~~', '~~~~~'],
    ['```md', '```still-code', '```'],
  ]) {
    const text = `## Steps\n### Feature\n${open}\n${inner}\n- example (main, after: —) Example — state: verified\n${close}\n- actual (main, after: —) Actual — state: queued`
    expect(parsePlan(text).deliverables.flatMap(group => group.steps.map(step => step.id))).toEqual(['actual'])
  }
})
