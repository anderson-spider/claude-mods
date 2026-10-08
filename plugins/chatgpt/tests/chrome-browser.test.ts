import { expect, test } from 'claude-code/testing'
import { chromeBrowserOf } from '../hooks/chrome-browser'
import { parseOutput } from '../hooks/scripts'
import { fakeDeps, fakeMcp, withNote } from './mcp-helpers'

const tabList = (ids: number[]) => withNote({ availableTabs: ids.map(tabId => ({ tabId, title: 'ChatGPT', url: 'https://chatgpt.com/' })), tabGroupId: 1840516207 })

test('the Chrome tabs are the group tabs, as chrome:<number> ids', async () => {
  const { call } = fakeMcp({ tabs_context_mcp: tabList([2145352169, 2145352172]) })
  const { deps } = fakeDeps(call)
  const browser = await chromeBrowserOf(deps)
  expect(await browser.tabs()).toEqual(['chrome:2145352169', 'chrome:2145352172'])
})

test('a Chrome that cannot be reached, or prints no tab list, is unavailable', async () => {
  const unreachable = fakeDeps(fakeMcp({}).call).deps
  expect(String(await chromeBrowserOf(unreachable).catch(e => e))).toContain('no answer for tabs_context_mcp')
  const odd = fakeDeps(fakeMcp({ tabs_context_mcp: 'No tab group.' }).call).deps
  expect(String(await chromeBrowserOf(odd).catch(e => e))).toContain('unexpected output from tabs_context_mcp')
})

test('js returns the page text as a JSON string, so parseOutput reads the page result', async () => {
  const { call, calls } = fakeMcp({
    tabs_context_mcp: tabList([2145352169]),
    javascript_tool: `{"href":"https://chatgpt.com/"}\n\nTab Context:\n- Executed on tabId: 2145352169`,
  })
  const browser = await chromeBrowserOf(fakeDeps(call).deps)
  const out = await browser.js('chrome:2145352169', 'return JSON.stringify({ href: location.href })')
  expect(parseOutput<{ href: string }>(out)).toEqual({ href: 'https://chatgpt.com/' })
  expect(calls.at(-1)).toEqual({
    tool: 'javascript_tool',
    args: { action: 'javascript_exec', tabId: 2145352169, text: '(async () => {\nreturn JSON.stringify({ href: location.href })\n})()' },
  })
})

test('js decodes a result that the tool printed as a JSON string literal', async () => {
  const { call } = fakeMcp({
    tabs_context_mcp: tabList([1]),
    javascript_tool: '"{\\"ok\\":true}"\n\nTab Context:\n- Executed on tabId: 1',
  })
  const browser = await chromeBrowserOf(fakeDeps(call).deps)
  expect(parseOutput<{ ok: boolean }>(await browser.js('chrome:1', 'return JSON.stringify({ ok: true })'))).toEqual({ ok: true })
})

test('openTab creates a tab in the group, parses its id and navigates it', async () => {
  const { call, calls } = fakeMcp({
    tabs_context_mcp: tabList([2145352169]),
    tabs_create_mcp: 'Created new tab. Tab ID: 2145352172\n\nTab Context:\n- Available tabs:',
    navigate: 'Navigated to https://chatgpt.com/\n\nTab Context:\n- Available tabs:',
  })
  const browser = await chromeBrowserOf(fakeDeps(call).deps)
  expect(await browser.openTab('https://chatgpt.com/')).toBe('chrome:2145352172')
  expect(calls.slice(-2)).toEqual([
    { tool: 'tabs_create_mcp', args: {} },
    { tool: 'navigate', args: { url: 'https://chatgpt.com/', tabId: 2145352172 } },
  ])
})

test('probing lists the group without creating a tab', async () => {
  const { call, calls } = fakeMcp({ tabs_context_mcp: tabList([1]) })
  await chromeBrowserOf(fakeDeps(call).deps)
  expect(calls.filter(c => c.tool === 'tabs_context_mcp')).toEqual([{ tool: 'tabs_context_mcp', args: {} }])
})

test('an empty group still counts as available, with no tabs', async () => {
  const { call } = fakeMcp({ tabs_context_mcp: withNote({ availableTabs: [], tabGroupId: 9 }) })
  expect(await (await chromeBrowserOf(fakeDeps(call).deps)).tabs()).toEqual([])
})

test('openTab reuses a blank tab of the group instead of leaving another behind', async () => {
  const { call, calls } = fakeMcp({
    tabs_context_mcp: withNote({
      availableTabs: [
        { tabId: 5, title: 'New Tab', url: 'chrome://newtab/' },
        { tabId: 6, title: 'ChatGPT', url: 'https://chatgpt.com/' },
      ],
      tabGroupId: 9,
    }),
    navigate: 'Navigated.',
  })
  const browser = await chromeBrowserOf(fakeDeps(call).deps)
  expect(await browser.openTab('https://chatgpt.com/')).toBe('chrome:5')
  expect(calls.some(c => c.tool === 'tabs_create_mcp')).toBe(false)
  expect(calls.at(-1)).toEqual({ tool: 'navigate', args: { url: 'https://chatgpt.com/', tabId: 5 } })
})

