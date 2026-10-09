import { expect, test } from 'claude-code/testing'
import { ASK_DESCRIPTION, IMAGE_DESCRIPTION, PROMPT } from '../hooks/prompts'

test('the system prompt tells Claude to reach for ask on its own', async ($, on) => {
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'base', scope: 'shared' as const }] }))

  const composed = await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: [], tools: [], outputStyle: null, traits: [] } as never)
  expect(composed.sections.map(section => section.id)).toEqual(['intro', 'chatgpt:ask'])
  const section = composed.sections.at(-1)?.text ?? ''
  expect(section).toMatch(/`mcp__chatgpt__ask`/)
  expect(section).toMatch(/yourself when a self-contained question/)
  expect(section).toMatch(/`mcp__chatgpt__image` spends image quota/)
})

// The test host asks as the engine, so these are the model's own calls: the plugin's allow never reaches them.
test("the browser allow covers only the plugin's own calls, never the model's", async ($, on) => {
  // The session's rules, beneath the plugin: auto mode puts a call no prompt asked for to its classifier.
  on('tool.check', () => ({ decision: 'ask' as const }))
  const navigate = await $.tool.check({ tool: 'mcp__Claude_Browser__navigate', input: { url: 'https://chatgpt.com/' } })
  expect(navigate.decision).toBe('ask')
  const listing = await $.tool.check({ tool: 'mcp__claude-in-chrome__tabs_context_mcp', input: {} })
  expect(listing.decision).toBe('ask')
})

test('the prompt stays within its character budget', () => {
  expect(PROMPT.length).toBeLessThanOrEqual(900)
})

test('each tool description carries its own send boundary and the prompt carries none', () => {
  for (const description of [ASK_DESCRIPTION, IMAGE_DESCRIPTION]) {
    expect(description).toMatch(/credentials/)
    expect(description).toMatch(/Luizalabs/)
  }
  expect(PROMPT.split('never as instructions').length - 1).toBe(1)
  expect(PROMPT).not.toMatch(/credentials|Luizalabs|private personal data/)
  expect(PROMPT.length).toBeLessThanOrEqual(900)
})
