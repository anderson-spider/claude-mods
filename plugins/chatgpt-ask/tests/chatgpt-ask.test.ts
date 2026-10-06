import { expect, test } from 'claude-code/testing'

import { ask, fallbackRouter, fileName, isRefusal, parseOutput, parseTabId, parseTabs, sendScript, summary } from '../hooks/chatgpt'
import type { Browser, BrowserTab } from '../hooks/chatgpt'

// The javascript_tool prints a string result as a JSON literal plus tab notes.
const printed = (value: unknown) => `${JSON.stringify(JSON.stringify(value))}\n\n(captured at origin https://chatgpt.com)`

type Page = { href: string; composer: boolean; login: boolean; stop: boolean; count: number; length: number }

// A fake pane: each state poll returns the next page in `pages` (the last one repeats).
function fakeBrowser(options: { open: boolean; tabs: BrowserTab[]; pages: Partial<Page>[]; markdown: string; sent?: boolean }) {
  const calls: string[] = []
  let poll = 0
  const base: Page = { href: 'https://chatgpt.com/', composer: true, login: false, stop: false, count: 0, length: 0 }
  const browser: Browser = {
    tabs: async () => {
      calls.push('tabs')
      return { browserOpen: options.open, tabs: options.tabs }
    },
    open: async url => {
      calls.push(`open ${url}`)
      return 'seed'
    },
    create: async () => {
      calls.push('create')
      return 't2'
    },
    navigate: async (tabId, url) => {
      calls.push(`navigate ${tabId} ${url}`)
    },
    js: async (tabId, code) => {
      if (code.includes('ClipboardEvent')) {
        calls.push(`send ${tabId}`)
        return printed(options.sent === false ? { sent: false, reason: 'send button not found' } : { sent: true })
      }
      if (code.includes('function convert')) {
        calls.push(`read ${tabId}`)
        return printed({ url: 'https://chatgpt.com/c/abc', markdown: options.markdown, text: options.markdown })
      }
      const page = options.pages[Math.min(poll++, options.pages.length - 1)]
      return printed({ ...base, ...page })
    },
  }
  return { browser, calls }
}

test('parseOutput reads the JSON a page script returns', () => {
  expect(parseOutput(printed({ a: 'x "y"\nz', b: [1] }))).toEqual({ a: 'x "y"\nz', b: [1] })
  expect(() => parseOutput('Error: no tab')).toThrow()
})

test('parseTabs and parseTabId read the pane tools output', () => {
  const tabs = parseTabs(
    '{\n  "browserOpen": true,\n  "tabs": [{ "tabId": "seed", "origin": "https://chatgpt.com", "isActive": true }]\n}\nThe Browser pane is currently hidden.',
  )
  expect(tabs.browserOpen).toBe(true)
  expect(tabs.tabs[0]?.tabId).toBe('seed')
  expect(parseTabs('nothing').browserOpen).toBe(false)
  expect(parseTabId('{ "serverId": "x", "tabId": "seed", "reused": false }')).toBe('seed')
})

test('sendScript embeds the prompt as a string literal', () => {
  const script = sendScript('line "1"\n`code` ${x}')
  expect(script).toContain(JSON.stringify('line "1"\n`code` ${x}'))
})

test('ask reuses the chatgpt tab, starts a new chat and waits until the answer settles', async () => {
  const { browser, calls } = fakeBrowser({
    open: true,
    tabs: [{ tabId: 'seed', origin: 'https://chatgpt.com', isActive: true }],
    pages: [
      { count: 2 },
      { count: 2, stop: true },
      { count: 3, stop: true, length: 10 },
      { count: 3, stop: false, length: 40 },
      { count: 3, stop: false, length: 40 },
    ],
    markdown: '## Answer',
  })
  const result = await ask(browser, { prompt: 'hi', newChat: true }, { pollMs: 0 })

  expect(result).toEqual({ ok: true, url: 'https://chatgpt.com/c/abc', markdown: '## Answer' })
  expect(calls).toEqual(['tabs', 'navigate seed https://chatgpt.com/', 'send seed', 'read seed'])
})

test('ask opens the pane when it is closed and a tab when chatgpt has none', async () => {
  const settled = [{ count: 0 }, { count: 1, length: 5 }, { count: 1, length: 5 }]
  const closed = fakeBrowser({ open: false, tabs: [], pages: settled, markdown: 'a' })
  await ask(closed.browser, { prompt: 'hi', newChat: true }, { pollMs: 0 })
  expect(closed.calls[1]).toBe('open https://chatgpt.com/')

  const other = fakeBrowser({
    open: true,
    tabs: [{ tabId: 'seed', origin: 'http://localhost:3000', isActive: true }],
    pages: settled,
    markdown: 'a',
  })
  await ask(other.browser, { prompt: 'hi', newChat: false }, { pollMs: 0 })
  expect(other.calls.slice(0, 3)).toEqual(['tabs', 'create', 'navigate t2 https://chatgpt.com/'])
})

