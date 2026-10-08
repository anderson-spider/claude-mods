import { expect, test } from 'claude-code/testing'

test('the system prompt tells Claude to reach for ask on its own', async ($, on) => {
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'base', scope: 'shared' as const }] }))

  const composed = await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: [], tools: [], outputStyle: null, traits: [] } as never)
  expect(composed.sections.map(section => section.id)).toEqual(['intro', 'chatgpt:ask'])
  const section = composed.sections.at(-1)?.text ?? ''
  expect(section).toMatch(/`mcp__chatgpt__ask`/)
  expect(section).toMatch(/on your own, without being asked/)
  expect(section).toMatch(/Luizalabs/)
  expect(section).toMatch(/`mcp__chatgpt__image` spends the person's image quota/)
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
