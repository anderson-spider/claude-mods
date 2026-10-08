import { expect, test } from 'claude-code/testing'
import { ENGINES, PROFILES, argsFor, claudeModeOf } from '../hooks/engines'

test('Codex sandboxes execute to the workspace and review to read-only', () => {
  expect(argsFor('codex', 'execute', undefined)).toEqual(['-s', 'workspace-write', '-a', 'on-request'])
  expect(argsFor('codex', 'review', undefined)).toEqual(['-s', 'read-only', '-a', 'on-request'])
})

test('Claude executes in auto mode with the report folder added and no nested lead', () => {
  expect(argsFor('claude', 'execute', '/var/tmp/')).toEqual(['--permission-mode', 'auto', '--add-dir', '/var/tmp/codex-team', '--disallowedTools', 'mcp__codex-team'])
})

test('Claude reviews by permissions: no edits, a write only for the report folder', () => {
  const args = argsFor('claude', 'review', '/var/tmp')
  expect(args).toEqual(['--permission-mode', 'manual', '--disallowedTools', 'Edit', 'NotebookEdit', 'mcp__codex-team', '--allowedTools', 'Write(//var/tmp/codex-team/**)'])
})

test('the Claude mode follows CODEX_TEAM_CLAUDE_MODE only for a known mode', () => {
  expect(claudeModeOf(undefined)).toBe('auto')
  expect(claudeModeOf('acceptEdits')).toBe('acceptEdits')
  expect(claudeModeOf('bypassPermissions')).toBe('auto')
  expect(argsFor('claude', 'execute', undefined, 'acceptEdits').slice(0, 2)).toEqual(['--permission-mode', 'acceptEdits'])
  // Review never takes the mode: it is read-only whatever the person chose.
  expect(argsFor('claude', 'review', undefined, 'acceptEdits')).toContain('manual')
})

test('only Codex has a /stop, and only Claude needs its report to end a job', () => {
  expect(ENGINES).toEqual(['codex', 'claude'])
  expect(PROFILES.codex.cancel).toEqual({ keys: ['esc'], stop: '/stop' })
  expect(PROFILES.claude.cancel).toEqual({ keys: ['esc'] })
  expect([PROFILES.codex.confirmByReport, PROFILES.claude.confirmByReport]).toEqual([false, true])
})
