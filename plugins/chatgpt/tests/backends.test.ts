import { expect, test } from 'claude-code/testing'
import { BACKENDS, OWN_CALLS, ownCallAllowed } from '../hooks/backends'
import { BUILTIN, BUILTIN_SERVER } from '../hooks/builtin-browser'
import { CHROME, CHROME_SERVER } from '../hooks/chrome-browser'
import { ask } from '../hooks/ask'
import { chooseBrowser } from '../hooks/chooser'
import { TERMINAL_BROWSER } from '../hooks/terminal-browser'
import { fakeBrowser } from './fake-page'

const PLUGIN = 'chatgpt'

const check = (plugin: string, tool: string, input: unknown, tabId: string | undefined) => ownCallAllowed({ plugin, tool, input, tab: { id: tabId } })

// What each MCP backend must allow, written out per backend so that a new backend needs its own row here: `own` is
// the plugin's tab as the plugin names it, `elsewhere` a tab of the other backend, `tabArg` how the call names `own`.
const MCP = [
  {
    name: CHROME,
    server: CHROME_SERVER,
    hint: 'connect Claude in Chrome',
    listing: ['tabs_context_mcp', 'tabs_create_mcp'],
    own: 'chrome:7',
    tabArg: 7,
    elsewhere: 'builtin:7',
  },
  {
    name: BUILTIN,
    server: BUILTIN_SERVER,
    hint: "log in to chatgpt.com in the Claude app's built-in browser",
    listing: ['tabs_context', 'tabs_create'],
    own: 'builtin:t1',
    tabArg: 't1',
    elsewhere: 'chrome:7',
  },
]

const TERMINAL_HINT = 'Run Claude Code in a Ghostty or kitty pane with terminal-browser (https://terminal-browser.sh)'

test('the backends are tried in a fixed order, and every MCP one has a row in this table', () => {
  expect(BACKENDS.map(backend => backend.name)).toEqual([TERMINAL_BROWSER, CHROME, BUILTIN])
  const servers = BACKENDS.flatMap(backend => ('server' in backend ? [backend.server] : []))
  expect(servers).toEqual(MCP.map(row => row.server))
  expect(OWN_CALLS.map(call => call.prefix)).toEqual(MCP.map(row => `mcp__${row.server}__`))
})

test("every backend's setup advice is the one its row pins, in the order the chooser strings them together", async () => {
  expect(BACKENDS.map(backend => backend.hint)).toEqual([TERMINAL_HINT, ...MCP.map(row => row.hint)])

  const none = BACKENDS.map(({ name, hint }) => ({ name, hint, open: async () => 'down' }))
  const advice = [TERMINAL_HINT, ...MCP.map(row => row.hint)].join(', or ')
  expect(await chooseBrowser(none)).toBe(`No browser to drive ChatGPT with. ${BACKENDS.map(({ name }) => `${name} said: down.`).join(' ')} ${advice}, then try again.`)
})

test('the not-ready advice names every backend in the order of the list', async () => {
  const { browser } = fakeBrowser({ tabs: ['seed'], pages: [{ composer: false, login: true }], markdown: '' })
  const names = BACKENDS.map(backend => backend.name)

  const result = await ask(browser, { prompt: 'hi' }, { pollMs: 0, backends: names })

  const first = names.slice(0, -1).join(', ')
  expect(!result.ok && result.error).toContain(`the browser the plugin uses (${first} or ${names.at(-1)}), or to clear`)
})

