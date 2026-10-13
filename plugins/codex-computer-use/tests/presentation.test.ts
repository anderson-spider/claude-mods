import { expect, test } from 'claude-code/testing'

import type { StatusReply } from '../hooks/model'
import { approvalWaitText, forgetText, statusReport, toAnswer } from '../hooks/presentation'
import { APPROVAL_MS } from '../hooks/routing'

test('toAnswer words busy, denied and ok replies', () => {
  expect(toAnswer({ status: 'busy', app: { bundleId: 'b', displayName: 'Calculator' }, owner: 'sess-2' }).result).toMatch(/in use by another/)
  expect(toAnswer({ status: 'denied', app: { bundleId: 'b', displayName: 'TextEdit' } }).isError).toBe(true)
  expect(toAnswer({ status: 'ok', isError: false, content: [{ type: 'text', text: '100' }], notes: [] })).toEqual({ result: '100' })
})

test('forgetText words a forgotten app, a failure, and an ok reply that names no app', () => {
  expect(forgetText('Grapher', { status: 'ok', bundleId: 'com.x', helper: true, codex: 'removed' })).toBe([
    'codex-cu: Grapher (com.x) is no longer always allowed; its next use asks again.',
    '  helper list: removed',
    '  Codex ComputerUseAppApprovals.json: removed',
  ].join('\n'))
  expect(forgetText('Nowhere', { status: 'error', message: 'no app found' })).toBe('codex-cu: could not forget Nowhere: no app found')
  expect(forgetText('X', { status: 'ok' } as never)).toBe('codex-cu: could not forget X: {"status":"ok"}')
})

test('statusReport preserves unreachable and error reports', () => {
  expect(statusReport(true, { status: 'unreachable', message: 'no socket' })).toBe(
    'Route: Codex computer use (on)\nHelper: not reachable (no socket)',
  )
  expect(statusReport(false, { status: 'error', message: 'bad reply' })).toBe(
    'Route: Claude\'s own computer use (off)\nHelper: not reachable (bad reply)',
  )
})

test('statusReport preserves running helper, callers and auto-approve text', () => {
  const reply: StatusReply = {
    version: '0.4.1',
    callers: [{ caller: 'sess-1', apps: ['TextEdit', 'Calculator'] }, { caller: 'sess-2', apps: [] }],
    settings: { autoApprove: true, always: [] },
  }
  expect(statusReport(true, reply)).toBe([
    'Route: Codex computer use (on)',
    'Helper: 0.4.1 running, 2 Codex session(s)',
    'Auto-approve: on (no questions)',
    '  sess-1: TextEdit, Calculator',
    '  sess-2: no apps',
  ].join('\n'))
  expect(statusReport(false, {})).toBe([
    'Route: Claude\'s own computer use (off)',
    'Helper: ? running, 0 Codex session(s)',
    'Auto-approve: off (asks first)',
  ].join('\n'))
})

test('approval wait text describes the fixed deadline and formats pure-test durations', () => {
  expect(approvalWaitText(APPROVAL_MS)).toBe(' within 5 minutes')
  expect(approvalWaitText(60_000)).toBe(' within 1 minute')
  expect(approvalWaitText(75_000)).toBe(' within 1.3 minutes')
  expect(approvalWaitText(30_000)).toBe(' within 30 seconds')
  expect(approvalWaitText(1000)).toBe(' within 1 second')
})
