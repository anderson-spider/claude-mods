import { expect, test } from 'claude-code/testing'
import { call, started, world } from './host'
import { SPECS } from '../hooks/roles'
import { BASE_REF, EMPTY, PINS } from '../hooks/register'

function dispatched(on: Parameters<typeof world>[0]) {
  const received: Record<string, unknown>[] = []
  on('tool.call', { tool: 'Agent' }, (_$, e) => { received.push(e as never); return { result: 'native answer' } as never })
  return received
}

test('session start registers the four native agents and no tools', async ($, on) => {
  const h = world(on); await started($)
  expect(h.specs.map(s => s.name)).toEqual(['analyst', 'developer', 'reviewer', 'architect'])
  for (const spec of h.specs) expect(spec).toEqual(SPECS[spec.name as keyof typeof SPECS])
})
test('Jev picks the pair for a Spider role, shown in its description, and other agents pass untouched', async ($, on) => {
  const h = world(on), received = dispatched(on); h.env.JEV_API_KEY = 'test-key'
  await started($)
  expect(await $.tool.call(call() as never)).toHaveProperty('result', 'native answer')
  expect(received[0]).toMatchObject({ prompt: 'Private task', description: 'Fixture (haiku/low)', model: 'haiku', effort: 'low' })
  expect(h.requests).toHaveLength(1)
  const other = call('x', { subagent_type: 'Explore', model: 'fable', effort: 'max' })
  await $.tool.call(other as never); expect(received[1]).toEqual(other); expect(h.requests).toHaveLength(1)
})
test('without a key the role default applies and pins skip Jev with effort capped at high', async ($, on) => {
  const h = world(on), received = dispatched(on); await started($)
  await $.tool.call(call('architect') as never)
  expect(received[0]).toMatchObject({ model: 'opus', effort: 'high' })
  h.env.JEV_API_KEY = 'test-key'
  await $.tool.call(call('analyst', { model: 'opus', effort: 'max' }) as never)
  expect(received[1]).toMatchObject({ model: 'opus', effort: 'high' })
  await $.tool.call(call('analyst', { prompt: 'Private task @sonnet-high' }) as never)
  expect(received[2]).toMatchObject({ model: 'sonnet', effort: 'high' }); expect(String(received[2]!.prompt).trim()).toBe('Private task')
  expect(h.requests).toHaveLength(0)
})
test('invalid pins, empty tasks and a developer without baseRef head are refused before dispatch', async ($, on) => {
  const h = world(on), received = dispatched(on); await started($)
  expect((await $.tool.call(call('analyst', { model: 'fable' }) as never)).deny).toBe(PINS)
  expect((await $.tool.call(call('analyst', { prompt: '@haiku-low' }) as never)).deny).toBe(EMPTY)
  h.io.baseRef = 'main'
  expect((await $.tool.call(call('developer') as never)).deny).toBe(BASE_REF)
  expect(received).toHaveLength(0)
  h.io.baseRef = 'head'
  await $.tool.call(call('developer') as never)
  expect(received[0]).toMatchObject({ model: 'sonnet', effort: 'medium' }); expect(received[0]).not.toHaveProperty('isolation')
})
test('a routing failure dispatches the call unchanged once', async ($, on) => {
  const h = world(on), received = dispatched(on); await started($)
  Object.defineProperty(h.io, 'root', { get: () => { throw new Error('root unavailable') } })
  const e = call('reviewer')
  expect(await $.tool.call(e as never)).toHaveProperty('result', 'native answer')
  expect(received).toEqual([e])
})
