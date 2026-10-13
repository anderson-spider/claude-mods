import { expect, test } from 'claude-code/testing'
import { deliver, errorOf, isTeamName, MAX_PROMPT_BYTES } from '../hooks/herdr'
import type { DispatchInput } from '../hooks/herdr'
import { agents, fail, fakeRun, ok } from './fake-run'

const input = (over: Partial<DispatchInput> = {}): DispatchInput => ({
  name: 'analyst', writes: false, workspace: 'w1', cwd: '/r', codexArgs: ['-m', 'm'], prompt: 'do it', ...over,
})
const verbs = (calls: string[][]) => calls.map(call => call.slice(1, 3).join(' '))

test('with no team agent alive, the first agent starts in a new team tab without focus, then gets the prompt', async () => {
  const { run, calls } = fakeRun([agents([{ name: 'other', pane_id: 'w1:p1' }]), [['herdr', 'tab', 'create'], ok({ root_pane: { pane_id: 'w1:p9' } })], [['herdr', 'agent', 'start'], ok({})], [['herdr', 'agent', 'prompt'], ok({})]])

  expect(await deliver(run, input())).toEqual({ agent: 'analyst', pane: 'w1:p9', started: true, status: 'confirmed' })
  expect(verbs(calls)).toEqual(['agent list', 'tab create', 'agent start', 'agent prompt'])
  expect(calls[1]).toEqual(['herdr', 'tab', 'create', '--workspace', 'w1', '--cwd', '/r', '--label', 'codex team', '--no-focus'])
  expect(calls[2]).toEqual(['herdr', 'agent', 'start', 'analyst', '--kind', 'codex', '--pane', 'w1:p9', '--timeout', '60000', '--', '-m', 'm'])
  expect(calls[3]).toEqual(['herdr', 'agent', 'prompt', 'analyst', 'do it', '--wait', '--until', 'working', '--until', 'blocked', '--timeout', '15000'])
})

test('a new agent splits beside a live team agent, to the right and without focus', async () => {
  const { run, calls } = fakeRun([agents([{ name: 'architect', pane_id: 'w2:p3' }]), [['herdr', 'pane', 'split'], ok({ pane: { pane_id: 'w2:p4' } })], [['herdr', 'agent', 'start'], ok({})], [['herdr', 'agent', 'prompt'], ok({})]])

  expect((await deliver(run, input())).pane).toBe('w2:p4')
  expect(calls[1]).toEqual(['herdr', 'pane', 'split', '--pane', 'w2:p3', '--direction', 'right', '--cwd', '/r', '--no-focus'])
})

test('a live idle or done agent is reused: no pane, no start, only the prompt', async () => {
  for (const status of ['idle', 'done']) {
    const { run, calls } = fakeRun([agents([{ name: 'analyst', pane_id: 'w1:p2', agent_status: status, cwd: '/r' }]), [['herdr', 'agent', 'prompt'], ok({})]])
    expect(await deliver(run, input())).toEqual({ agent: 'analyst', pane: 'w1:p2', started: false, status: 'confirmed' })
    expect(verbs(calls)).toEqual(['agent list', 'agent prompt'])
  }
})

test('a busy or blocked agent is not sent anything', async () => {
  for (const [status, reason] of [['working', 'agent busy'], ['blocked', 'agent blocked']]) {
    const { run, calls } = fakeRun([agents([{ name: 'analyst', pane_id: 'w1:p2', agent_status: status }])])
    expect(await deliver(run, input())).toEqual({ agent: 'analyst', pane: 'w1:p2', started: false, status: 'not_sent', reason })
    expect(verbs(calls)).toEqual(['agent list'])
  }
})

