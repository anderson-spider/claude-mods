import { expect, test } from 'claude-code/testing'
import { CREW_TYPES, SPECIALISTS } from '../hooks/agents'
import { deniedWrite } from '../hooks/guard'

const PATHS = [
  '.crew/reviews/x.md', 'tests/a.test.ts', 'src/a.ts', 'tests/../src/a.ts', '.crew/plans/p.md', '.crew/reviews/../plans/p.md',
  '/repo/.crew/reviews/x.mdx', 'docs/x.md', '.crew/x.ts', 'a/b.spec.js', '',
]

test('every crew helper and its twin is read-only: each Write/Edit path is refused, .crew/ included', () => {
  for (const { name } of SPECIALISTS) {
    for (const type of [`crew:${name}`, `crew:${name}-codex`]) {
      for (const path of PATHS) expect(deniedWrite(type, path)).toBe(`the ${name} is read-only, so its write to ${path} was not made; the main session makes changes`)
    }
  }
})

test('a non-crew type is not held', () => {
  for (const type of ['general-purpose', 'general-purpose-codex', 'acme:foo-codex', 'acme:tester']) {
    for (const path of PATHS) expect(deniedWrite(type, path)).toBeUndefined()
  }
})

test('unknown crew types, including removed roles and their twins, are denied on every path', () => {
  for (const type of [
    'crew:developer', 'crew:developer-codex', 'crew:architect', 'crew:architect-codex', 'crew:code-reader', 'crew:research', 'crew:designer',
    'crew:foo', 'crew:foo-codex', 'crew:Digger-codex', 'crew:digger-codex-codex', 'crew:-codex', 'crew:tester:digger',
  ]) {
    for (const path of PATHS) expect(deniedWrite(type, path)).toBe(`${type} is not a crew agent, so its write to ${path} was not made`)
  }
})

test('the guard knows every valid crew type: none is refused as unknown', () => {
  for (const type of CREW_TYPES) {
    for (const path of PATHS) expect(deniedWrite(type, path) ?? '').not.toContain('is not a crew agent')
  }
})

// The role is read from the name after the last colon.
test('another plugin\'s type named like a helper is held like it', () => {
  for (const type of ['acme:digger', 'acme:digger-codex', 'x:y:planner']) expect(deniedWrite(type, 'src/a.ts')).toContain('is read-only')
  for (const type of ['acme:developer', 'acme:architect-codex']) expect(deniedWrite(type, 'src/a.ts')).toBeUndefined()
})
