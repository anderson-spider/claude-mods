import { expect, test } from 'claude-code/testing'
import { type McpSpec, mcpBackend } from '../hooks/mcp-backend'
import { fakeDeps, fakeMcp } from './mcp-helpers'

// A made-up backend whose tab ids are numbers: the factory, not the spec, owns the prefix and the allow.
const FOX: McpSpec = {
  name: 'Fox',
  server: 'fox-server',
  hint: 'start the fox',
  idPrefix: 'fox:',
  listing: ['list_tabs', 'make_tab'],
  tabArg: id => Number(id),
  tabs: async call => (JSON.parse(await call('list_tabs', {})) as number[]).map(String),
  openTab: async (call, url) => {
    const made = String(await call('make_tab', { url }))
    return made.trim()
  },
}

const fox = mcpBackend(FOX)

test('a backend keeps the name, server and hint of its spec', () => {
  expect(fox).toMatchObject({ name: 'Fox', server: 'fox-server', hint: 'start the fox' })
})

test('opening probes the tabs once, and the Browser names them with the spec prefix', async () => {
  const { call, calls } = fakeMcp({ list_tabs: '[4,9]' })
  const browser = await fox.open(fakeDeps(call).deps)

  expect(calls.map(c => c.tool)).toEqual(['list_tabs'])
  expect(await browser.tabs()).toEqual(['fox:4', 'fox:9'])
})

test('a backend that cannot list its tabs is unavailable, with the reason the spec threw', async () => {
  const { call } = fakeMcp({})
  expect(String(await fox.open(fakeDeps(call).deps).catch(e => e))).toContain('no answer for list_tabs')
})

test('openTab returns the id the spec opened under the prefix', async () => {
  const { call, calls } = fakeMcp({ list_tabs: '[]', make_tab: ' 12 ' })
  const browser = await fox.open(fakeDeps(call).deps)

  expect(await browser.openTab('https://chatgpt.com/')).toBe('fox:12')
  expect(calls.at(-1)).toEqual({ tool: 'make_tab', args: { url: 'https://chatgpt.com/' } })
})

test('scripts run through javascript_tool in the tab the spec names, from the plugin id without its prefix', async () => {
  const { call, calls } = fakeMcp({ list_tabs: '[]', javascript_tool: '"ok"' })
  const browser = await fox.open(fakeDeps(call).deps)

  expect(await browser.js('fox:12', 'return 1')).toBe(JSON.stringify('ok'))
  const script = calls.at(-1)!
  expect(script.tool).toBe('javascript_tool')
  expect(script.args).toMatchObject({ action: 'javascript_exec', tabId: 12 })
})

test('the allow keeps to the spec: its listing tools, and a script only in a tab with its prefix', () => {
  const script = { action: 'javascript_exec', tabId: 12, text: '1' }
  expect(fox.stays('list_tabs', {}, undefined)).toBe(true)
  expect(fox.stays('make_tab', {}, undefined)).toBe(true)
  expect(fox.stays('tabs_context', {}, undefined)).toBe(false)
  expect(fox.stays('navigate', { url: 'https://chatgpt.com/' }, undefined)).toBe(true)
  expect(fox.stays('javascript_tool', script, 'fox:12')).toBe(true)
  expect(fox.stays('javascript_tool', script, 'fox:13')).toBe(false)
  expect(fox.stays('javascript_tool', script, 'chrome:12')).toBe(false)
  // A prefix of the same length would slice to the same id: the prefix itself decides, not the length.
  expect(fox.stays('javascript_tool', script, 'cat:12')).toBe(false)
  expect(fox.stays('javascript_tool', script, undefined)).toBe(false)
})
