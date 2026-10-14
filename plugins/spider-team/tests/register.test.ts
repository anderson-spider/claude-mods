import { expect, test } from 'claude-code/testing'
import { call, drain, inference, spawn, started, step, world } from './host'
import { SPECS } from '../hooks/roles'
import { BASE_REF, EMPTY } from '../hooks/register'

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
test('a model or effort from the lead is overwritten by the Jev pair, or by the role default without a key', async ($, on) => {
  const h = world(on), received = dispatched(on); await started($)
  await $.tool.call(call('architect', { model: 'fable', effort: 'max' }) as never)
  expect(received[0]).toMatchObject({ model: 'opus', effort: 'medium', description: 'Fixture (opus/medium)' })
  await $.tool.call(call('analyst', { model: 'gpt', effort: 'ultra' }) as never)
  expect(received[1]).toMatchObject({ model: 'sonnet', effort: 'medium' })
  expect(h.requests).toHaveLength(0)
  h.env.JEV_API_KEY = 'test-key'
  // Difficulty 0 and duration 0 are haiku/low whatever the lead asked for.
  await $.tool.call(call('analyst', { model: 'fable', effort: 'max' }) as never)
  expect(received[2]).toMatchObject({ model: 'haiku', effort: 'low', description: 'Fixture (haiku/low)' })
  await $.tool.call(call('developer', { model: 'opus' }) as never)
  expect(received[3]).toMatchObject({ model: 'haiku', effort: 'low' })
  expect(h.requests).toHaveLength(2)
})
test('Jev is asked both questions and bang and at-sign words reach it as written', async ($, on) => {
  const h = world(on), received = dispatched(on); h.env.JEV_API_KEY = 'test-key'
  h.answers.difficulty = { probabilities: { '3': 1 } }; h.answers.duration = { probabilities: { '2': 1 } }
  await started($)
  const prompt = 'Private task !hard !quick !long !difficulty=0 !duration=3 !bogus=9 @sonnet-high @opus'
  await $.tool.call(call('analyst', { prompt }) as never)
  expect(received[0]).toMatchObject({ prompt, model: 'opus', effort: 'medium' })
  const request = JSON.parse(h.requests[0]!.body)
  expect(Object.keys(request.questions)).toEqual(['difficulty', 'duration'])
  expect(request.state).toBe(prompt)
  expect(h.requests).toHaveLength(1)
})
// Regression: a marketplace install names the provider spider-team@<marketplace>, and an identity check on the
// spawn and the subagent's turns once refused every default spawn. Run that native path under that provider.
test('a default spawn of every role from a marketplace install runs natively with its role default', async ($, on) => {
  const h = world(on), received: Record<string, unknown>[] = [], answers: string[] = []
  on('turn.step', inference)
  on('agent.spawn', async (_$, e) => {
    answers.push((await drain($.turn.step(step(e.tool_use_id, e.model as string, 'medium') as never) as never)).answer)
    return { agentId: e.tool_use_id, model: e.model as string }
  })
  on('tool.call', { tool: 'Agent' }, async (_$, e) => {
    const c = e as unknown as { tool_use_id: string; subagent_type: string; model: string }
    received.push(e as never)
    await $.agent.spawn(spawn(c.tool_use_id, c.subagent_type, c.model) as never)
    return { result: 'native answer' } as never
  })
  await started($)
  const roles = ['analyst', 'developer', 'reviewer', 'architect'] as const
  for (const role of roles) {
    const answer = await $.tool.call(call(role, { tool_use_id: role }) as never)
    expect(answer).not.toHaveProperty('deny'); expect(answer).toHaveProperty('result', 'native answer')
  }
  expect(answers).toEqual(roles.map(() => 'native answer'))
  expect(received.map(r => [r.subagent_type, r.model, r.effort])).toEqual([['spider-team:analyst', 'sonnet', 'medium'], ['spider-team:developer', 'sonnet', 'high'], ['spider-team:reviewer', 'opus', 'low'], ['spider-team:architect', 'opus', 'medium']])
  expect(h.requests).toHaveLength(0)
})
test('empty tasks and a developer without baseRef head are refused before dispatch', async ($, on) => {
  const h = world(on), received = dispatched(on); await started($)
  for (const prompt of ['', ' \n\t ']) expect((await $.tool.call(call('analyst', { prompt }) as never)).deny).toBe(EMPTY)
  h.io.baseRef = 'main'
  expect((await $.tool.call(call('developer') as never)).deny).toBe(BASE_REF)
  expect(received).toHaveLength(0)
  h.io.baseRef = 'head'
  await $.tool.call(call('developer') as never)
  expect(received[0]).toMatchObject({ model: 'sonnet', effort: 'high' }); expect(received[0]).not.toHaveProperty('isolation')
})
test('a routing failure dispatches the call unchanged once', async ($, on) => {
  const h = world(on), received = dispatched(on); await started($)
  Object.defineProperty(h.io, 'root', { get: () => { throw new Error('root unavailable') } })
  const e = call('reviewer')
  expect(await $.tool.call(e as never)).toHaveProperty('result', 'native answer')
  expect(received).toEqual([e])
})
