import { effectiveName } from '../hooks/names'
import { expect, test } from 'claude-code/testing'
import { deliver, errorOf, isTeamName, MAX_PROMPT_BYTES, paneLabel } from '../hooks/herdr'
import type { DispatchInput } from '../hooks/herdr'
import { agents, fail, fakeRun, ok } from './fake-run'

const input = (over: Partial<DispatchInput> = {}): DispatchInput => ({
  name: 'analyst', slug: 'fix', writes: false, workspace: 'w1', cwd: '/r', startArgs: async () => ['-m', 'm'], prompt: 'do it', ...over,
})
const verbs = (calls: string[][]) => calls.map(call => call.slice(1, 3).join(' '))

test('with no team agent alive, a shared role starts in a current task tab without focus, then gets the prompt', async () => {
  const { run, calls } = fakeRun([agents([{ name: 'other', pane_id: 'w1:p1' }]), [['herdr', 'tab', 'create'], ok({ root_pane: { pane_id: 'w1:p9' } })], [['herdr', 'agent', 'start'], ok({})], [['herdr', 'agent', 'prompt'], ok({})]])

  expect(await deliver(run, input())).toEqual({ agent: 'analyst', effectiveAgent: effectiveName('analyst', 'w1'), pane: 'w1:p9', started: true, existed: false, status: 'confirmed' })
  expect(verbs(calls)).toEqual(['agent list', 'tab create', 'agent start', 'pane rename', 'agent prompt'])
  expect(calls[1]).toEqual(['herdr', 'tab', 'create', '--workspace', 'w1', '--cwd', '/r', '--label', 'codex - fix', '--no-focus'])
  expect(calls[2]).toEqual(['herdr', 'agent', 'start', effectiveName('analyst', 'w1')!, '--kind', 'codex', '--pane', 'w1:p9', '--timeout', '60000', '--', '-m', 'm'])
  expect(calls[3]).toEqual(['herdr', 'pane', 'rename', 'w1:p9', 'analyst'])
  expect(calls[4]).toEqual(['herdr', 'agent', 'prompt', effectiveName('analyst', 'w1')!, 'do it', '--wait', '--until', 'working', '--until', 'blocked', '--timeout', '15000'])
})

test('a shared role gets its own current task tab even with another shared role live', async () => {
  const { run, calls } = fakeRun([agents([{ name: effectiveName('architect', 'w1'), pane_id: 'w1:p3' }]), [['herdr', 'tab', 'create'], ok({ root_pane: { pane_id: 'w1:p4' } })], [['herdr', 'agent', 'start'], ok({})], [['herdr', 'agent', 'prompt'], ok({})]])
  expect((await deliver(run, input())).pane).toBe('w1:p4')
  expect(calls[1]).toEqual(['herdr', 'tab', 'create', '--workspace', 'w1', '--cwd', '/r', '--label', 'codex - fix', '--no-focus'])
})

test('every idle or done team agent is retired before a fresh pane session and prompt', async () => {
  for (const name of ['dev-fix', 'architect-fix', 'analyst-fix', 'analyst', 'architect']) for (const status of ['idle', 'done']) {
    let retired = false
    const w = fakeRun([agents([{ name: effectiveName(name, 'w1')!, pane_id: 'old', cwd: '/r', agent_status: status }]),
      [['herdr', 'tab', 'create'], ok({ root_pane: { pane_id: 'new' } })], [['herdr', 'agent', 'start'], ok({})], [['herdr', 'agent', 'prompt'], ok({})]])
    const run = async (argv: readonly string[]) => {
      if (retired && argv[2] === 'list') { w.calls.push([...argv]); return ok({ agents: [] }) }
      return w.run(argv)
    }
    expect(await deliver(run, input({ name, finishPrevious: async actual => { expect(actual).toBe(name); retired = true; return { closed: true, archived: true } } })))
      .toEqual({ agent: name, effectiveAgent: effectiveName(name, 'w1'), pane: 'new', started: true, existed: false, status: 'confirmed' })
    expect(verbs(w.calls)).toEqual(['agent list', 'agent list', 'tab create', 'agent start', 'pane rename', 'agent prompt'])
  }
})

test('a busy or blocked agent is not sent anything', async () => {
  for (const [status, reason] of [['working', 'agent busy'], ['blocked', 'agent blocked']]) {
    const { run, calls } = fakeRun([agents([{ name: effectiveName('analyst', 'w1')!, pane_id: 'w1:p2', agent_status: status }])])
    expect(await deliver(run, input())).toEqual({ agent: 'analyst', effectiveAgent: effectiveName('analyst', 'w1'), pane: 'w1:p2', started: false, existed: true, status: 'not_sent', reason })
    expect(verbs(calls)).toEqual(['agent list'])
  }
})