test('one writer per directory: a second developer in the same worktree is refused, and a developer is not moved to another', async () => {
  const dev = input({ name: 'dev-b', writes: true, cwd: '/wt/a' })
  const same = fakeRun([agents([{ name: 'dev-a', pane_id: 'w1:p2', cwd: '/wt/a/' }])])
  expect(await deliver(same.run, dev)).toEqual({ agent: 'dev-b', started: false, status: 'not_sent', reason: 'dev-a already works in this directory' })
  expect(verbs(same.calls)).toEqual(['agent list'])

  const moved = fakeRun([agents([{ name: 'dev-b', pane_id: 'w1:p3', cwd: '/wt/other', agent_status: 'idle' }])])
  expect((await deliver(moved.run, dev)).reason).toBe('dev-b works in another directory')
})

test('a prompt the agent was seen taking is confirmed; refused before writing is not_sent; anything else is unknown and never resent', async () => {
  const live = agents([{ name: 'analyst', pane_id: 'w1:p2', agent_status: 'idle' }])
  for (const [answer, status] of [[fail('agent_blocked'), 'not_sent'], [fail('agent_not_found'), 'not_sent'], [fail('agent_prompt_stalled'), 'unknown'], [fail('timeout'), 'unknown']] as const) {
    const { run, calls } = fakeRun([live, [['herdr', 'agent', 'prompt'], answer]])
    const delivered = await deliver(run, input())
    expect(delivered.status).toBe(status)
    expect(calls.filter(call => call[2] === 'prompt')).toHaveLength(1)
  }
  const thrown = await deliver(async argv => { if (argv[2] === 'prompt') throw new Error('gone'); return ok({ agents: [{ name: 'analyst', pane_id: 'p', agent_status: 'idle' }] }) }, input())
  expect(thrown).toEqual({ agent: 'analyst', pane: 'p', started: false, status: 'unknown', reason: 'prompt call failed' })
})

test('beforeSend runs once, after the agent is ready and before the prompt', async () => {
  const order: string[] = []
  const { run } = fakeRun([agents([]), [['herdr', 'tab', 'create'], ok({ root_pane: { pane_id: 'p' } })], [['herdr', 'agent', 'start'], (argv) => (order.push('start'), ok({}))], [['herdr', 'agent', 'prompt'], () => (order.push('prompt'), ok({}))]])
  await deliver(run, input({ beforeSend: async () => { order.push('record') } }))
  expect(order).toEqual(['start', 'record', 'prompt'])
})

test('a failed pane or start is not_sent with the Herdr code, and nothing is prompted', async () => {
  const pane = fakeRun([agents([]), [['herdr', 'tab', 'create'], fail('workspace_not_found')]])
  expect(await deliver(pane.run, input())).toEqual({ agent: 'analyst', started: false, status: 'not_sent', reason: 'workspace_not_found' })
  const start = fakeRun([agents([]), [['herdr', 'tab', 'create'], ok({ root_pane: { pane_id: 'p' } })], [['herdr', 'agent', 'start'], fail('agent_not_ready')]])
  expect(await deliver(start.run, input())).toEqual({ agent: 'analyst', pane: 'p', started: false, status: 'not_sent', reason: 'agent_not_ready' })
  expect(start.calls.some(call => call[2] === 'prompt')).toBe(false)
})

test('a prompt over 64 KiB is refused before Herdr is asked anything', async () => {
  const { run, calls } = fakeRun([])
  expect((await deliver(run, input({ prompt: 'x'.repeat(MAX_PROMPT_BYTES + 1) }))).reason).toBe('prompt over 64 KiB')
  expect(calls).toEqual([])
})

test('errors keep only a Herdr code, never the message text', () => {
  expect(errorOf(fail('agent_busy'))).toBe('agent_busy')
  expect(errorOf({ exitCode: 2, stdout: 'secret output', stderr: 'usage: secret' })).toBe('exit 2')
  expect(errorOf({ exitCode: 1, stdout: '', stderr: JSON.stringify({ error: { code: 'Has Spaces /path' } }) })).toBe('exit 1')
})

test('the team is the analyst, the architect and every dev-<slug>', () => {
  expect(['analyst', 'architect', 'dev-x'].every(isTeamName)).toBe(true)
  expect(['claude', 'implementer', undefined, 'developer'].some(isTeamName)).toBe(false)
})
