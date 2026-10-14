import { expect, test } from 'claude-code/testing'
import { brief, completedReport } from '../hooks/report'
import { COMPLETE, REVIEW } from './lifecycle'

const input = { role: 'developer' as const, slug: 'fix', repo: '/repo', cwd: '/wt/fix', task: 'Complete the requested corrections', report: '/reports/fix-developer.md' }

test('developer followup briefs recover context from the previous report and persistent worktree diff and branch log', () => {
  expect(brief(input)).not.toContain('previous report')
  const prompt = brief({ ...input, followup: true })
  expect(prompt).toContain('read your previous report at /reports/fix-developer.md, inspect the git diff in your worktree and read the branch git log before continuing.')
  expect(prompt).toContain(input.task)
  expect(prompt).toContain('Your working directory: /wt/fix.')
  for (const role of ['analyst', 'architect', 'reviewer'] as const) expect(brief({ ...input, role, followup: true })).not.toContain('previous report')
})

test('complete role reports reject duplicate missing fenced and invalid fields', () => {
  for (const role of ['developer', 'analyst', 'architect'] as const) {
    expect(completedReport(role, COMPLETE)).toBe(true)
    expect(completedReport(role, COMPLETE.replace('drafts: none', 'drafts:\n```diff\n- old\n+ new\n```'))).toBe(true)
    for (const bad of [COMPLETE + '\nsummary: duplicate', COMPLETE.replace('files: none\n', ''), '```\n' + COMPLETE + '\n```', COMPLETE + '\n```', COMPLETE.replace('partial', 'blocked'), COMPLETE.replace('partial', 'complete'), COMPLETE.replace('drafts: none', 'drafts:'), COMPLETE.replace('questions: choose next step', 'questions:')]) expect(completedReport(role, bad)).toBe(false)
  }
  expect(completedReport('reviewer', REVIEW)).toBe(true)
  expect(completedReport('reviewer', REVIEW.replace('accept', 'changes_needed'))).toBe(false)
  expect(completedReport('reviewer', REVIEW.replace('low', 'medium'))).toBe(false)
  expect(completedReport('reviewer', REVIEW.replace('findings:', 'findings:\n- high file:1 fix').replace('accept', 'changes_needed'))).toBe(true)
})

test('colon-bearing lines inside a field stay its content instead of starting a field', () => {
  for (const role of ['developer', 'analyst', 'architect'] as const) {
    expect(completedReport(role, COMPLETE.replace(/^checks:.*$/m, 'checks:\ntsc: pass\nplugin test: pass'))).toBe(true)
    expect(completedReport(role, 'tsc: pass\n' + COMPLETE)).toBe(false)
  }
  expect(completedReport('reviewer', REVIEW.replace(/^checks:.*$/m, 'checks:\ntsc: pass'))).toBe(true)
  expect(completedReport('reviewer', REVIEW.replace('findings:', 'findings:\nnote: a label line').replace('accept', 'changes_needed'))).toBe(true)
})