for (const row of MCP) {
  const prefix = `mcp__${row.server}__`
  const script = { action: 'javascript_exec', tabId: row.tabArg, text: '1' }
  const allowed = (plugin: string, tool: string, input: unknown, tabId: string | undefined) => check(plugin, `${prefix}${tool}`, input, tabId)

  test(`${row.name}: the plugin's own calls that stay on chatgpt.com are allowed`, () => {
    for (const listing of row.listing) expect(allowed(PLUGIN, listing, {}, undefined)).toBe(true)
    expect(allowed(PLUGIN, 'navigate', { url: 'https://chatgpt.com/' }, undefined)).toBe(true)
    expect(allowed(PLUGIN, 'navigate', { url: 'https://chatgpt.com/c/abc-123' }, row.own)).toBe(true)
    expect(allowed(PLUGIN, 'javascript_tool', script, row.own)).toBe(true)
  })

  test(`${row.name}: the plugin's own calls that leave chatgpt.com or its tab are not allowed`, () => {
    const urls = ['https://chatgpt.com.evil.io/', 'https://chatgpt.com/settings', 'https://example.com/', 'http://chatgpt.com/', '']
    for (const url of urls) expect(allowed(PLUGIN, 'navigate', { url }, row.own)).toBe(false)
    expect(allowed(PLUGIN, 'navigate', {}, row.own)).toBe(false)
    expect(allowed(PLUGIN, 'navigate', { url: 7 }, row.own)).toBe(false)
    expect(allowed(PLUGIN, 'navigate', undefined, row.own)).toBe(false)
    // A script runs only in the plugin's own tab of this backend, and only as a script.
    expect(allowed(PLUGIN, 'javascript_tool', { ...script, tabId: 99 }, row.own)).toBe(false)
    expect(allowed(PLUGIN, 'javascript_tool', script, row.elsewhere)).toBe(false)
    expect(allowed(PLUGIN, 'javascript_tool', script, undefined)).toBe(false)
    expect(allowed(PLUGIN, 'javascript_tool', { ...script, action: 'screenshot' }, row.own)).toBe(false)
    expect(allowed(PLUGIN, 'javascript_tool', undefined, row.own)).toBe(false)
  })

  test(`${row.name}: the model's calls and other plugins' calls are never allowed`, () => {
    for (const origin of ['engine', 'other-plugin', 'chatgpt-evil', 'Chatgpt', '']) {
      for (const listing of row.listing) expect(allowed(origin, listing, {}, row.own)).toBe(false)
      expect(allowed(origin, 'navigate', { url: 'https://chatgpt.com/' }, row.own)).toBe(false)
      expect(allowed(origin, 'javascript_tool', script, row.own)).toBe(false)
    }
  })

  test(`${row.name}: other tools of the server are not allowed, even for the plugin`, () => {
    for (const tool of ['computer', 'form_input', 'read_page', 'upload_image', 'tabs_close', '']) {
      expect(allowed(PLUGIN, tool, { url: 'https://chatgpt.com/' }, row.own)).toBe(false)
    }
    // A tool of this server only counts under its own server's prefix and name.
    expect(check(PLUGIN, `${prefix.slice(0, -2)}`, {}, row.own)).toBe(false)
    expect(check(PLUGIN, `${prefix.toUpperCase()}navigate`, { url: 'https://chatgpt.com/' }, row.own)).toBe(false)
  })
}

test("a listing tool of one backend is not allowed on the other backend's server", () => {
  expect(check(PLUGIN, `mcp__${CHROME_SERVER}__tabs_context`, {}, undefined)).toBe(false)
  expect(check(PLUGIN, `mcp__${BUILTIN_SERVER}__tabs_context_mcp`, {}, undefined)).toBe(false)
})

test('unknown tools, other servers and terminal-browser are not allowed, whoever calls', () => {
  const navigate = { url: 'https://chatgpt.com/' }
  const tools = [
    'Bash',
    'navigate',
    'mcp__chatgpt__ask',
    'mcp__chatgpt__image',
    'mcp__chatgpt__jobs',
    'mcp__other__navigate',
    `mcp__${TERMINAL_BROWSER}__navigate`,
    'mcp__computer-use__screenshot',
    `mcp__${CHROME_SERVER}`,
    `${CHROME_SERVER}__navigate`,
    '',
  ]
  for (const tool of tools) {
    expect(check(PLUGIN, tool, navigate, 'chrome:7')).toBe(false)
    expect(check('engine', tool, navigate, 'chrome:7')).toBe(false)
  }
})
