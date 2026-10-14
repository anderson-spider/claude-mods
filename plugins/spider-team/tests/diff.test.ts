import { expect, test } from 'claude-code/testing'
import { captureBase, DIFF_ERROR, reviewDiff, verifyCheckout } from '../hooks/diff'
import { BASE, ports, contextFixture } from './host'

const developer = () => contextFixture({ role: 'developer', finished: true, status: 'done', report: { id: 's/a/1', path: '/report', receipt: 'receipt', status: 'done', verdict: 'NONE', generation: 1, worktreePath: '/native worktree', worktreeBranch: 'feat/task' } })
test('diff verifies base repository branch and native checkout with fixed argv', async () => {
  const h = ports()
  expect(await captureBase(h.io, '/repo')).toEqual({ base: BASE, commonDir: '/repo/.git' })
  await verifyCheckout(h.io, developer(), '/native worktree', 'feat/task')
  for (const argv of h.calls) {
    expect(argv.slice(0, 7)).toEqual(['git', '--no-pager', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-C'])
    expect(argv[7]).toMatch(/^\/(repo|native worktree)$/)
  }
  for (const fault of ['process', 'truncate', 'ancestor'] as const) {
    const bad = ports(); bad.faults[fault] = true
    await expect(verifyCheckout(bad.io, developer(), '/native worktree', 'feat/task')).rejects.toThrow(DIFF_ERROR)
  }
  for (const patch of [{ top: '/missing' }, { branch: 'wrong' }, { common: '/other/.git' }]) {
    const bad = ports(); Object.assign(bad.faults, patch)
    await expect(verifyCheckout(bad.io, developer(), '/native worktree', 'feat/task')).rejects.toThrow(DIFF_ERROR)
  }
  await expect(verifyCheckout(ports().io, developer(), '/repo', 'feat/task')).rejects.toThrow(DIFF_ERROR)
  for (const patch of [{ nativePath: '/other' }, { nativeBranch: 'other' }]) await expect(verifyCheckout(ports().io, { ...developer(), ...patch }, '/native worktree', 'feat/task')).rejects.toThrow(DIFF_ERROR)
})
test('diff indexes commits staged unstaged and untracked then returns complete per-file pages', async () => {
  const h = ports(), run = developer(), index = JSON.parse(await reviewDiff(h.io, run))
  expect(index.files).toEqual(['committed.ts', 'staged.ts', 'unstaged.ts'])
  expect(index.untracked).toEqual(['new file.ts']); expect(index.partial).toBe(true)
  h.changes.unstaged.push('a file;$(echo).ts')
  const page = JSON.parse(await reviewDiff(h.io, run, 'a file;$(echo).ts'))
  expect(page).toEqual({ file: 'a file;$(echo).ts', committed: 'committed patch', staged: 'staged patch', unstaged: 'unstaged patch', partial: false })
  for (const argv of h.calls.filter(a => a.includes('diff'))) {
    expect(argv).toContain('--no-ext-diff'); expect(argv).toContain('--no-textconv'); expect(argv).toContain('--no-renames'); expect(argv).toContain('--')
  }
  expect(h.calls.at(-1)?.at(-1)).toBe('a file;$(echo).ts')
  for (const file of ['unknown.ts', '/absolute', '../escape', 'new file.ts']) await expect(reviewDiff(h.io, run, file)).rejects.toThrow(DIFF_ERROR)
  h.changes.edits = 'x'.repeat(64001)
  const partial = JSON.parse(await reviewDiff(h.io, run, 'staged.ts'))
  expect(partial.partial).toBe(true); expect(partial).not.toHaveProperty('unstaged')
  h.changes.edits = 'reverse staged patch'; h.changes.staged.push('cancelled.ts'); h.changes.unstaged.push('cancelled.ts')
  expect(JSON.parse(await reviewDiff(h.io, run)).files).toContain('cancelled.ts')
  expect(JSON.parse(await reviewDiff(h.io, run, 'cancelled.ts'))).toMatchObject({ staged: 'staged patch', unstaged: 'reverse staged patch' })
})
test('review refuses running failed partial or removed developer checkouts', async () => {
  for (const patch of [{ finished: false }, { status: 'blocked' as const }, { status: 'partial' as const }, { role: 'analyst' as const }, { report: undefined }]) await expect(reviewDiff(ports().io, { ...developer(), ...patch })).rejects.toThrow(DIFF_ERROR)
  const h = ports(); h.faults.process = true
  await expect(reviewDiff(h.io, developer())).rejects.toThrow(DIFF_ERROR)
  const run = developer(); run.report!.status = 'partial'
  await expect(reviewDiff(ports().io, run)).rejects.toThrow(DIFF_ERROR)
})