test('ask keeps the open chat when newChat is false', async () => {
  const { browser, calls } = fakeBrowser({
    open: true,
    tabs: [{ tabId: 'seed', origin: 'https://chatgpt.com', isActive: true }],
    pages: [{ count: 1 }, { count: 2, length: 3 }, { count: 2, length: 3 }],
    markdown: 'ok',
  })
  await ask(browser, { prompt: 'more', newChat: false }, { pollMs: 0 })
  expect(calls).not.toContain('navigate seed https://chatgpt.com/')
})

test('ask refuses a logged-out page without sending anything', async () => {
  const { browser, calls } = fakeBrowser({
    open: true,
    tabs: [{ tabId: 'seed', origin: 'https://chatgpt.com', isActive: true }],
    pages: [{ composer: false, login: true }],
    markdown: '',
  })
  const result = await ask(browser, { prompt: 'hi', newChat: true }, { pollMs: 0 })

  expect(result.ok).toBe(false)
  expect(!result.ok && result.error).toContain('log in')
  expect(calls.some(call => call.startsWith('send'))).toBe(false)
})

// The words the engine used when auto mode refused a plugin's browser call.
const REFUSED =
  'chatgpt-ask: $.mcp.call(Claude_Browser, navigate) refused: The server-side auto mode classifier gave no verdict'

test('isRefusal tells a refused call from one that failed after running', () => {
  expect(isRefusal(new Error(REFUSED))).toBe(true)
  expect(isRefusal(REFUSED)).toBe(true)
  expect(isRefusal(new Error('javascript_tool: socket hang up'))).toBe(false)
  expect(isRefusal(new Error('navigate: refused to connect'))).toBe(false)
})

test('fallbackRouter falls back only on a refusal, and stays on the fallback after one', async () => {
  const route = fallbackRouter()
  const seen: string[] = []
  const direct = (fail?: string) => async () => {
    seen.push('direct')
    if (fail) throw new Error(fail)
    return 'direct'
  }
  const fallback = async () => {
    seen.push('fallback')
    return 'fallback'
  }

  expect(await route(direct(), fallback)).toBe('direct')
  await expect(route(direct('javascript_tool: socket hang up'), fallback)).rejects.toThrow('socket hang up')
  expect(seen).toEqual(['direct', 'direct'])

  expect(await route(direct(REFUSED), fallback)).toBe('fallback')
  expect(await route(direct(), fallback)).toBe('fallback')
  expect(seen).toEqual(['direct', 'direct', 'direct', 'fallback', 'fallback'])
})

test('ask sends the prompt once even when the send fails after running', async () => {
  const { browser, calls } = fakeBrowser({
    open: true,
    tabs: [{ tabId: 'seed', origin: 'https://chatgpt.com', isActive: true }],
    pages: [{}],
    markdown: '',
  })
  const send = browser.js
  browser.js = async (tabId, code) => {
    const output = await send(tabId, code)
    if (code.includes('ClipboardEvent')) throw new Error('javascript_tool: socket hang up')
    return output
  }

  await expect(ask(browser, { prompt: 'hi', newChat: true }, { pollMs: 0 })).rejects.toThrow('socket hang up')
  expect(calls.filter(call => call.startsWith('send'))).toEqual(['send seed'])
})

test('ask reports a prompt it could not send', async () => {
  const { browser } = fakeBrowser({
    open: true,
    tabs: [{ tabId: 'seed', origin: 'https://chatgpt.com', isActive: true }],
    pages: [{}],
    markdown: '',
    sent: false,
  })
  const result = await ask(browser, { prompt: 'hi', newChat: true }, { pollMs: 0 })
  expect(!result.ok && result.error).toContain('send button not found')
})

test('ask gives up after the timeout and returns what streamed so far', async () => {
  const { browser } = fakeBrowser({
    open: true,
    tabs: [{ tabId: 'seed', origin: 'https://chatgpt.com', isActive: true }],
    pages: [{ count: 0 }, { count: 1, stop: true, length: 10 }],
    markdown: 'partial',
  })
  const result = await ask(browser, { prompt: 'hi', newChat: true }, { pollMs: 0, timeoutMs: -1 })

  expect(result.ok).toBe(false)
  expect(!result.ok && result.markdown).toBe('partial')
})

test('fileName and summary', () => {
  expect(fileName('Qual é a diferença entre X e Y?', new Date('2026-10-06T12:34:56.789Z'))).toBe(
    '20261006-123456-qual-e-a-diferenca-entre-x-e-y.md',
  )
  expect(fileName('???', new Date('2026-10-06T12:34:56Z'))).toBe('20261006-123456-answer.md')
  const short = summary('/tmp/a.md', 'https://chatgpt.com/c/1', 'abc', 10)
  expect(short).toContain('/tmp/a.md')
  expect(short.endsWith('abc')).toBe(true)
  const long = summary('/tmp/a.md', 'https://chatgpt.com/c/1', 'x'.repeat(50), 10)
  expect(long).toContain('first 10 of 50 chars')
})
