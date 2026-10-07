import { expect, test } from 'claude-code/testing'
import { agentName, nextFreeId, reportPath } from '../hooks/names'
import { buildPrompt, codexArgs, fixTask, qaFocus } from '../hooks/prompts'
import { requestOf, loopOf } from '../hooks/requests'
import { verdictOf } from '../hooks/loop'

test('agentName prefixes the job id', () => {
  expect(agentName(3)).toBe('ct-3')
})

test('nextFreeId skips the names that are still live agents', () => {
  expect(nextFreeId(1, ['ct-1', 'ct-2', 'other'])).toBe(3)
  expect(nextFreeId(1, [])).toBe(1)
})

test('codexArgs sandboxes execute to the workspace and review to read-only', () => {
  expect(codexArgs('execute')).toEqual(['-s', 'workspace-write', '-a', 'on-request'])
  expect(codexArgs('review')).toEqual(['-s', 'read-only', '-a', 'on-request'])
})

test('reportPath lives in a codex-team folder of TMPDIR, falling back to /tmp', () => {
  expect(reportPath('/var/tmp', 4)).toBe('/var/tmp/codex-team/4.md')
  expect(reportPath('/var/tmp/', 4)).toBe('/var/tmp/codex-team/4.md')
  expect(reportPath(undefined, 4)).toBe('/tmp/codex-team/4.md')
})

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

test('requestOf rejects an empty task and trims the valid ones', () => {
  expect(typeof requestOf('execute', {})).toBe('string')
  expect(typeof requestOf('execute', { task: '  ' })).toBe('string')
  expect(requestOf('execute', { task: ' t ', files: ['a', 3, ''] })).toEqual({ kind: 'execute', task: 't', files: ['a'] })
  expect(requestOf('review', {})).toEqual({ kind: 'review', task: '', files: [] })
})

test('verdictOf accepts only the exact last non-empty line', () => {
  expect(verdictOf('findings\nVERDICT: APPROVED')).toBe('approved')
  expect(verdictOf('findings\n  VERDICT: CHANGES  \n\n  ')).toBe('changes')
  expect(verdictOf('findings\r\n VERDICT: APPROVED \r\n')).toBe('approved')
  for (const report of [undefined, '', '  \n', 'verdict: approved', 'VERDICT: approved', 'VERDICT: APPROVED extra', 'VERDICT: APPROVED\nmore text']) {
    expect(verdictOf(report)).toBe(undefined)
  }
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
})

test('loopOf requires a task, trims files and defaults maxRounds to three', () => {
  expect(typeof loopOf({})).toBe('string')
  expect(typeof loopOf({ task: '  ' })).toBe('string')
  expect(loopOf({ task: ' add X ', files: [' a.ts ', '', 4] })).toEqual({ task: 'add X', files: ['a.ts'], maxRounds: 3 })
  expect(loopOf({ task: 'add X', maxRounds: 1 })).toEqual({ task: 'add X', files: [], maxRounds: 1 })
})

test('loopOf rejects maxRounds unless it is an integer at least one', () => {
  for (const maxRounds of [0, -1, 1.5, '3', null, true, NaN, Infinity]) {
    expect(loopOf({ task: 'add X', maxRounds })).toBe('Give maxRounds as an integer at least 1.')
  }
})

test('nextFreeId reserves a loop id while either role agent is live', () => {
  expect(nextFreeId(1, ['ct-1-dev', 'ct-2-qa', 'ct-3', 'ct-40-dev'])).toBe(4)
  expect(nextFreeId(1, ['ct-10-dev', 'ct-1-other'])).toBe(1)
})