test('openTab with no group starts it with createIfEmpty, once, and uses that tab', async () => {
  const { call, calls } = fakeMcp({
    tabs_context_mcp: args => (args.createIfEmpty ? withNote({ availableTabs: [{ tabId: 7, url: 'chrome://newtab/' }], tabGroupId: 9 }) : withNote({ availableTabs: [] })),
    navigate: 'Navigated.',
  })
  const browser = await chromeBrowserOf(fakeDeps(call).deps)
  expect(await browser.openTab('https://chatgpt.com/')).toBe('chrome:7')
  expect(calls.filter(c => c.args.createIfEmpty === true)).toEqual([{ tool: 'tabs_context_mcp', args: { createIfEmpty: true } }])
  expect(calls.some(c => c.tool === 'tabs_create_mcp')).toBe(false)
})

test('openTab without an id in the output takes the group tab that was not there before', async () => {
  const listings = [[1], [1], [1, 2]]
  let listed = 0
  const { call } = fakeMcp({
    tabs_context_mcp: () => tabList(listings[Math.min(listed++, listings.length - 1)]!),
    tabs_create_mcp: 'Opened a tab.',
    navigate: 'Navigated.',
  })
  const browser = await chromeBrowserOf(fakeDeps(call).deps)
  expect(await browser.openTab('https://chatgpt.com/')).toBe('chrome:2')
})

test('waitFor polls the expression in steps until it is true', async () => {
  const answers = ['false', 'false', 'true']
  let poll = 0
  const { call } = fakeMcp({
    tabs_context_mcp: tabList([1]),
    javascript_tool: () => answers[Math.min(poll++, answers.length - 1)]!,
  })
  const { deps, sleeps } = fakeDeps(call)
  const browser = await chromeBrowserOf(deps)
  expect(await browser.waitFor('chrome:1', 'document.readyState === "complete"', 5000)).toBe(true)
  expect(sleeps).toEqual([250, 250])
})

test('waitFor gives up at the timeout and answers false', async () => {
  const { call } = fakeMcp({ tabs_context_mcp: tabList([1]), javascript_tool: 'false' })
  const { deps, sleeps } = fakeDeps(call)
  const browser = await chromeBrowserOf(deps)
  expect(await browser.waitFor('chrome:1', 'false', 600)).toBe(false)
  expect(sleeps).toEqual([250, 250, 250])
})

test('waitFor survives a poll that fails, as a navigation destroying the page does', async () => {
  let poll = 0
  const { call } = fakeMcp({
    tabs_context_mcp: tabList([1]),
    javascript_tool: () => {
      if (poll++ === 0) throw new Error('Execution context was destroyed')
      return 'true'
    },
  })
  const browser = await chromeBrowserOf(fakeDeps(call).deps)
  expect(await browser.waitFor('chrome:1', 'true', 5000)).toBe(true)
})

test('upload puts the file bytes on the input through a page script, not the MCP file upload', async () => {
  const { call, calls } = fakeMcp({ tabs_context_mcp: tabList([1]), javascript_tool: '{"uploaded":true}' })
  const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
  const browser = await chromeBrowserOf(fakeDeps(call, png).deps)
  const selector = 'input[type=file][accept="image/*"], input[type=file]:not([accept])'
  await browser.upload('chrome:1', selector, [{ name: 'ref.png', type: 'image/png', path: '/x/ref.png' }])
  const script = String(calls.at(-1)?.args.text)
  expect(calls.at(-1)?.tool).toBe('javascript_tool')
  expect(script).toContain('"name":"ref.png"')
  expect(script).toContain('"type":"image/png"')
  expect(script).toContain('"base64":"iVBORw0KGgo="')
  expect(script).toContain(JSON.stringify(selector))
  expect(script).toContain("input.dispatchEvent(new Event('change'")
  expect(calls.some(c => c.tool === 'file_upload')).toBe(false)
})

test('upload fails when no input matched the selector', async () => {
  const { call } = fakeMcp({
    tabs_context_mcp: tabList([1]),
    javascript_tool: '{"uploaded":false,"reason":"no input matched input[type=file]"}',
  })
  const browser = await chromeBrowserOf(fakeDeps(call).deps)
  const error = await browser.upload('chrome:1', 'input[type=file]', [{ name: 'ref.png', type: 'image/png', path: '/x/ref.png' }]).catch(e => e)
  expect(String(error)).toContain('could not attach ref.png: no input matched input[type=file]')
})
