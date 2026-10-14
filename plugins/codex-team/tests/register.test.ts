import { effectiveName } from '../hooks/names'
import { expect, test } from 'claude-code/testing'
import { dispatchWorld, id, planWorld, started, world } from './host'
import { JEV_MODEL } from '../hooks/effort'
import { fakeRun, ok } from './fake-run'

const DISPATCH = id('dispatch')

test('session start registers dispatch and finish with their typed input schemas', async ($, on) => {
  const { tools } = world(on)

  expect(await started($, tools)).toEqual(['dispatch', 'finish'])
  const schema = tools[0]?.inputSchema as unknown as { properties: Record<string, unknown>; required: readonly string[] }
  expect(Object.keys(schema.properties).sort()).toEqual(['cwd', 'effort', 'role', 'slug', 'task'])
  expect([...schema.required].sort()).toEqual(['role', 'slug'])
  expect(tools[1]?.inputSchema).toMatchObject({ type: 'object', properties: { agent: { type: 'string' } }, required: ['agent'] })
})

test('finish closes and archives through the host and logs only lifecycle metadata', async ($, on) => {
  const uuid = '12345678-1234-1234-1234-123456789abc'
  const agent = { name: effectiveName('analyst', 'w1')!, agent: 'codex', workspace_id: 'w1', pane_id: 'worker', agent_status: 'done', agent_session: { kind: 'id', source: 'herdr:codex', value: uuid } }
  let lists = 0
  const fake = fakeRun([
    [['herdr', 'agent', 'get'], ok({ agent })],
    [['herdr', 'agent', 'list'], () => ok({ agents: ++lists === 1 ? [agent] : [] })],
    [['herdr', 'pane', 'close'], ok({})], [['codex', 'archive'], ok({})],
  ])
  const w = dispatchWorld(on, 'test-key', undefined, fake.run)
  await started($, w.tools)
  const answer = await $.tool.call({ tool: id('finish'), agent: 'analyst' } as never)
  expect(answer.result).toContain('closed: pane worker')
  expect(answer.result).toContain('archived: yes')
  expect(fake.calls[fake.calls.length - 1]).toEqual(['codex', 'archive', uuid])
  expect(JSON.parse(w.writes[0]!)).toMatchObject({ action: 'finish', agent: 'analyst', uuid, closed: true, archived: true })
  expect(w.requests).toEqual([])
  expect(w.settings).toEqual([])
  expect(w.envReads).toContain('HERDR_PANE_ID')
})

test('outside Herdr the tool call answers that the team cannot be used, through the host', async ($, on) => {
  const { tools } = world(on)
  on('env.get', () => ({ value: undefined }) as never)
  await started($, tools)

  const result = await $.tool.call({ tool: DISPATCH, role: 'analyst', task: 't', slug: 's' } as never)

  expect(result.result).toBe('codex-team can only be used inside a Herdr pane (HERDR_ENV=1); nothing was started.')
})

test('the host reads literal JEV_API_KEY, checks both settings sources and routes through fake HTTP', async ($, on) => {
  const key = ['test-', 'host', '-credential'].join('')
  const w = dispatchWorld(on, key)
  await started($, w.tools)
  const task = 'Read /Users/person/private/file.ts and person@example.com'
  const answer = await $.tool.call({ tool: DISPATCH, role: 'analyst', task, slug: 'host' } as never)
  expect(answer.result).toContain('effort low (jev)')
  expect(w.envReads).toContain('JEV_API_KEY')
  expect(w.settings).toEqual(['project', 'local'])
  expect(w.requests).toHaveLength(1)
  expect(w.requests[0]?.headers?.Authorization).toBe(`Bearer ${key}`)
  expect(JSON.parse(w.requests[0]!.body!)).toMatchObject({ model: JEV_MODEL, state: 'Read <path> and <email>' })
  expect(w.calls.find(c => c[2] === 'start')).toContain('model_reasoning_effort="low"')
  expect(JSON.stringify([w.writes, w.logs, answer])).not.toContain(key)
  expect(JSON.stringify([w.writes, w.logs, answer])).not.toContain(task)
})

