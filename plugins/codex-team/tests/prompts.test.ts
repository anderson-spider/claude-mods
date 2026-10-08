import { expect, test } from 'claude-code/testing'
import { buildPrompt, fixTask, qaFocus } from '../hooks/prompts'

test('buildPrompt for execute carries the task, the files, the report path and the no-commit rule', () => {
  const prompt = buildPrompt('execute', { task: 'add X', files: ['a.ts'] }, '/tmp/codex-team/1.md')
  expect(prompt).toContain('add X')
  expect(prompt).toContain('a.ts')
  expect(prompt).toContain('/tmp/codex-team/1.md')
  expect(prompt).toContain('Do not commit')
  expect(prompt).toContain('answer with only that path')
})

test('buildPrompt for execute asks for the fixed report sections in order', () => {
  const prompt = buildPrompt('execute', { task: 'add X' }, '/tmp/codex-team/1.md')
  const at = (heading: string) => prompt.indexOf(heading)
  expect(at('## Report')).toBeGreaterThan(-1)
  expect(at('## Report')).toBeLessThan(at('## Checks'))
  expect(at('## Checks')).toBeLessThan(at('## Next'))
  expect(at('## Next')).toBeLessThan(at('## Remember'))
  expect(prompt).toContain('CHECKS: PASS')
  expect(prompt).toContain('CHECKS: NOT RUN')
})

test('buildPrompt for review asks for findings then next, without the execute sections', () => {
  const prompt = buildPrompt('review', {}, '/tmp/codex-team/2.md')
  expect(prompt.indexOf('## Findings')).toBeGreaterThan(-1)
  expect(prompt.indexOf('## Findings')).toBeLessThan(prompt.indexOf('## Next'))
  expect(prompt).not.toContain('## Checks')
  expect(prompt).not.toContain('## Remember')
})

test('buildPrompt for review carries the target and focus and forbids edits', () => {
  const prompt = buildPrompt('review', { target: 'main', focus: 'races' }, '/tmp/codex-team/2.md')
  expect(prompt).toContain('main')
  expect(prompt).toContain('races')
  expect(prompt).toContain('Do not edit any file')
  expect(prompt).toContain('/tmp/codex-team/2.md')
  expect(prompt).toContain('answer with only that path')
})

test('qaFocus uses the task as acceptance criteria and ends with the exact verdict rule', () => {
  const focus = qaFocus('add X and check Y')
  expect(focus).toContain('Acceptance criteria:\nadd X and check Y')
  expect(focus).toContain('actionable findings')
  expect(focus).toContain('Do not edit any file')
  expect(focus.endsWith('After the last section, end the report with exactly one last line: VERDICT: APPROVED or VERDICT: CHANGES.')).toBe(true)
})

test('fixTask carries the original task and the previous QA report path', () => {
  const task = fixTask('add X', '/tmp/codex-team/3.md')
  expect(task).toContain('add X')
  expect(task).toContain('/tmp/codex-team/3.md')
  expect(task).toContain('fix the findings')
  const checks = fixTask('add X', '/tmp/codex-team/1-dev1.md', 'checks')
  expect(checks).toContain('add X')
  expect(checks).toContain('/tmp/codex-team/1-dev1.md')
  expect(checks).toContain('checks failed')
})
