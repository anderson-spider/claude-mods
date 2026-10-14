import { expect, test } from 'claude-code/testing'
import type { ReportInput } from '../types'
import { REPORT_ERROR, safeDestination, saveReport, sections, validateReport } from '../hooks/report'
import { BASE, ports, contextFixture } from './host'

const input: ReportInput = { status: 'done', summary: 'Short summary.', verdict: 'NONE', body: '## Findings\nFull evidence stays here.\n```md\n## Not a section\n```\n## Checks\nMock validation passed.\n' }
test('report writes full body once and returns a small receipt with exact section slices', async () => {
  const h = ports(), run = contextFixture(), report = await saveReport(h.io, 'session', run, input)
  const content = h.files.get(report.path)!
  expect(report.path).toBe('/home/u/.claude/spider-team/reports/session/child-1-1.md')
  expect(content).toContain(input.body); expect(report.receipt).not.toContain('Full evidence stays here.')
  expect(report.receipt.length).toBeLessThan(700)
  const lines = content.split('\n')
  for (const section of sections(content)) {
    expect(lines.slice(section.offset - 1, section.offset - 1 + section.limit)[0]).toBe(`## ${section.heading}`)
    expect(report.receipt).toContain(`offset=${section.offset}, limit=${section.limit}`)
  }
  expect(sections(content).map(s => s.heading)).toEqual(['Findings', 'Checks'])
  run.report = report
  expect(await saveReport(h.io, 'session', run, input)).toEqual(report); expect(h.writes).toHaveLength(1)
  const updated = await saveReport(h.io, 'session', run, { ...input, body: '## Findings\nNew evidence.' })
  expect(updated.generation).toBe(2); expect(updated.id).not.toBe(report.id)
  expect(h.files.get(report.path)).toBe(content)
  const other = await saveReport(h.io, 'session', contextFixture({ agentId: 'child-2' }), input)
  expect(other.id).not.toBe(report.id)
})
test('report rejects invalid native identity traversal symlinks size and failed writes', async () => {
  for (const session of ['../escape', 'x/y', '', 'line\nbreak']) await expect(saveReport(ports().io, session, contextFixture(), input)).rejects.toThrow(REPORT_ERROR)
  for (const agentId of [undefined, '../escape', 'x/y']) await expect(saveReport(ports().io, 's', contextFixture({ agentId }), input)).rejects.toThrow(REPORT_ERROR)
  for (const path of ['/home/u/../outside', '/home//u/file', '/home/u/file\0']) await expect(safeDestination(ports().io, path)).rejects.toThrow(REPORT_ERROR)
  const linked = ports(); linked.faults.link = '/home/u/.claude'
  await expect(saveReport(linked.io, 's', contextFixture(), input)).rejects.toThrow(REPORT_ERROR); expect(linked.writes).toHaveLength(0)
  const dangling = ports(); dangling.faults.link = '/home/u/.claude/spider-team'; dangling.io.stat = async () => { throw new Error('dangling link') }
  await expect(saveReport(dangling.io, 's', contextFixture(), input)).rejects.toThrow(REPORT_ERROR)
  for (const patch of [{ summary: 'x\ny' }, { summary: 'a'.repeat(241) }, { summary: '' }, { body: '## A\n' + 'é'.repeat(32768) }, { body: 'plain text' }, { body: '## \nempty heading' }]) expect(() => validateReport({ ...input, ...patch }, contextFixture())).toThrow(REPORT_ERROR)
  const failed = ports(); failed.faults.write = true
  await expect(saveReport(failed.io, 's', contextFixture(), input)).rejects.toThrow(); expect(failed.files.size).toBe(0)
})
test('only completed reviewer reports approve and developer receipts verify checkout context', async () => {
  for (const patch of [{ status: 'partial' as const }, { status: 'blocked' as const }, { status: 'no-changes' as const }]) expect(() => validateReport({ ...input, ...patch, verdict: 'APPROVED' }, contextFixture({ role: 'reviewer' }))).toThrow(REPORT_ERROR)
  expect(() => validateReport({ ...input, verdict: 'APPROVED' }, contextFixture())).toThrow(REPORT_ERROR)
  for (const patch of [{ finished: true }, { status: 'blocked' as const }]) expect(() => validateReport(input, contextFixture(patch))).toThrow(REPORT_ERROR)
  expect(() => validateReport({ ...input, worktreePath: '/wt', worktreeBranch: 'feat/task' }, contextFixture())).toThrow(REPORT_ERROR)
  const h = ports(), developer = contextFixture({ role: 'developer' })
  await expect(saveReport(h.io, 's', developer, input)).rejects.toThrow(REPORT_ERROR)
  const report = await saveReport(h.io, 's', developer, { ...input, worktreePath: '/native worktree', worktreeBranch: 'feat/task' })
  expect(report.receipt).toContain(`worktree: /native worktree\nbranch: feat/task\nbase: ${BASE}`)
  const noChanges = await saveReport(ports().io, 's', contextFixture({ role: 'developer' }), { ...input, status: 'no-changes' })
  expect(noChanges).not.toHaveProperty('worktreePath')
})