for (const source of ['project', 'local'] as const) {
  test(`a ${source} JEV_API_KEY declaration disables Jev through the host without HTTP`, async ($, on) => {
    const w = dispatchWorld(on, ['test-', 'private', '-key'].join(''), source)
    await started($, w.tools)
    const answer = await $.tool.call({ tool: DISPATCH, role: 'analyst', task: 'inspect code', slug: 'host' } as never)
    expect(answer.result).toContain('effort medium (default)')
    expect(w.requests).toEqual([])
    expect(w.logs).toEqual(['codex-team: Jev off (repo-declared-key); using role default'])
  })
}

test('successful plan Write and Edit publish after the result and return the host result unchanged', async ($, on) => {
  world(on)
  const writes: string[] = [], calls: string[][] = [], order: string[] = []
  on('env.get', (_$, e) => ({ value: e.name === 'HERDR_ENV' ? '1' : undefined }))
  on('session.root', () => ({ value: '/repo' }))
  on('clock.now', () => ({ value: Date.parse('2026-10-13T20:00:00Z') }))
  on('fs.exists', (_$, e) => ({ value: !e.path.endsWith('times.json') }))
  on('fs.list', () => ({ value: [{ name: 'feature.md', kind: 'file', mtimeMs: 1, size: 1, isLink: false }] }))
  on('fs.read', (_$, e) => {
    if (e.path.endsWith('times.json')) throw new Error('missing')
    return { value: '## Steps\n### Feature\n- feature (main, after: —) Ship — state: verified (lead report)' }
  })
  on('fs.write', (_$, e) => { writes.push(e.path); return { value: undefined } })
  on('process.run', (_$, e) => {
    calls.push([...e.argv]); order.push('publish')
    const stdout = e.argv[0] === 'herdr' ? '{"result":{"agents":[]}}' : e.argv[1] === 'check' ? '[]' : ''
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  const receipt = { result: { saved: true }, text: 'host receipt', ref: 42 }
  on('tool.call', { tool: ['Write', 'Edit'] }, () => { order.push('tool'); return receipt as never })
  for (const tool of ['Write', 'Edit'] as const) {
    const result = await $.tool.call({ tool, file_path: '/repo/.crew/plans/feature.md', content: 'x', old_string: 'x', new_string: 'y' } as never)
    expect(result).toEqual(receipt)
  }
  expect(order[0]).toBe('tool')
  expect(writes.filter(path => path.endsWith('run.json.tmp'))).toHaveLength(2)
  expect(calls.filter(call => call[0] === 'mv')).toHaveLength(2)
})

test('failed plan writes and successful unrelated writes do not publish and preserve the result', async ($, on) => {
  world(on)
  let processes = 0
  on('session.root', () => ({ value: '/repo' }))
  on('process.run', () => { processes++; throw new Error('must not publish') })
  const failed = { result: 'failed', isError: true as const, text: 'unchanged' }
  on('tool.call', { tool: 'Write' }, (_$, e) => 'file_path' in e && e.file_path.includes('/plans/') ? failed : { result: 'saved' })
  expect(await $.tool.call({ tool: 'Write', file_path: '/repo/.crew/plans/a.md', content: 'x' } as never)).toEqual(failed)
  expect(await $.tool.call({ tool: 'Write', file_path: '/repo/README.md', content: 'x' } as never)).toEqual({ result: 'saved' })
  expect(processes).toBe(0)
})

test('Bash plan edits in the main session and subagents publish once after the result without inspecting the command', async ($, on) => {
  const w = planWorld(on)
  const receipt = { result: { exitCode: 0 }, text: 'shell receipt', ref: 42 }
  let returned = false
  on('tool.call', { tool: 'Bash' }, () => {
    expect(w.calls.filter(c => c[0] === 'mv')).toHaveLength(returned ? 2 : 1)
    w.entry.mtimeMs++
    w.files.set('/repo/.crew/plans/feature.md', '## Steps\n### Feature\n- feature (main, after: —) Ship — state: committed (PR opened)')
    returned = true
    return receipt as never
  })
  await $.tool.call({ tool: 'Write', file_path: '/repo/.crew/plans/feature.md', content: 'baseline' } as never)
  for (const agentId of [undefined, 'git-master']) {
    const before = w.calls.filter(c => c[0] === 'mv').length
    expect(await $.tool.call({ tool: 'Bash', command: 'arbitrary shell command', agentId } as never)).toEqual(receipt)
    expect(w.calls.filter(c => c[0] === 'mv')).toHaveLength(before + 1)
    expect(JSON.parse(w.files.get('/repo/.dagr/run.json')!).tasks[0].state).toBe('done')
  }
  expect(w.logs).toEqual([])
})

test('Bash with an unchanged plan returns the result with one listing and no reads or publication', async ($, on) => {
  const w = planWorld(on)
  const receipt = { result: 'unchanged', text: 'host receipt', ref: 7 }
  on('tool.call', { tool: 'Bash' }, () => receipt as never)
  await $.tool.call({ tool: 'Write', file_path: '/repo/.crew/plans/feature.md', content: 'baseline' } as never)
  w.writes.length = w.calls.length = w.lists.length = w.reads.length = 0
  expect(await $.tool.call({ tool: 'Bash', command: 'echo unchanged' } as never)).toEqual(receipt)
  expect(w.lists).toEqual(['/repo/.crew/plans'])
  expect(w.reads).toEqual([])
  expect(w.calls).toEqual([])
  expect(w.writes).toEqual([])
  expect(w.logs).toEqual([])
})

test('Bash observation and publication failures preserve its result and the old run with one debug line', async ($, on) => {
  const w = planWorld(on)
  const receipt = { result: 'shell failed after an edit', isError: true as const, text: 'unchanged', ref: 23 }
  on('tool.call', { tool: 'Bash' }, () => {
    w.entry.mtimeMs++
    w.files.set('/repo/.crew/plans/feature.md', '## Steps\n### Feature\n- feature (main, after: —) Ship — state: verified (report)')
    return receipt as never
  })
  await $.tool.call({ tool: 'Write', file_path: '/repo/.crew/plans/feature.md', content: 'baseline' } as never)
  const oldRun = w.files.get('/repo/.dagr/run.json')
  for (const at of ['root', 'list', 'write', 'check', 'move'] as const) {
    w.faults.at = at
    w.logs.length = 0
    expect(await $.tool.call({ tool: 'Bash', command: 'partial edit; exit 1', agentId: 'git-master' } as never)).toEqual(receipt)
    expect(w.files.get('/repo/.dagr/run.json')).toBe(oldRun)
    expect(w.logs).toHaveLength(1)
  }
  w.faults.at = undefined
  w.logs.length = 0
  expect(await $.tool.call({ tool: 'Bash', command: 'partial edit; exit 1' } as never)).toEqual(receipt)
  expect(w.logs).toEqual([])
  expect(w.files.get('/repo/.dagr/run.json')).not.toBe(oldRun)
})

test('a debug logging failure cannot throw into the observed Bash result', async ($, on) => {
  const w = planWorld(on)
  w.faults.at = 'root'
  w.faults.log = true
  const receipt = { result: 'shell receipt', ref: 99 }
  on('tool.call', { tool: 'Bash' }, () => receipt as never)
  expect(await $.tool.call({ tool: 'Bash', command: 'echo ok' } as never)).toEqual(receipt)
  expect(w.logs).toEqual(['codex-team: dagr plan observation failed'])
})
