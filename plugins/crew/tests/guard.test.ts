import { expect, test } from 'claude-code/testing'
import { SPECIALISTS } from '../hooks/agents'
import { deniedWrite, laneRole } from '../hooks/guard'

test('the architect writes markdown under .crew only', () => {
  expect(deniedWrite('crew:architect', '.crew/plans/login.md')).toBeUndefined()
  expect(deniedWrite('crew:architect', '/repo/.crew/reviews/pr.md')).toBeUndefined()
  expect(deniedWrite('crew:architect', '.crew/reviews/x.md')).toBeUndefined()
  expect(deniedWrite('crew:architect', 'docs/plan.md')).toContain('.crew/')
  expect(deniedWrite('crew:architect', '.crew/app.ts')).toContain('.crew/')
  expect(deniedWrite('crew:architect', '.crew/../src/app.md')).toContain('.crew/')
})

test('known agents without a path restriction and non-crew unknown types are not held', () => {
  for (const role of ['code-reader', 'research', 'designer', 'developer']) {
    expect(deniedWrite(`crew:${role}`, 'src/app.ts')).toBeUndefined()
  }
  expect(deniedWrite('general-purpose', 'src/app.ts')).toBeUndefined()
})

test('laneRole strips the twin suffix only from a specialist\'s name', () => {
  expect(laneRole('crew:architect-codex')).toBe('architect')
  expect(laneRole('crew:architect')).toBe('architect')
  expect(laneRole('crew:tester-codex')).toBe('tester-codex')
  expect(laneRole('crew:foo-codex')).toBe('foo-codex')
  expect(laneRole('crew:architect-codex-codex')).toBe('architect-codex-codex')
  expect(laneRole('crew:-codex')).toBe('-codex')
})

const LANE_PATHS = [
  '.crew/reviews/x.md', 'tests/a.test.ts', 'src/a.ts', 'tests/../src/a.ts', '.crew/plans/p.md', '.crew/reviews/../plans/p.md',
  '/repo/.crew/reviews/x.mdx', 'docs/x.md', '.crew/x.ts', 'a/b.spec.js', '',
]

test('every crew:<role>-codex answers exactly as crew:<role> for Write/Edit paths', () => {
  for (const { name } of SPECIALISTS) {
    for (const path of LANE_PATHS) expect(deniedWrite(`crew:${name}-codex`, path)).toBe(deniedWrite(`crew:${name}`, path))
  }
  expect(deniedWrite('crew:architect-codex', '.crew/reviews/x.md')).toBeUndefined()
  expect(deniedWrite('crew:architect-codex', 'tests/a.test.ts')).toBeDefined()
  expect(deniedWrite('crew:architect-codex', 'src/a.ts')).toBeDefined()
  expect(deniedWrite('crew:developer-codex', 'tests/a.test.ts')).toBeUndefined()
})

test('unknown crew types, including removed roles and their twins, are denied on every path', () => {
  for (const type of [
    'crew:tester', 'crew:tester-codex', 'crew:tester-extra', 'crew:tester-codex-codex', 'crew:tester:developer',
    'crew:foo', 'crew:foo-codex', 'crew:Developer-codex', 'crew:developer-codex-codex', 'crew:-codex', 'crew:code-reader-Codex-codex',
  ]) {
    for (const path of LANE_PATHS) expect(deniedWrite(type, path)).toContain(type)
  }
})

test('another plugin\'s unknown types, including the removed role name, stay untouched', () => {
  for (const type of ['acme:foo-codex', 'general-purpose-codex', 'acme:tester', 'acme:tester-codex']) {
    for (const path of LANE_PATHS) expect(deniedWrite(type, path)).toBeUndefined()
  }
})

// Another plugin's type still follows a known role's lane, read from the name after the last colon.
test('acme:architect-codex follows the same rule as acme:architect', () => {
  for (const path of LANE_PATHS) {
    expect(deniedWrite('acme:architect-codex', path)).toBe(deniedWrite('acme:architect', path))
  }
  expect(deniedWrite('acme:architect-codex', 'src/a.ts')).toBeDefined()
})
