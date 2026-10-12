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

test('the tester writes test files and reports under .crew/reviews', () => {
  for (const path of ['tests/app.test.ts', 'src/test/java/FooTest.kt', 'pkg/test_app.py', 'app/src/androidTest/Foo.kt', 'a/b.spec.js']) {
    expect(deniedWrite('crew:tester', path)).toBeUndefined()
  }
  for (const path of ['.crew/reviews/a.md', '/x/.crew/reviews/q.mdx', '/x/.crew/reviews/Q.MD', '.crew/reviews/sub/b.mdx']) {
    expect(deniedWrite('crew:tester', path)).toBeUndefined()
  }
  for (const path of ['src/app.ts', '.crew/plans/a.md', '.crew/reviews/a.ts', '.crew/reviews/../plans/a.md', '/repo/tests/../src/app.ts', '/x/test/../../etc/zshrc', 'tests/..', '.crew/reviews/']) {
    expect(deniedWrite('crew:tester', path)).toContain('.crew/reviews/')
  }
})

test('a climbing tester path says so', () => {
  expect(deniedWrite('crew:tester', '.crew/reviews/../plans/a.md')).toContain('a `..` segment')
  expect(deniedWrite('crew:tester', 'src/app.ts')).not.toContain('a `..` segment')
})

test('other agents are not held', () => {
  expect(deniedWrite('crew:developer', 'src/app.ts')).toBeUndefined()
  expect(deniedWrite('general-purpose', 'src/app.ts')).toBeUndefined()
})

test('each -codex twin gets exactly its base role\'s answer on every path', () => {
  const paths = [
    'src/app.ts', 'tests/app.test.ts', 'pkg/test_app.py', '.crew/plans/a.md', '.crew/reviews/a.md', '/repo/.crew/reviews/q.mdx', '.crew/app.ts',
    '.crew/../src/app.md', '/x/test/../../etc/zshrc', 'docs/plan.md', '',
  ]
  for (const { name } of SPECIALISTS) {
    for (const path of paths) expect(deniedWrite(`crew:${name}-codex`, path)).toBe(deniedWrite(`crew:${name}`, path))
  }
  expect(deniedWrite('crew:architect-codex', 'src/app.ts')).toContain('.crew/')
  expect(deniedWrite('crew:tester-codex', 'src/app.ts')).toContain('.crew/reviews/')
  expect(deniedWrite('crew:developer-codex', 'src/app.ts')).toBeUndefined()
})

test('laneRole strips the twin suffix only from a specialist\'s name', () => {
  expect(laneRole('crew:tester-codex')).toBe('tester')
  expect(laneRole('crew:tester')).toBe('tester')
  expect(laneRole('crew:foo-codex')).toBe('foo-codex')
  expect(laneRole('crew:tester-codex-codex')).toBe('tester-codex-codex')
  expect(laneRole('crew:-codex')).toBe('-codex')
})

test('a crew type with the suffix and no known base has no lane, so its writes are held', () => {
  for (const type of ['crew:foo-codex', 'crew:tester-codex-codex', 'crew:Tester-codex', 'crew:-codex', 'crew:architect-codex-codex']) {
    expect(deniedWrite(type, 'src/app.ts')).toContain(type)
    expect(deniedWrite(type, '.crew/plans/a.md')).toContain(type)
  }
})

test('a suffixed type of another plugin is not a crew type: it is not held', () => {
  expect(deniedWrite('acme:foo-codex', 'src/app.ts')).toBeUndefined()
  expect(deniedWrite('general-purpose-codex', 'src/app.ts')).toBeUndefined()
})

// --- The -codex lanes, across the whole path table ---

const LANE_PATHS = [
  '.crew/reviews/x.md', 'tests/a.test.ts', 'src/a.ts', 'tests/../src/a.ts', '.crew/plans/p.md', '.crew/reviews/../plans/p.md',
  '/repo/.crew/reviews/x.mdx', 'docs/x.md', '.crew/x.ts', 'a/b.spec.js', '',
]

test('every crew:<role>-codex answers exactly as crew:<role> for Write/Edit paths', () => {
  for (const { name } of SPECIALISTS) {
    for (const path of LANE_PATHS) expect(deniedWrite(`crew:${name}-codex`, path)).toBe(deniedWrite(`crew:${name}`, path))
  }
  expect(deniedWrite('crew:tester-codex', 'tests/../src/a.ts')).toBeDefined()
  expect(deniedWrite('crew:tester-codex', 'tests/a.test.ts')).toBeUndefined()
  expect(deniedWrite('crew:tester-codex', '.crew/reviews/x.md')).toBeUndefined()
  expect(deniedWrite('crew:architect-codex', '.crew/reviews/x.md')).toBeUndefined()
  expect(deniedWrite('crew:architect-codex', 'tests/a.test.ts')).toBeDefined()
  expect(deniedWrite('crew:architect-codex', 'src/a.ts')).toBeDefined()
})

test('unknown crew:*-codex types are denied on every path', () => {
  for (const type of ['crew:foo-codex', 'crew:Developer-codex', 'crew:developer-codex-codex', 'crew:-codex', 'crew:code-reader-Codex-codex']) {
    for (const path of LANE_PATHS) expect(deniedWrite(type, path)).toBeDefined()
  }
})

test('another plugin\'s -codex type with no specialist base is untouched', () => {
  for (const path of LANE_PATHS) {
    expect(deniedWrite('acme:foo-codex', path)).toBeUndefined()
    expect(deniedWrite('general-purpose-codex', path)).toBeUndefined()
  }
})

// Another plugin's type that ends in a crew role name plus -codex follows the role's lane, like the existing `acme:tester`
// (the lane is read from the name after the last colon): fail-closed on purpose, and pinned here.
test('acme:tester-codex and acme:architect-codex follow the same rule as acme:tester / acme:architect', () => {
  for (const path of LANE_PATHS) {
    expect(deniedWrite('acme:tester-codex', path)).toBe(deniedWrite('acme:tester', path))
    expect(deniedWrite('acme:architect-codex', path)).toBe(deniedWrite('acme:architect', path))
  }
  expect(deniedWrite('acme:tester-codex', 'src/a.ts')).toBeDefined()
})

