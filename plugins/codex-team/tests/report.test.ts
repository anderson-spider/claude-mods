import { expect, test } from 'claude-code/testing'
import { brief } from '../hooks/report'

const input = { role: 'developer' as const, slug: 'fix', repo: '/repo', cwd: '/wt/fix', task: 'Complete the requested corrections', report: '/reports/fix-developer.md' }

test('developer followup briefs recover context from the previous report and persistent worktree diff', () => {
  expect(brief(input)).not.toContain('previous report')
  const prompt = brief({ ...input, followup: true })
  expect(prompt).toContain('read your previous report at /reports/fix-developer.md and inspect the git diff in your worktree before continuing.')
  expect(prompt).toContain(input.task)
  expect(prompt).toContain('Your working directory: /wt/fix.')
  for (const role of ['analyst', 'architect', 'reviewer'] as const) expect(brief({ ...input, role, followup: true })).not.toContain('previous report')
})
