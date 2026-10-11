import { expect, test } from 'claude-code/testing'

import { classify } from '../hooks/classify'
import { isProtectedTarget, measure } from '../hooks/measure'
import type { Probe } from '../hooks/measure'
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

// A directory in the home that cannot be placed: no `HOME`, so `~/…` has no folder to run git in.
const HOME_TARGETS = ['cd ~/repo && git commit -m x', 'cd ~ && git push origin main', 'git -C ~/repo commit -m x', 'git -C ~/repo push origin main']

test('a target whose directory cannot be resolved passes without running git (fail-open)', async () => {
  const calls: string[] = []
  const unhomed = { ...probe(calls), home: async () => undefined }

  for (const command of HOME_TARGETS) {
    const risks = classify(command)

    expect(risks).toHaveLength(1)

    for (const risk of risks) {
      expect(await isProtectedTarget(unhomed, risk, '/proj')).toBe(false)
    }
  }

  expect(calls).toEqual([])

  // The same commands, with the home known, are held on main.
  for (const command of HOME_TARGETS) {
    for (const risk of classify(command)) {
      expect(await isProtectedTarget(probe(), risk, '/proj')).toBe(true)
    }
  }
})

test('a risk marked adrift or elsewhere passes without running git, with the home known or not', async () => {
  const calls: string[] = []
  const host = probe(calls)

  for (const command of ['cd "$X" && git commit -m x', 'git --git-dir /x/.git commit -m x', 'git --work-tree /x push origin main']) {
    for (const risk of classify(command)) {
      expect(await isProtectedTarget(host, risk, '/proj')).toBe(false)
    }
  }

  expect(calls).toEqual([])
})

test('measure falls back to the cwd joined with the raw directory when the home is unknown', async () => {
  const where: (string | undefined)[] = []
  const base = probe()
  const unhomed: Probe = {
    ...base,
    home: async () => undefined,
    run: async (argv, init) => {
      where.push(init.cwd)

      return base.run(argv, init)
    },
  }

  const report = await measure(unhomed, classify('cd ~/repo && git commit -m x'), '/proj')

  expect(report.summary).toBe('commit 2 files directly on main')
  expect(where.length).toBeGreaterThan(0)
  expect(new Set(where)).toEqual(new Set(['/proj/~/repo']))

  where.length = 0
  await measure({ ...unhomed, home: async () => '/home/me' }, classify('cd ~/repo && git commit -m x'), '/proj')

  expect(new Set(where)).toEqual(new Set(['/home/me/repo']))
})