test('one writer per directory: a second developer in the same worktree is refused, and a developer is not moved to another', async () => {
  const dev = input({ name: 'dev-b', writes: true, cwd: '/wt/a' })
  const same = fakeRun([agents([{ name: effectiveName('dev-a', 'w1')!, pane_id: 'w1:p2', cwd: '/wt/a/' }])])
  expect(await deliver(same.run, dev)).toEqual({ agent: 'dev-b', effectiveAgent: effectiveName('dev-b', 'w1'), started: false, existed: false, status: 'not_sent', reason: 'dev-a already works in this directory' })
  expect(verbs(same.calls)).toEqual(['agent list'])

  const moved = fakeRun([agents([{ name: effectiveName('dev-b', 'w1')!, pane_id: 'w1:p3', cwd: '/wt/other', agent_status: 'idle' }])])
  expect((await deliver(moved.run, dev)).reason).toBe('dev-b works in another directory')
})

test('a prompt the agent was seen taking is confirmed; refused before writing is not_sent; anything else is unknown and never resent', async () => {
  const fresh = [agents([]), [['herdr', 'tab', 'create'], ok({ root_pane: { pane_id: 'w1:p2' } })], [['herdr', 'agent', 'start'], ok({})]] as Parameters<typeof fakeRun>[0]
  for (const [answer, status] of [[fail('agent_blocked'), 'not_sent'], [fail('agent_not_found'), 'not_sent'], [fail('agent_prompt_stalled'), 'unknown'], [fail('timeout'), 'unknown']] as const) {
    const { run, calls } = fakeRun([...fresh, [['herdr', 'agent', 'prompt'], answer]])
    const delivered = await deliver(run, input({ name: 'analyst-fix' }))
    expect(delivered.status).toBe(status)
    expect(calls.filter(call => call[2] === 'prompt')).toHaveLength(1)
  }
  const thrown = await deliver(async argv => { if (argv[2] === 'prompt') throw new Error('gone'); return argv[2] === 'list' ? ok({ agents: [] }) : argv[2] === 'create' ? ok({ root_pane: { pane_id: 'p' } }) : ok({}) }, input({ name: 'analyst-fix' }))
  expect(thrown).toEqual({ agent: 'analyst-fix', effectiveAgent: effectiveName('analyst-fix', 'w1'), pane: 'p', started: true, existed: false, status: 'unknown', reason: 'prompt call failed' })
})

test('beforeSend runs once, after the agent is ready and before the prompt', async () => {
  const order: string[] = []
  const { run } = fakeRun([agents([]), [['herdr', 'tab', 'create'], ok({ root_pane: { pane_id: 'p' } })], [['herdr', 'agent', 'start'], (argv) => (order.push('start'), ok({}))], [['herdr', 'agent', 'prompt'], () => (order.push('prompt'), ok({}))]])
  await deliver(run, input({ beforeSend: async started => { expect(started).toBe(true); order.push('record') } }))
  expect(order).toEqual(['start', 'record', 'prompt'])
})

test('beforeSend records the fresh start after retiring a named predecessor', async () => {
  const order: string[] = []
  let retired = false
  const w = fakeRun([agents([{ name: effectiveName('analyst-fix', 'w1')!, pane_id: 'old', agent_status: 'idle' }]),
    [['herdr', 'tab', 'create'], ok({ root_pane: { pane_id: 'new' } })],
    [['herdr', 'agent', 'start'], () => (order.push('start'), ok({}))], [['herdr', 'agent', 'prompt'], () => (order.push('prompt'), ok({}))]])
  await deliver(async argv => retired && argv[2] === 'list' ? ok({ agents: [] }) : w.run(argv), input({
    name: 'analyst-fix', finishPrevious: async () => { retired = true; order.push('finish'); return { closed: true, archived: true } },
    beforeSend: async started => { expect(started).toBe(true); order.push('record') },
  }))
  expect(order).toEqual(['finish', 'start', 'record', 'prompt'])
})

