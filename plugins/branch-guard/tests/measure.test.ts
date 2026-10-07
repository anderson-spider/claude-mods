import { expect, test } from 'claude-code/testing'

import { classify } from '../hooks/classify'
import { isProtectedTarget, measure } from '../hooks/measure'
import { probe } from './helpers'

const guarded = async (command: string, cwd = '/proj') => {
  const risks = classify(command)
  const each = await Promise.all(risks.map(risk => isProtectedTarget(probe(), risk, cwd)))

  return risks.length > 0 && each.some(Boolean)
}

test('only a protected branch asks, and a repo inside /tmp never does', async () => {
  expect(await guarded('git commit -m x')).toBe(true)
  expect(await guarded('git commit -n -m x')).toBe(true)
  expect(await guarded('git add -A && git commit -m x', '/empty')).toBe(true)
  expect(await guarded('git checkout main && git commit -m x', '/work')).toBe(true)
  expect(await guarded('git push')).toBe(true)
  expect(await guarded('git push origin main')).toBe(true)
  expect(await guarded('git push origin HEAD:main', '/work')).toBe(true)
  expect(await guarded('git push origin :main', '/work')).toBe(true)
  expect(await guarded('git push --all', '/work')).toBe(true)
  expect(await guarded('git push origin "$BRANCH"', '/work')).toBe(true)
  expect(await guarded('git push origin release/2.0', '/work')).toBe(true)
  expect(await guarded('git push')).toBe(true)

  expect(await guarded('git commit -m x', '/work')).toBe(false)
  expect(await guarded('git commit -m x', '/detached')).toBe(false)
  expect(await guarded('git commit -m x', '/empty')).toBe(false)
  expect(await guarded('git commit --allow-empty -m x', '/empty')).toBe(true)
  expect(await guarded('git checkout -b andersonsilva/x && git commit -m x')).toBe(false)
  expect(await guarded('git switch - && git commit -m x')).toBe(false)
  expect(await guarded('cd "$X" && git commit -m x')).toBe(false)
  expect(await guarded('git --git-dir /x/.git commit -m x')).toBe(false)
  expect(await guarded('git push origin andersonsilva/x', '/work')).toBe(false)
  expect(await guarded('git push origin feature:andersonsilva/x', '/work')).toBe(false)
  expect(await guarded('cd /tmp/repo && git commit -m x')).toBe(false)
  expect(await guarded('git -C /tmp/repo push origin main')).toBe(false)
})

test('measure reports what the commit or the push would do, from git itself', async () => {
  const calls: string[] = []
  const report = (command: string, cwd = '/proj') => measure(probe(calls), classify(command), cwd)

  expect(await report('git commit -m x')).toEqual({
    title: 'git commit',
    notes: ['2 files changed, 3 insertions(+)'],
    summary: 'commit 2 files directly on main',
    lines: ['src/a.ts', 'src/b.ts'],
    total: 2,
  })
  expect(calls).toContain('git diff --cached --name-only')

  expect((await report('git commit -am x')).summary).toBe('commit 2 files directly on main')
  expect(calls.at(-1)).toBe('git status --porcelain')
  expect((await report('git add -A && git commit -m x')).lines).toEqual([' M src/a.ts', ' M src/b.ts', '?? notes.txt'])
  expect((await report('git commit --amend --no-edit')).summary).toBe('rewrite the last commit on main with 2 more files')

  calls.length = 0
  expect((await report('git push origin main')).summary).toBe('push 2 commits to origin/main')
  expect(calls.at(-1)).toBe('git log --oneline origin/main..main')
  expect((await report('git push')).summary).toBe('push 2 commits to origin/main')
  expect((await report('git push origin HEAD:main', '/work')).summary).toBe('push 2 commits to origin/main')
  expect(calls.at(-1)).toBe('git log --oneline origin/main..HEAD')
  expect(await report('git push origin :main', '/work')).toMatchObject({ summary: 'push nothing new to origin/main (compared without fetch)', lines: ['origin/main: will be deleted'] })
  expect((await report('git push --all')).summary).toBe('push all local branches to the remote (--all/--mirror)')
  expect((await report('git commit -m x && git push origin main')).title).toBe('git commit + git push')
})
