import { expect, test } from 'claude-code/testing'
import { id, started, world } from './host'

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
