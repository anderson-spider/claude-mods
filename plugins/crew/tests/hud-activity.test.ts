import { expect, test } from 'claude-code/testing'
import { KEEP_ENDED, noteTool, planStepOf, TOOL_NOTES, tokensOf, toolName, trimEnded } from '../hooks/hud/activity'
import type { CrewAgent } from '../types'

const agent = (id: string, status: 'running' | 'ended', endedAt?: number): CrewAgent =>
  ({ id, type: 'crew:digger', model: 'haiku', status, ...(endedAt === undefined ? {} : { endedAt }) })

test('a tool name is kept from the fixed set, an MCP tool is mcp and anything else is ?', () => {
  expect(['Read', 'Grep', 'Bash', 'SubagentHandback'].map(toolName)).toEqual(['Read', 'Grep', 'Bash', 'SubagentHandback'])
  expect(toolName('mcp__github__create_issue')).toBe('mcp')
  expect(toolName('rm -rf /Users/private')).toBe('?')
  expect(toolName('mcp__')).toBe('mcp')
  expect(toolName(undefined)).toBe('?')
  expect(toolName(7)).toBe('?')
})

test('the plan step is the first word of the description when it is a step id, and nothing else of the text', () => {
  expect(planStepOf('T3 contract suite')).toBe('T3')
  expect(planStepOf('  A4 grep the callers')).toBe('A4')
  expect(planStepOf('T3b follow up')).toBe('T3b')
  expect(planStepOf('audit auth')).toBeUndefined()
  expect(planStepOf('T3: contract suite')).toBeUndefined()
  expect(planStepOf('/Users/private/T3')).toBeUndefined()
  expect(planStepOf('')).toBeUndefined()
  expect(planStepOf(undefined)).toBeUndefined()
})

test('the last three calls are kept, newest last, with a name from the set', () => {
  let notes = noteTool(undefined, 'Grep', false)
  for (const raw of ['Read', 'Bash', 'mcp__x__y']) notes = noteTool(notes, raw, raw === 'Bash')
  expect(TOOL_NOTES).toBe(3)
  expect(notes).toEqual([{ name: 'Read', failed: false }, { name: 'Bash', failed: true }, { name: 'mcp', failed: false }])
})

test('tokens: the context is the whole input of the step and the output is the step output; bad numbers count as zero', () => {
  expect(tokensOf({ input_tokens: 100, cache_read_input_tokens: 5_000, cache_creation_input_tokens: 40, output_tokens: 12 }))
    .toEqual({ inTokens: 5_140, outTokens: 12 })
  expect(tokensOf({ input_tokens: -1, output_tokens: Number.NaN, cache_read_input_tokens: '9' })).toEqual({ inTokens: 0, outTokens: 0 })
})

test('trimming drops the oldest ended agents past the cap and never a running one', () => {
  const list: CrewAgent[] = [agent('run', 'running')]
  for (let i = 0; i < KEEP_ENDED + 3; i++) list.push(agent(`e${i}`, 'ended', 1_000 + i))
  const kept = trimEnded(list)
  expect(kept).toHaveLength(KEEP_ENDED + 1)
  expect(kept.map(a => a.id)).toContain('run')
  expect(kept.map(a => a.id)).not.toContain('e0')
  expect(kept.map(a => a.id)).toContain(`e${KEEP_ENDED + 2}`)
  expect(trimEnded(list, 100)).toEqual(list)
})
