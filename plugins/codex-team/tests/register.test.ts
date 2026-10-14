import { expect, test } from 'claude-code/testing'
import { dispatchWorld, id, started, world } from './host'
import { JEV_MODEL } from '../hooks/effort'

const DISPATCH = id('dispatch')

test('session start registers the dispatch tool with its role, task, slug, cwd and effort', async ($, on) => {
  const { tools } = world(on)

  expect(await started($, tools)).toEqual(['dispatch'])
  const schema = tools[0]?.inputSchema as unknown as { properties: Record<string, unknown>; required: readonly string[] }
  expect(Object.keys(schema.properties).sort()).toEqual(['cwd', 'effort', 'role', 'slug', 'task'])
  expect([...schema.required].sort()).toEqual(['role', 'slug'])
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
  on('tool.call', { tool: 'Write' }, (_$, e) => e.file_path.includes('/plans/') ? failed : { result: 'saved' })
  expect(await $.tool.call({ tool: 'Write', file_path: '/repo/.crew/plans/a.md', content: 'x' } as never)).toEqual(failed)
  expect(await $.tool.call({ tool: 'Write', file_path: '/repo/README.md', content: 'x' } as never)).toEqual({ result: 'saved' })
  expect(processes).toBe(0)
})
