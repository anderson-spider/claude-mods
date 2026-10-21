import { expect, test } from 'claude-code/testing'
import type { SessionHudPanelAgent } from '../../types'
import { TIMELINE_MS, TOOLS_KEPT, ZERO, agentEnded, agentStepped, capped, endingsOf, mainStepped, mainTurned, resumed, spawned, toolUsed, usageOf } from '../../hooks/panel/agents'

const USAGE = { model: 'claude-opus-5-5', input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 900, cache_creation_input_tokens: 90 }
const one = (over: Partial<SessionHudPanelAgent> = {}): SessionHudPanelAgent[] => [{ id: 'a1', type: 'Explore', status: 'running', startedAt: 0, usage: ZERO, requests: 0, ...over }]

test('a spawn of any agent type runs; a step names the model that answered, its effort, tokens and context, and adds no agent', () => {
  const list = spawned([], { agentId: 'a1', type: 'my-agent', model: 'claude-sonnet-5-5', now: 5 })
  expect(list).toEqual([{ id: 'a1', type: 'my-agent', model: 'claude-sonnet-5-5', status: 'running', startedAt: 5, usage: ZERO, requests: 0 }])
  expect(spawned(list, { agentId: 'a1', type: 'other', now: 9 })).toBe(list)
  const stepped = agentStepped(list, 'a1', { model: 'claude-sonnet-5-5', effort: 'high', usage: USAGE })
  expect(stepped[0]).toMatchObject({ model: 'claude-opus-5-5', effort: 'high', requests: 1, contextTokens: 1_000, usage: { input: 10, output: 5, cacheRead: 900, cacheWrite: 90 } })
  expect(agentStepped(stepped, 'nobody', { usage: USAGE })).toBe(stepped)
})

test('usage with a count that is not a non-negative number adds nothing, and an absent count is zero', () => {
  expect(usageOf({ input_tokens: -1 })).toBeNull()
  expect(usageOf({ output_tokens: Number.NaN })).toBeNull()
  expect(usageOf('junk')).toBeNull()
  expect(usageOf({ input_tokens: 3 })).toEqual({ ...ZERO, input: 3 })
})

test('a tool call keeps the latest tools by name, an MCP tool by its own name, and counts calls and failures', () => {
  let list = one()
  for (const tool of ['Read', 'Grep', 'mcp__gitlab__gitlab_mr', 'Bash']) list = toolUsed(list, 'a1', tool, tool === 'Bash')
  expect(list[0]!.activity).toEqual({ tools: ['Grep', 'gitlab_mr', 'Bash'], calls: 4, errors: 1 })
  expect(TOOLS_KEPT).toBe(3)
  const ended = agentEnded(list, 'a1', 'answer', 9)
  expect(toolUsed(ended, 'a1', 'Read', false)).toBe(ended)
})

test('an answer is done, an abort cancelled and anything else failed with its reason; usage no step reported comes from the end', () => {
  expect(agentEnded(one(), 'a1', 'answer', 9)[0]).toMatchObject({ status: 'done', endedAt: 9 })
  expect(agentEnded(one(), 'a1', 'aborted', 9)[0]).toMatchObject({ status: 'cancelled' })
  expect(agentEnded(one(), 'a1', 'max_tokens', 9)[0]).toMatchObject({ status: 'failed', endReason: 'max_tokens' })
  const ended = agentEnded(one(), 'a1', 'answer', 9, USAGE)[0]!
  expect(ended.usage.output).toBe(5)
  expect(ended.contextTokens).toBeUndefined()
  const again = resumed([ended], 'a1')[0]!
  expect(again).toMatchObject({ status: 'running', usage: ended.usage })
  expect(again.endedAt).toBeUndefined()
})

test("the host's list ends the agents it shows stopped; one it does not list ends, aborted, only after a reload or a restore", () => {
  const list = [...one(), ...one({ id: 'a2' }), ...one({ id: 'a3' }), ...one({ id: 'a4', status: 'done' })]
  const host = [{ id: 'a1', status: 'completed' }, { id: 'a2', status: 'running' }, { id: 'a4', status: 'killed' }]
  expect(endingsOf(list, host)).toEqual([{ agentId: 'a1', reason: 'answer' }])
  expect(endingsOf(list, host, true)).toEqual([{ agentId: 'a1', reason: 'answer' }, { agentId: 'a3', reason: 'aborted' }])
  expect(endingsOf(one(), [{ id: 'a1', status: 'failed' }])).toEqual([{ agentId: 'a1', reason: 'error' }])
})

test('the list keeps at most its limit, dropping the oldest finished agents and never a running one', () => {
  const list = [...one({ id: 'old', status: 'done' }), ...one({ id: 'run' }), ...one({ id: 'new', status: 'failed' })]
  expect(capped(list, 2).map(a => a.id)).toEqual(['run', 'new'])
  expect(capped(list, 1).map(a => a.id)).toEqual(['run'])
})

test('the main session adds its tokens, and its turns of the last 15 minutes are kept as spans', () => {
  const main = mainStepped({ usage: ZERO, turns: [] }, USAGE)
  expect(main.usage).toEqual({ input: 10, output: 5, cacheRead: 900, cacheWrite: 90 })
  const now = 2 * TIMELINE_MS
  const turned = mainTurned({ ...main, turns: [[0, 1], [now - 60_000, now - 30_000]] }, now, 5_000)
  expect(turned.turns).toEqual([[now - 60_000, now - 30_000], [now - 5_000, now]])
  expect(mainTurned(main, now, 'junk')).toBe(main)
})
