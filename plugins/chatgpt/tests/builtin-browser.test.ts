import { expect, test } from 'claude-code/testing'
import { builtinBrowserOf, builtinStaysOnChatgpt } from '../hooks/builtin-browser'
import { parseOutput } from '../hooks/scripts'
import { fakeDeps, fakeMcp, withNote } from './mcp-helpers'

const PANE_CLOSED = withNote({ browserOpen: false, tabs: [] })
const paneWith = (ids: string[]) => withNote({ browserOpen: true, tabs: ids.map(tabId => ({ tabId, origin: 'https://chatgpt.com', isActive: true })) })

test('the built-in browser tabs are the pane tabs, as builtin:<id>, and an unopened pane has none', async () => {
  const open = await builtinBrowserOf(fakeDeps(fakeMcp({ tabs_context: paneWith(['seed', 'tab-1']) }).call).deps)
  expect(await open.tabs()).toEqual(['builtin:seed', 'builtin:tab-1'])
  const closed = await builtinBrowserOf(fakeDeps(fakeMcp({ tabs_context: PANE_CLOSED }).call).deps)
  expect(await closed.tabs()).toEqual([])
})

test('a pane that cannot be reached, or prints no tab list, is unavailable', async () => {
  expect(String(await builtinBrowserOf(fakeDeps(fakeMcp({}).call).deps).catch(e => e))).toContain('no answer for tabs_context')
  const odd = fakeDeps(fakeMcp({ tabs_context: 'The Browser pane is not available.' }).call).deps
  expect(String(await builtinBrowserOf(odd).catch(e => e))).toContain('unexpected output from tabs_context')
})

test('js decodes the page text the built-in browser prints as a JSON string literal', async () => {
  const printed = '"{\\"href\\":\\"https://chatgpt.com/\\"}"\n\n(captured at origin https://chatgpt.com)\n\nTab Context:\n- Executed on tabId: seed'
  const { call, calls } = fakeMcp({ tabs_context: paneWith(['seed']), javascript_tool: printed })
  const browser = await builtinBrowserOf(fakeDeps(call).deps)
  expect(parseOutput<{ href: string }>(await browser.js('builtin:seed', 'return JSON.stringify({ href: location.href })'))).toEqual({
    href: 'https://chatgpt.com/',
  })
  expect(calls.at(-1)).toEqual({
    tool: 'javascript_tool',
    args: { action: 'javascript_exec', tabId: 'seed', text: '(async () => {\nreturn JSON.stringify({ href: location.href })\n})()' },
  })
})

test('openTab with the pane open makes its own tab and navigates it, leaving the others alone', async () => {
  const { call, calls } = fakeMcp({
    tabs_context: paneWith(['seed']),
    tabs_create: withNote({ tabId: 'tab-1' }),
    navigate: withNote({ navOk: true }),
  })
  const browser = await builtinBrowserOf(fakeDeps(call).deps)
  expect(await browser.openTab('https://chatgpt.com/')).toBe('builtin:tab-1')
  expect(calls.slice(-2)).toEqual([
    { tool: 'tabs_create', args: { foreground: false } },
    { tool: 'navigate', args: { url: 'https://chatgpt.com/', tabId: 'tab-1' } },
  ])
})

test('openTab with the pane closed lets navigate open the pane and returns its tab', async () => {
  const { call, calls } = fakeMcp({
    tabs_context: PANE_CLOSED,
    navigate: withNote({ serverId: 'preview-local', tabId: 'seed', reused: false, navOk: true }),
  })
  const browser = await builtinBrowserOf(fakeDeps(call).deps)
  expect(await browser.openTab('https://chatgpt.com/')).toBe('builtin:seed')
  expect(calls.some(c => c.tool === 'tabs_create')).toBe(false)
  expect(calls.at(-1)).toEqual({ tool: 'navigate', args: { url: 'https://chatgpt.com/' } })
})

test('upload goes through a page script with the same selector and file bytes', async () => {
  const { call, calls } = fakeMcp({ tabs_context: paneWith(['seed']), javascript_tool: '{"uploaded":true}' })
  const browser = await builtinBrowserOf(fakeDeps(call, new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])).deps)
  await browser.upload('builtin:seed', 'input[type=file]:not([accept])', [{ name: 'notes.txt', type: 'text/plain', path: '/x/notes.txt' }])
  const script = String(calls.at(-1)?.args.text)
  expect(calls.at(-1)?.args.tabId).toBe('seed')
  expect(script).toContain('"name":"notes.txt"')
  expect(script).toContain('"type":"text/plain"')
  expect(script).not.toContain('application/octet-stream')
  expect(script).toContain(JSON.stringify('input[type=file]:not([accept])'))
})

test('upload fails with the page reason when no input matched', async () => {
  const { call } = fakeMcp({
    tabs_context: paneWith(['seed']),
    javascript_tool: '"{\\"uploaded\\":false,\\"reason\\":\\"no input matched input[type=file]\\"}"',
  })
  const browser = await builtinBrowserOf(fakeDeps(call).deps)
  expect(String(await browser.upload('builtin:seed', 'input[type=file]', [{ name: 'ref.png', type: 'image/png', path: '/x/ref.png' }]).catch(e => e))).toContain(
    'could not attach ref.png: no input matched input[type=file]',
  )
})

test('builtinStaysOnChatgpt allows a script only in the plugin tab of this backend', () => {
  const script = { action: 'javascript_exec', tabId: 't1', text: '1' }
  expect(builtinStaysOnChatgpt('tabs_context', {}, undefined)).toBe(true)
  expect(builtinStaysOnChatgpt('javascript_tool', script, 'builtin:t1')).toBe(true)
  expect(builtinStaysOnChatgpt('javascript_tool', script, 'chrome:1')).toBe(false)
  expect(builtinStaysOnChatgpt('javascript_tool', script, undefined)).toBe(false)
})
