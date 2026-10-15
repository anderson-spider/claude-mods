import { expect, test } from 'claude-code/testing'

import type { SettingsReply, StatusReply } from '../hooks/model'
import {
  ASK_HINT,
  ASK_LABELS,
  BRIDGE_OFF,
  INSTALL_HELPER,
  TOO_MANY_ROUNDS,
  approvalWaitText,
  askBody,
  askTitle,
  askerText,
  autoApproveText,
  bridgeFailedText,
  forgetText,
  refusal,
  releaseText,
  resetText,
  routeText,
  statusReport,
  toAnswer,
  unansweredText,
} from '../hooks/presentation'
import { APPROVAL_MS } from '../hooks/routing'

test('toAnswer words busy, denied and ok replies', () => {
  expect(toAnswer({ status: 'busy', app: { bundleId: 'b', displayName: 'Calculator' }, owner: 'sess-2' }).result).toMatch(/in use by another/)
  expect(toAnswer({ status: 'denied', app: { bundleId: 'b', displayName: 'TextEdit' } }).isError).toBe(true)
  expect(toAnswer({ status: 'ok', isError: false, content: [{ type: 'text', text: '100' }], notes: [] })).toEqual({ result: '100' })
})

test('toAnswer gives the install command when the helper is not running', () => {
  const answer = toAnswer({ status: 'unreachable', message: 'no socket' })
  expect(answer.isError).toBe(true)
  expect(answer.result).toContain(INSTALL_HELPER)
  expect(answer.result).toContain('no socket')
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

test('statusReport preserves unreachable and error reports, with the install command only when nothing listens', () => {
  expect(statusReport(true, { status: 'unreachable', message: 'no socket' })).toBe(
    `Route: Codex computer use (on)\nHelper: not reachable (no socket)\nInstall or restart it: ${INSTALL_HELPER}`,
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

test('command texts: route switch, auto-approve (with the helper unreachable or failing) and release', () => {
  expect(routeText(true)).toBe('codex-cu on: desktop apps go through Codex computer use; Claude’s own computer use is blocked.')
  expect(routeText(false)).toBe('codex-cu off: Claude’s own desktop computer use is back; the Codex bridge refuses calls.')

  const ok: SettingsReply = { status: 'ok', settings: { autoApprove: true, always: [] } }
  expect(autoApproveText(true, ok)).toBe('codex-cu auto-approve on: apps are used without asking (organization and safety blocks still apply).')
  expect(autoApproveText(false, ok)).toBe('codex-cu auto-approve off: a new app asks first.')
  expect(autoApproveText(true, { status: 'unreachable', message: 'no socket' })).toBe('codex-cu: could not reach the helper (no socket).')
  expect(autoApproveText(false, { status: 'error', message: 'bad reply' })).toBe('codex-cu: could not reach the helper (bad reply).')

  expect(releaseText({ status: 'ok', ended: [] })).toBe('codex-cu: this session’s Codex sessions ended and its app answers were dropped.')
  expect(releaseText({ status: 'error', message: 'nope' })).toBe('codex-cu: {"status":"error","message":"nope"}')
})

test('bridge texts: off, reset, unanswered, too many rounds and a thrown bridge are refusals', () => {
  expect(refusal('x')).toEqual({ result: 'x', isError: true })
  expect(BRIDGE_OFF).toBe('codex-computer-use is off (/codex-cu off): use the default desktop route, or ask the person to type /codex-cu on.')
  expect(resetText({ status: 'ok', message: 'session reset' })).toBe('session reset')
  expect(resetText({ status: 'ok' } as never)).toBe('reset')
  expect(unansweredText('TextEdit', 'timeout', APPROVAL_MS)).toBe('The person did not answer whether Codex may use TextEdit within 5 minutes; nothing was done with it.')
  expect(unansweredText('TextEdit', 'aborted', APPROVAL_MS)).toBe('The person did not answer whether Codex may use TextEdit; nothing was done with it.')
  expect(TOO_MANY_ROUNDS).toBe('codex-cu: too many approval rounds for one call.')
  expect(bridgeFailedText(new Error('boom'))).toBe('codex-cu: the bridge failed: boom')
  expect(bridgeFailedText('plain')).toBe('codex-cu: the bridge failed: plain')
})

test('approval band texts: asker, heading, sentence, button labels and hint', () => {
  expect(askerText(undefined)).toBe('main session')
  expect(askerText('agent-1')).toBe('subagent agent-1')
  expect(askTitle({ displayName: 'TextEdit' })).toBe('Codex computer use · Allow “TextEdit”?')
  expect(askBody({ displayName: 'TextEdit', who: 'main session' })).toBe(
    'Asked by the main session. Codex will see what TextEdit shows and can click and type in it.',
  )
  expect(ASK_LABELS).toEqual({ session: 'This session', always: 'Always', deny: 'No' })
  expect(ASK_HINT).toBe('/codex-cu auto-approve on stops asking')
})
