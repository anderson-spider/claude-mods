import { expect, test } from 'claude-code/testing'
import { deniedWrite } from '../hooks/guard'

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
