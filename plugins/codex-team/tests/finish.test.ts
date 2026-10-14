import { expect, test } from 'claude-code/testing'
import { finishAgent } from '../hooks/finish'
import { fakeRun, fail, ok, text } from './fake-run'
import type { Rule } from './fake-run'

const uuid = '12345678-1234-1234-1234-123456789abc'
const agent = { name: 'dev-fix', agent: 'codex', workspace_id: 'w1', pane_id: 'worker', tab_id: 'task', agent_status: 'done', agent_session: { kind: 'id', source: 'herdr:codex', value: uuid } }
const input = { agent: 'dev-fix', workspace: 'w1', leadPane: 'lead' }
const sleep = async (_ms: number) => {}
const tabs: Rule = [['herdr', 'tab', 'list'], ok({ tabs: [{ tab_id: 'task', workspace_id: 'w1', label: 'codex · fix', pane_count: 1 }] })]

test('finish refuses working, blocked, unknown, foreign and non-team agents without closing or archiving', async () => {
  for (const status of ['working', 'blocked', 'unknown']) {
    const w = fakeRun([[['herdr', 'agent', 'get'], ok({ agent: { ...agent, agent_status: status } })]])
    expect(await finishAgent(w.run, sleep, input)).toMatchObject({ closed: false, archived: false, reason: expect.stringContaining('agent') })
    expect(w.calls).toEqual([['herdr', 'agent', 'get', 'dev-fix']])
  }
  const foreign = fakeRun([[['herdr', 'agent', 'get'], ok({ agent: { ...agent, workspace_id: 'w2' } })]])
  expect((await finishAgent(foreign.run, sleep, input)).reason).toBe('agent is live in another workspace')
  expect(foreign.calls).toHaveLength(1)
  for (const name of ['main', 'git-master', 'developer', 'analyst-X', 'dev-', 'dev-' + 'a'.repeat(23), '--all']) {
    const w = fakeRun([])
    expect((await finishAgent(w.run, sleep, { ...input, agent: name })).closed).toBe(false)
    expect(w.calls).toEqual([])
  }
})

test('finish protects the lead pane and requires a verified Codex session uuid', async () => {
  for (const over of [
    { pane_id: 'lead' }, { name: 'other' }, { agent: 'claude' },
    { agent_session: undefined }, { agent_session: { ...agent.agent_session, source: 'other' } },
    { agent_session: { ...agent.agent_session, kind: 'title' } },
    { agent_session: { ...agent.agent_session, value: '--all' } },
  ]) {
    const w = fakeRun([[['herdr', 'agent', 'get'], ok({ agent: { ...agent, ...over } })]])
    expect(await finishAgent(w.run, sleep, input)).toMatchObject({ closed: false, archived: false })
    expect(w.calls).toHaveLength(1)
  }
  const w = fakeRun([])
  expect((await finishAgent(w.run, sleep, { ...input, leadPane: undefined })).reason).toBe('HERDR_PANE_ID is not set')
  expect(w.calls).toEqual([])
})

test('finish rechecks exact pane ownership and settled state before any close', async () => {
  for (const live of [
    [], [{ ...agent, pane_id: 'replacement' }], [{ ...agent, workspace_id: 'w2' }],
    [{ ...agent, name: 'someone-else' }], [{ ...agent, agent_status: 'working' }],
    [{ ...agent, agent_status: 'blocked' }], [agent, { ...agent, name: 'someone-else' }],
  ]) {
    const w = fakeRun([[['herdr', 'agent', 'get'], ok({ agent })], tabs, [['herdr', 'agent', 'list'], ok({ agents: live })]])
    expect(await finishAgent(w.run, sleep, input)).toMatchObject({ closed: false, archived: false })
    expect(w.calls.some(call => call[2] === 'close' || call[0] === 'codex')).toBe(false)
  }
})

test('finish closes only the agent pane and its last task tab, waits for exit, then archives the uuid in order', async () => {
  let listed = 0
  const sleeps: number[] = []
  const w = fakeRun([
    [['herdr', 'agent', 'get'], ok({ agent })], tabs,
    [['herdr', 'agent', 'list'], () => ok({ agents: ++listed < 3 ? [agent] : [] })],
    [['herdr', 'pane', 'close'], ok({ pane_id: 'worker', type: 'pane_closed' })],
    [['codex', 'archive'], text('archived')],
  ])
  expect(await finishAgent(w.run, async ms => { sleeps.push(ms) }, input)).toEqual({ agent: 'dev-fix', uuid, pane: 'worker', tab: 'task', closed: true, archived: true })
  expect(w.calls).toEqual([
    ['herdr', 'agent', 'get', 'dev-fix'], ['herdr', 'tab', 'list', '--workspace', 'w1'],
    ['herdr', 'agent', 'list'], ['herdr', 'pane', 'close', 'worker'],
    ['herdr', 'agent', 'list'], ['herdr', 'agent', 'list'], ['codex', 'archive', uuid],
  ])
  expect(sleeps).toEqual([250])
})