test('a failed pane or start is not_sent with the Herdr code, and nothing is prompted', async () => {
  const pane = fakeRun([agents([]), [['herdr', 'tab', 'create'], fail('workspace_not_found')]])
  expect(await deliver(pane.run, input())).toEqual({ agent: 'analyst', effectiveAgent: effectiveName('analyst', 'w1'), started: false, existed: false, status: 'not_sent', reason: 'workspace_not_found' })
  const start = fakeRun([agents([]), [['herdr', 'tab', 'create'], ok({ root_pane: { pane_id: 'p' } })], [['herdr', 'agent', 'start'], fail('agent_not_ready')]])
  expect(await deliver(start.run, input())).toEqual({ agent: 'analyst', effectiveAgent: effectiveName('analyst', 'w1'), pane: 'p', started: false, existed: false, status: 'not_sent', reason: 'agent_not_ready' })
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

test('task tabs anchor only to live agents of the same slug and shared roles get labelled tabs', async () => {
  const list = agents([
    { name: effectiveName('analyst', 'w1')!, pane_id: 'home' }, { name: effectiveName('dev-other', 'w1')!, pane_id: 'other' },
    { name: effectiveName('analyst-fix', 'w1')!, pane_id: 'fix' },
  ])
  for (const name of ['dev-fix', 'architect-fix']) {
    const w = fakeRun([list, [['herdr', 'pane', 'split'], ok({ pane: { pane_id: 'new' } })], [['herdr', 'agent', 'start'], ok({})], [['herdr', 'agent', 'prompt'], ok({})]])
    expect(await deliver(w.run, input({ name }))).toMatchObject({ status: 'confirmed', pane: 'new', started: true })
    expect(w.calls[1]).toContain('fix')
    expect(w.calls[1]).toContain('--no-focus')
  }
  const w = fakeRun([list, [['herdr', 'tab', 'create'], ok({ root_pane: { pane_id: 'new' } })], [['herdr', 'agent', 'start'], ok({})], [['herdr', 'agent', 'prompt'], ok({})]])
  await deliver(w.run, input({ name: 'architect' }))
  expect(w.calls[1]).toContain('codex - fix')
})

test('a task without live peers creates its own tab even when other team agents are live', async () => {
  const w = fakeRun([agents([{ name: effectiveName('architect', 'w1')!, pane_id: 'home' }, { name: effectiveName('dev-other', 'w1')!, pane_id: 'other' }]),
    [['herdr', 'tab', 'create'], ok({ root_pane: { pane_id: 'new' } })], [['herdr', 'agent', 'start'], ok({})], [['herdr', 'agent', 'prompt'], ok({})]])
  await deliver(w.run, input({ name: 'dev-fix', writes: true }))
  expect(w.calls[1]).toContain('codex - fix')
  expect(w.calls[1]).toContain('--no-focus')
})

test('a busy shared analyst fallback retires its settled task analyst before a fresh session', async () => {
  for (const status of ['working', 'blocked']) {
    let retired = false
    const shared = { name: effectiveName('analyst', 'w1')!, workspace_id: 'w1', pane_id: 'home', agent_status: status }
    const w = fakeRun([agents([shared, { name: effectiveName('analyst-fix', 'w1')!, pane_id: 'old', agent_status: 'done' }]),
      [['herdr', 'tab', 'create'], ok({ root_pane: { pane_id: 'new' } })], [['herdr', 'agent', 'start'], ok({})], [['herdr', 'agent', 'prompt'], ok({})]])
    expect(await deliver(async argv => retired && argv[2] === 'list' ? ok({ agents: [shared] }) : w.run(argv), input({ analystSlug: 'fix', finishPrevious: async name => {
      expect(name).toBe('analyst-fix'); retired = true; return { closed: true, archived: true }
    } }))).toMatchObject({ agent: 'analyst-fix', pane: 'new', existed: false, started: true })
    expect(w.calls.find(c => c[2] === 'start')![3]).toBe(effectiveName('analyst-fix', 'w1'))
  }
})

test('task and shared tabs anchor only inside the dispatch workspace', async () => {
  for (const [name, peer, label] of [['dev-fix', 'architect-fix', 'codex - fix'], ['analyst', 'architect', 'codex - fix']]) {
    const w = fakeRun([agents([{ name: effectiveName(peer!, 'w2'), workspace_id: 'w2', pane_id: 'w2:p1' }]),
      [['herdr', 'tab', 'create'], ok({ root_pane: { pane_id: 'w1:p2' } })], [['herdr', 'agent', 'start'], ok({})], [['herdr', 'agent', 'prompt'], ok({})]])
    expect((await deliver(w.run, input({ name }))).status).toBe('confirmed')
    expect(w.calls[1]).toEqual(['herdr', 'tab', 'create', '--workspace', 'w1', '--cwd', '/r', '--label', label!, '--no-focus'])
    expect(w.calls.some(call => call[2] === 'split')).toBe(false)
  }
})

test('a real effective name collision fails closed before retirement or startup including analyst fallback names', async () => {
  for (const name of ['dev-fix', 'architect-fix', 'analyst', 'architect', 'analyst-fix']) {
    const peers = name === 'analyst-fix' ? [{ name: effectiveName('analyst', 'w1')!, workspace_id: 'w1', pane_id: 'w1:p1', agent_status: 'working' }] : []
    const w = fakeRun([agents([...peers, { name: effectiveName(name, 'w1'), workspace_id: 'w2', pane_id: 'w2:p1', agent_status: 'done' }]),
      [['herdr', 'agent', 'prompt'], ok({})]])
    const result = await deliver(w.run, input({ name: name === 'analyst-fix' ? 'analyst' : name, analystSlug: 'fix' }))
    expect(result).toMatchObject({ status: 'not_sent', existed: true, reason: expect.stringContaining('another workspace') })
    expect(verbs(w.calls)).toEqual(['agent list'])
  }
})

test('startup selection is lazy once after guards and shared finish with the actual fallback name', async () => {
  const order: string[] = []
  const w = fakeRun([agents([{ name: effectiveName('analyst', 'w1')!, pane_id: 'home', agent_status: 'idle' }]),
    [['herdr', 'tab', 'create'], () => { order.push('pane'); return ok({ root_pane: { pane_id: 'new' } }) }],
    [['herdr', 'agent', 'start'], () => { order.push('start'); return ok({}) }], [['herdr', 'agent', 'prompt'], ok({})]])
  const originalRun = w.run
  let retired = false
  await deliver(async (argv, init) => retired && argv[2] === 'list' ? ok({ agents: [] }) : originalRun(argv, init), input({
    finishPrevious: async () => { order.push('finish'); retired = true; return { closed: true, archived: true } },
    startArgs: async name => { order.push('assess:' + name); return ['-m', 'picked'] },
  }))
  expect(order).toEqual(['finish', 'assess:analyst', 'pane', 'start'])
  const fallback = fakeRun([agents([{ name: effectiveName('analyst', 'w1')!, pane_id: 'home', agent_status: 'working' }]),
    [['herdr', 'tab', 'create'], ok({ root_pane: { pane_id: 'task' } })], [['herdr', 'agent', 'start'], ok({})], [['herdr', 'agent', 'prompt'], ok({})]])
  const names: string[] = []
  await deliver(fallback.run, input({ analystSlug: 'fix', startArgs: async name => { names.push(name); return [] } }))
  expect(names).toEqual(['analyst-fix'])
})

test('startup selection never runs for busy foreign writer conflicts or unavailable or failed finish', async () => {
  const cases: { agents: Parameters<typeof agents>[0]; over?: Partial<DispatchInput> }[] = [
    { agents: [{ name: effectiveName('dev-fix', 'w1')!, pane_id: 'p', cwd: '/r', agent_status: 'idle' }], over: { name: 'dev-fix', writes: true } },
    { agents: [{ name: effectiveName('architect', 'w1')!, pane_id: 'p', agent_status: 'working' }], over: { name: 'architect' } },
    { agents: [{ name: effectiveName('architect', 'w1')!, pane_id: 'p', agent_status: 'blocked' }], over: { name: 'architect' } },
    { agents: [{ name: effectiveName('analyst', 'w1')!, pane_id: 'p', workspace_id: 'w2', agent_status: 'done' }] },
    { agents: [{ name: effectiveName('dev-other', 'w1')!, pane_id: 'p', cwd: '/r' }], over: { name: 'dev-fix', writes: true } },
    { agents: [{ name: effectiveName('dev-fix', 'w1')!, pane_id: 'p', cwd: '/other', agent_status: 'idle' }], over: { name: 'dev-fix', writes: true } },
    { agents: [{ name: effectiveName('analyst', 'w1')!, pane_id: 'p', agent_status: 'idle' }], over: { finishPrevious: async () => ({ closed: true, archived: false }) } },
  ]
  cases.push({ agents: [], over: { prompt: 'x'.repeat(MAX_PROMPT_BYTES + 1) } })
  for (const c of cases) {
    const w = fakeRun([agents(c.agents), [['herdr', 'agent', 'prompt'], ok({})]])
    let called = 0
    await deliver(w.run, input({ ...c.over, startArgs: async () => { called++; return [] } }))
    expect(called).toBe(0)
  }
})

test('retirement failures and a reappearing name refuse every role without selection or a new prompt', async () => {
  for (const name of ['dev-fix', 'architect-fix', 'analyst-fix', 'analyst', 'architect']) {
    for (const reason of ['failed', 'reappeared']) {
      let selected = 0
      const w = fakeRun([agents([{ name: effectiveName(name, 'w1')!, pane_id: 'old', agent_status: 'done' }])])
      const result = await deliver(w.run, input({ name,
        finishPrevious: async () => ({ closed: true, archived: reason !== 'failed', reason: 'archive exit 9' }),
        startArgs: async () => { selected++; return [] },
      }))
      expect(result.status).toBe('not_sent')
      expect(result.reason).toBe(reason === 'failed' ? 'agent finish failed (archive exit 9)' : 'agent reappeared after finish')
      expect(selected).toBe(0)
      expect(w.calls.every(c => c[2] === 'list')).toBe(true)
    }
  }
})

test('post-retirement listing rechecks writer exclusivity and reviewer developer state before selection', async () => {
  for (const kind of ['writer', 'reviewer'] as const) {
    let retired = false, selected = 0
    const name = kind === 'writer' ? 'dev-fix' : 'architect-fix'
    const w = fakeRun([agents([{ name: effectiveName(name, 'w1')!, pane_id: 'old', agent_status: 'done', cwd: '/r' }])])
    const result = await deliver(async argv => retired && argv[2] === 'list'
      ? ok({ agents: [{ name: effectiveName(kind === 'writer' ? 'dev-other' : 'dev-fix', 'w1')!, workspace_id: 'w1', pane_id: 'other', cwd: '/r', agent_status: 'working' }] }) : w.run(argv), input({ name,
      writes: kind === 'writer', reviewDeveloper: kind === 'reviewer' ? 'dev-fix' : undefined,
      finishPrevious: async () => { retired = true; return { closed: true, archived: true } },
      startArgs: async () => { selected++; return [] },
    }))
    expect(result.reason).toBe(kind === 'writer' ? 'dev-other already works in this directory' : 'dev-fix is working')
    expect(result.status).toBe('not_sent')
    expect(selected).toBe(0)
    expect(w.calls.every(c => c[2] === 'list')).toBe(true)
  }
})

test('a foreign shared analyst does not block dispatch or trigger the local fallback', async () => {
  for (const foreignName of ['analyst', effectiveName('analyst', 'w2')!]) {
    const w = fakeRun([agents([{ name: foreignName, workspace_id: 'w2', pane_id: 'foreign', agent_status: 'working' }]),
      [['herdr', 'tab', 'create'], ok({ root_pane: { pane_id: 'local' } })], [['herdr', 'agent', 'start'], ok({})], [['herdr', 'agent', 'prompt'], ok({})]])
    expect(await deliver(w.run, input({ analystSlug: 'fix' }))).toMatchObject({ agent: 'analyst', effectiveAgent: 'n1r', pane: 'local', status: 'confirmed' })
    expect(w.calls.find(call => call[2] === 'create')).toContain('codex - fix')
    expect(w.calls.some(call => call.includes('foreign') || call[2] === 'get')).toBe(false)
  }
})

test('equal logical names in distinct workspaces start distinct global Herdr agents', async () => {
  for (const name of ['analyst', 'architect', 'dev-fix', 'architect-fix', 'analyst-fix']) {
    const list: { name: string; workspace_id: string; pane_id: string; agent_status: string }[] = []
    const w = fakeRun([
      [['herdr', 'agent', 'list'], () => ok({ agents: [...list] })],
      [['herdr', 'tab', 'create'], argv => ok({ root_pane: { pane_id: `${argv[argv.indexOf('--workspace') + 1]}:worker` } })],
      [['herdr', 'agent', 'start'], argv => {
        expect(list.some(agent => agent.name === argv[3])).toBe(false)
        const pane = argv[argv.indexOf('--pane') + 1]!
        list.push({ name: argv[3]!, workspace_id: pane.split(':')[0]!, pane_id: pane, agent_status: 'working' })
        return ok({})
      }], [['herdr', 'agent', 'prompt'], ok({})],
    ])
    for (const workspace of ['w6F', 'w6f']) {
      expect((await deliver(w.run, input({ name, workspace, writes: name.startsWith('dev-') }))).status).toBe('confirmed')
    }
    expect(list).toHaveLength(2)
    expect(list[0]!.name).not.toBe(list[1]!.name)
    expect(w.calls.some(call => call[2] === 'split')).toBe(false)
  }
})

test('foreign developers do not affect writer cwd reviewer or fallback pane checks', async () => {
  for (const status of ['working', 'blocked']) {
    const foreign = [
      { name: effectiveName('dev-fix', 'w2'), workspace_id: 'w2', pane_id: 'foreign', cwd: '/other', agent_status: status },
      { name: effectiveName('dev-other', 'w2'), workspace_id: 'w2', pane_id: 'other', cwd: '/r', agent_status: status },
      { name: effectiveName('analyst-fix', 'w2'), workspace_id: 'w2', pane_id: 'fallback', agent_status: 'done' },
    ]
    for (const name of ['dev-fix', 'architect-fix', 'analyst']) {
      const w = fakeRun([agents([...foreign, { name: effectiveName('analyst', 'w1'), pane_id: 'home', agent_status: 'working' }]),
        [['herdr', 'tab', 'create'], ok({ root_pane: { pane_id: 'local' } })], [['herdr', 'agent', 'start'], ok({})], [['herdr', 'agent', 'prompt'], ok({})]])
      expect((await deliver(w.run, input({ name, writes: name === 'dev-fix', reviewDeveloper: name === 'architect-fix' ? 'dev-fix' : undefined, analystSlug: 'fix' }))).status).toBe('confirmed')
      expect(w.calls.find(call => call[2] === 'create')).toContain('codex - fix')
      expect(w.calls.some(call => call[2] === 'split')).toBe(false)
    }
  }
})

test('a name collision discovered at startup never sends a prompt', async () => {
  const w = fakeRun([agents([]), [['herdr', 'tab', 'create'], ok({ root_pane: { pane_id: 'local' } })], [['herdr', 'agent', 'start'], fail('agent_name_taken')]])
  expect(await deliver(w.run, input())).toMatchObject({ agent: 'analyst', effectiveAgent: 'n1r', status: 'not_sent', reason: 'agent_name_taken' })
  expect(w.calls.some(call => call[2] === 'prompt')).toBe(false)
})

test('every shared and named agent tab uses exactly codex dash and the main task slug', async () => {
  for (const slug of ['main-task', 'a'.repeat(22)]) {
    for (const name of ['analyst', 'architect', `dev-${slug}`, `architect-${slug}`, `analyst-${slug}`]) {
      const w = fakeRun([agents([]),
        [['herdr', 'tab', 'create'], ok({ root_pane: { pane_id: 'local' } })],
        [['herdr', 'agent', 'start'], ok({})], [['herdr', 'agent', 'prompt'], ok({})]])
      expect((await deliver(w.run, input({ name, slug, writes: name.startsWith('dev-') }))).status).toBe('confirmed')
      const tab = w.calls.find(call => call[2] === 'create')!
      expect(tab[tab.indexOf('--label') + 1]).toBe(`codex - ${slug}`)
      expect(tab).toContain('--no-focus')
    }
  }
})

test('a typed startup refusal returns not_sent before any pane start or prompt', async () => {
  const w = fakeRun([agents([])])
  let recorded = false
  const reason = 'codex-team: Astra is not allowed by the plugin configuration; nothing was started.'
  expect(await deliver(w.run, input({ startArgs: async () => ({ refusal: reason }), beforeSend: async () => { recorded = true } })))
    .toMatchObject({ status: 'not_sent', reason, started: false, existed: false })
  expect(w.calls).toEqual([['herdr', 'agent', 'list']])
  expect(recorded).toBe(false)
})

test('the pane shows the logical name with the started model and effort, and a refused rename changes nothing', async () => {
  expect(paneLabel('dev-fix', ['-m', 'gpt-5.5-sol', '-c', 'model_reasoning_effort="high"', '-c', 'service_tier="priority"'])).toBe('dev-fix (gpt-5.5-sol/high)')
  expect(paneLabel('analyst', ['-m', 'm'])).toBe('analyst')
  const { run, calls } = fakeRun([agents([]), [['herdr', 'tab', 'create'], ok({ root_pane: { pane_id: 'w1:p9' } })], [['herdr', 'agent', 'start'], ok({})], [['herdr', 'pane', 'rename'], { exitCode: 1, stdout: '', stderr: 'no' }], [['herdr', 'agent', 'prompt'], ok({})]])
  expect((await deliver(run, input())).status).toBe('confirmed')
  expect(verbs(calls)).toEqual(['agent list', 'tab create', 'agent start', 'pane rename', 'agent prompt'])
})
