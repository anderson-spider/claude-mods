import { expect, test } from 'claude-code/testing'
import { dispatchWorld, id, started, world } from './host'
import { JEV_MODEL } from '../hooks/effort'

const DISPATCH = id('dispatch')

test('session start registers the dispatch tool with its role, task, slug, cwd and effort', async ($, on) => {
  const { tools } = world(on)

  expect(await started($, tools)).toEqual(['dispatch'])
  const schema = tools[0]?.inputSchema as unknown as { properties: Record<string, unknown>; required: readonly string[] }
  expect(Object.keys(schema.properties).sort()).toEqual(['cwd', 'effort', 'role', 'slug', 'task'])
  expect([...schema.required].sort()).toEqual(['role', 'slug', 'task'])
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