test('finish preserves sibling panes and reports no tab closure when the task tab has another pane', async () => {
  let listed = 0
  const peer = { ...agent, name: 'architect-fix', pane_id: 'peer' }
  const w = fakeRun([
    [['herdr', 'agent', 'get'], ok({ agent })],
    [['herdr', 'tab', 'list'], ok({ tabs: [{ tab_id: 'task', workspace_id: 'w1', label: 'codex · fix', pane_count: 2 }] })],
    [['herdr', 'agent', 'list'], () => ok({ agents: ++listed === 1 ? [agent, peer] : [peer] })],
    [['herdr', 'pane', 'close'], ok({})], [['codex', 'archive'], ok({})],
  ])
  const done = await finishAgent(w.run, sleep, input)
  expect(done.archived).toBe(true)
  expect(done.tab).toBeUndefined()
  expect(w.calls.filter(call => call[2] === 'close')).toEqual([['herdr', 'pane', 'close', 'worker']])
})

test('finish reports archive failure without retaining stdout, stderr or thrown text', async () => {
  for (const throws of [false, true]) {
    let listed = 0
    const w = fakeRun([
      [['herdr', 'agent', 'get'], ok({ agent })], tabs,
      [['herdr', 'agent', 'list'], () => ok({ agents: ++listed === 1 ? [agent] : [] })],
      [['herdr', 'pane', 'close'], ok({})],
      [['codex', 'archive'], () => { if (throws) throw new Error('private task output'); return { exitCode: 7, stdout: 'private task output', stderr: 'private path' } }],
    ])
    const done = await finishAgent(w.run, sleep, input)
    expect(done).toMatchObject({ closed: true, archived: false, reason: throws ? 'archive call failed' : 'archive exit 7' })
    expect(JSON.stringify(done)).not.toContain('private')
  }
})

test('finish bounds exit polling and never archives while the agent or its pane remains live', async () => {
  for (const remaining of [agent, { ...agent, name: 'replacement' }]) {
    let listed = 0, sleeps = 0
    const w = fakeRun([
      [['herdr', 'agent', 'get'], ok({ agent })], tabs,
      [['herdr', 'agent', 'list'], () => ok({ agents: [++listed === 1 ? agent : remaining] })],
      [['herdr', 'pane', 'close'], ok({})],
    ])
    expect(await finishAgent(w.run, async () => { sleeps++ }, input)).toMatchObject({ closed: true, archived: false, reason: 'agent exit timed out; archive not attempted' })
    expect(listed).toBe(11)
    expect(sleeps).toBe(9)
    expect(w.calls.some(call => call[0] === 'codex')).toBe(false)
  }
})

test('finish fails closed on unreadable listings, failed close and missing agents', async () => {
  for (const [prefix, answer] of [
    [['herdr', 'agent', 'get'], fail('agent_not_found')],
    [['herdr', 'agent', 'list'], text('unreadable')],
    [['herdr', 'pane', 'close'], fail('pane_not_found')],
  ] as Rule[]) {
    const w = fakeRun([[prefix, answer], [['herdr', 'agent', 'get'], ok({ agent })], tabs, [['herdr', 'agent', 'list'], ok({ agents: [agent] })]])
    expect(await finishAgent(w.run, sleep, input)).toMatchObject({ closed: false, archived: false })
    expect(w.calls.some(call => call[0] === 'codex')).toBe(false)
  }
  for (const unreadable of [
    text('{"result":{"agents":[null]}}'),
    { ...ok({ agents: [] }), isStdoutTruncated: true },
  ]) {
    const w = fakeRun([[['herdr', 'agent', 'get'], ok({ agent })], tabs, [['herdr', 'agent', 'list'], unreadable]])
    expect((await finishAgent(w.run, sleep, input)).reason).toBe('agent list unreadable')
    expect(w.calls.some(call => call[2] === 'close' || call[0] === 'codex')).toBe(false)
  }
})
