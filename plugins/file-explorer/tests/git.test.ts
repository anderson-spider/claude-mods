import { expect, test } from 'claude-code/testing'
import { codeOf, parseBranch, parseNumstat, parseStatus, rollUp, totals } from '../hooks/git'

test('the branch line names the branch, its upstream and how far ahead and behind it is', () => {
  expect(parseBranch('## main...origin/main [ahead 2, behind 3]')).toEqual({ name: 'main', upstream: 'origin/main', ahead: 2, behind: 3 })
  expect(parseBranch('## feat/x...origin/feat/x [behind 1]')).toEqual({ name: 'feat/x', upstream: 'origin/feat/x', ahead: 0, behind: 1 })
  expect(parseBranch('## main')).toEqual({ name: 'main', ahead: 0, behind: 0 })
  expect(parseBranch('## No commits yet on main')).toEqual({ name: 'main', ahead: 0, behind: 0 })
  expect(parseBranch('## HEAD (no branch)')).toEqual({ name: 'detached', ahead: 0, behind: 0 })
})

test('each status entry takes one letter, conflicts first, the work tree over the index', () => {
  expect(codeOf('?', '?')).toBe('?')
  expect(codeOf('U', 'U')).toBe('U')
  expect(codeOf('A', 'A')).toBe('U')
  expect(codeOf('A', ' ')).toBe('A')
  expect(codeOf('A', 'M')).toBe('M')
  expect(codeOf(' ', 'D')).toBe('D')
  expect(codeOf('R', ' ')).toBe('R')
  expect(codeOf('M', ' ')).toBe('M')
})

test('porcelain -z status reads paths with spaces, renames and untracked folders against the repository top', () => {
  const text = '## main...origin/main\0 M src/my file.ts\0R  new.ts\0old.ts\0?? scratch/\0D  gone.md\0'
  expect(parseStatus(text, '/repo')).toEqual({
    branch: { name: 'main', upstream: 'origin/main', ahead: 0, behind: 0 },
    files: { '/repo/src/my file.ts': 'M', '/repo/new.ts': 'R', '/repo/scratch': '?', '/repo/gone.md': 'D' },
  })
  expect(parseStatus('', '/repo').files).toEqual({})
})

test('numstat reads lines per file, skipping binaries and following renames to the new path', () => {
  const text = '3\t1\tsrc/a.ts\0-\t-\tlogo.png\0' + '2\t0\t\0old.ts\0new.ts\0'
  expect(parseNumstat(text, '/repo')).toEqual({ '/repo/src/a.ts': { added: 3, removed: 1 }, '/repo/new.ts': { added: 2, removed: 0 } })
  expect(totals(parseNumstat(text, '/repo'))).toEqual({ added: 5, removed: 1 })
})

test('folders roll up the strongest letter under them and how many files changed', () => {
  const dirs = rollUp('/repo', { '/repo/src/a.ts': 'M', '/repo/src/lib/b.ts': '?', '/repo/src/lib/c.ts': 'U', '/elsewhere/x': 'M' })
  expect(dirs).toEqual({ '/repo': { code: 'U', count: 3 }, '/repo/src': { code: 'U', count: 3 }, '/repo/src/lib': { code: 'U', count: 2 } })
})
