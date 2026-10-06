import { expect, test } from 'claude-code/testing'

import {
  DOWNLOAD_CHUNK,
  UPLOAD_CHUNK,
  ask,
  extensionOf,
  fallbackRouter,
  fileName,
  generateImage,
  isChatUrl,
  isRefusal,
  pngSize,
  parseOutput,
  parseTabId,
  parseTabs,
  sendScript,
  staysOnChatgpt,
  summary,
  typeOf,
} from '../hooks/chatgpt'
import type { Browser, BrowserTab, Clipboard } from '../hooks/chatgpt'

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
  const closed = parseTabs(
    '{\n  "browserOpen": false,\n  "tabs": []\n}\nThe Browser pane isn\'t open yet. Call preview_start or navigate with {"url": "https://…"} to open it.',
  )
  expect(closed).toEqual({ browserOpen: false, tabs: [] })
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
  const result = await ask(browser, { prompt: 'hi' }, { pollMs: 0 })

  expect(result).toEqual({ ok: true, url: 'https://chatgpt.com/c/abc', markdown: '## Answer' })
  expect(calls).toEqual(['tabs', 'navigate seed https://chatgpt.com/', 'send seed', 'read seed'])
})

test('ask opens the pane when it is closed and a tab when chatgpt has none', async () => {
  const settled = [{ count: 0 }, { count: 1, length: 5 }, { count: 1, length: 5 }]
  const closed = fakeBrowser({ open: false, tabs: [], pages: settled, markdown: 'a' })
  await ask(closed.browser, { prompt: 'hi' }, { pollMs: 0 })
  expect(closed.calls[1]).toBe('open https://chatgpt.com/')

  const other = fakeBrowser({
    open: true,
    tabs: [{ tabId: 'seed', origin: 'http://localhost:3000', isActive: true }],
    pages: settled,
    markdown: 'a',
  })
  await ask(other.browser, { prompt: 'hi' }, { pollMs: 0 })
  expect(other.calls.slice(0, 3)).toEqual(['tabs', 'create', 'navigate t2 https://chatgpt.com/'])
})

test('ask continues the chat at chatUrl', async () => {
  const { browser, calls } = fakeBrowser({
    open: true,
    tabs: [{ tabId: 'seed', origin: 'https://chatgpt.com', isActive: true }],
    pages: [{ count: 1 }, { count: 2, length: 3 }, { count: 2, length: 3 }],
    markdown: 'ok',
  })
  await ask(browser, { prompt: 'more', chatUrl: 'https://chatgpt.com/c/6ac52f21-493c' }, { pollMs: 0 })
  expect(calls[1]).toBe('navigate seed https://chatgpt.com/c/6ac52f21-493c')
})

test('ask refuses a chatUrl that is not a chat link, before touching the pane', async () => {
  const { browser, calls } = fakeBrowser({ open: true, tabs: [], pages: [{}], markdown: '' })
  const result = await ask(browser, { prompt: 'more', chatUrl: 'https://evil.example/c/1' }, { pollMs: 0 })

  expect(!result.ok && result.error).toContain('chatUrl must be a chat link')
  expect(calls).toEqual([])
  expect(isChatUrl('https://chatgpt.com/c/abc-123')).toBe(true)
  expect(isChatUrl('https://chatgpt.com/')).toBe(false)
})

test('ask refuses a logged-out page without sending anything', async () => {
  const { browser, calls } = fakeBrowser({
    open: true,
    tabs: [{ tabId: 'seed', origin: 'https://chatgpt.com', isActive: true }],
    pages: [{ composer: false, login: true }],
    markdown: '',
  })
  const result = await ask(browser, { prompt: 'hi' }, { pollMs: 0 })

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

test('staysOnChatgpt allows only pane calls that stay on chatgpt.com', () => {
  const tabs = new Set(['seed'])
  expect(staysOnChatgpt('tabs_context', {}, tabs)).toBe(true)
  expect(staysOnChatgpt('tabs_create', {}, tabs)).toBe(true)
  expect(staysOnChatgpt('preview_start', { url: 'https://chatgpt.com/' }, tabs)).toBe(true)
  expect(staysOnChatgpt('navigate', { tabId: 't1', url: 'https://chatgpt.com/c/abc-123' }, tabs)).toBe(true)
  expect(staysOnChatgpt('navigate', { tabId: 't1', url: 'https://example.com/' }, tabs)).toBe(false)
  expect(staysOnChatgpt('navigate', { tabId: 't1', url: 'https://chatgpt.com.evil.io/' }, tabs)).toBe(false)
  expect(staysOnChatgpt('preview_start', { name: 'dev' }, tabs)).toBe(false)
  expect(staysOnChatgpt('javascript_tool', { action: 'javascript_exec', tabId: 'seed', text: '1' }, tabs)).toBe(true)
  expect(staysOnChatgpt('javascript_tool', { action: 'javascript_exec', tabId: 'other', text: '1' }, tabs)).toBe(false)
  expect(staysOnChatgpt('computer', { action: 'left_click' }, tabs)).toBe(false)
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

  await expect(ask(browser, { prompt: 'hi' }, { pollMs: 0 })).rejects.toThrow('socket hang up')
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
  const result = await ask(browser, { prompt: 'hi' }, { pollMs: 0 })
  expect(!result.ok && result.error).toContain('send button not found')
})

test('ask gives up after the timeout and returns what streamed so far', async () => {
  const { browser } = fakeBrowser({
    open: true,
    tabs: [{ tabId: 'seed', origin: 'https://chatgpt.com', isActive: true }],
    pages: [{ count: 0 }, { count: 1, stop: true, length: 10 }],
    markdown: 'partial',
  })
  const result = await ask(browser, { prompt: 'hi' }, { pollMs: 0, timeoutMs: -1 })

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

type Shot = { stop?: boolean; images?: number; count?: number; length?: number }

// A fake pane for images: each image poll returns the next shot (the last one repeats).
function fakeImagePane(options: { shots: Shot[]; base64: string; attached?: boolean; text?: string; copied?: boolean }) {
  const calls: string[] = []
  const uploaded: string[] = []
  let poll = 0
  const browser: Browser = {
    tabs: async () => ({ browserOpen: true, tabs: [{ tabId: 'seed', origin: 'https://chatgpt.com', isActive: true }] }),
    open: async () => 'seed',
    create: async () => 't2',
    navigate: async (tabId, url) => {
      calls.push(`navigate ${url}`)
    },
    js: async (_tabId, code) => {
      if (code.includes('__chatgptAskUpload.push')) {
        uploaded.push(JSON.parse(/push\((".*")\);/s.exec(code)![1]!))
        return printed({ chunks: uploaded.length })
      }
      if (code.includes('input.files')) {
        calls.push('attach')
        return printed(options.attached === false ? { attached: false, reason: 'image input not found' } : { attached: true })
      }
      if (code.includes('ClipboardEvent')) {
        calls.push('send')
        return printed({ sent: true })
      }
      if (code.includes('navigator.clipboard.write')) {
        calls.push('copy')
        return printed({ found: true, copied: options.copied ?? true, reason: '', url: 'https://chatgpt.com/c/img', size: 10, width: 1254, height: 1254, alt: 'Imagem 1 gerada' })
      }
      if (code.includes('__chatgptAskImage = b64')) {
        calls.push('image')
        return printed({ found: true, url: 'https://chatgpt.com/c/img', type: 'image/png', length: options.base64.length, width: 1024, height: 1024, alt: 'Imagem 1 gerada' })
      }
      if (code.includes('chunk:')) {
        const [, from, to] = /slice\((\d+), (\d+)\)/.exec(code)!
        return printed({ chunk: options.base64.slice(Number(from), Number(to)) })
      }
      if (code.includes('delete window.__chatgptAskImage')) return printed({ done: true })
      if (code.includes('function convert')) return printed({ url: 'https://chatgpt.com/c/img', markdown: options.text ?? '', text: options.text ?? '' })
      if (code.includes('images:')) {
        const shot = options.shots[Math.min(poll++, options.shots.length - 1)]!
        return printed({ href: 'https://chatgpt.com/c/img', stop: false, images: 0, count: 0, length: 0, ...shot })
      }
      return printed({ href: 'https://chatgpt.com/', composer: true, login: false, stop: false, count: 0, length: 0 })
    },
  }
  return { browser, calls, uploaded }
}

test('generateImage uploads the reference in chunks, waits for a finished image and reads it back whole', async () => {
  const reference = { name: 'ref.png', type: 'image/png', base64: 'A'.repeat(UPLOAD_CHUNK * 2 + 10) }
  const image = 'B'.repeat(DOWNLOAD_CHUNK * 3 + 5)
  const { browser, calls, uploaded } = fakeImagePane({
    shots: [{}, { stop: true }, { stop: true, images: 1 }, { images: 1 }],
    base64: image,
  })
  const result = await generateImage(browser, { prompt: 'a lamp', reference }, { pollMs: 0 })

  expect(uploaded.join('')).toBe(reference.base64)
  expect(uploaded.length).toBe(3)
  expect(calls).toEqual(['navigate https://chatgpt.com/', 'attach', 'send', 'image'])
  expect(result.ok && result.base64).toBe(image)
  expect(result.ok && [result.width, result.type]).toEqual([1024, 'image/png'])
})

test('generateImage returns the text when ChatGPT answers without an image', async () => {
  const { browser, calls } = fakeImagePane({
    shots: [{}, { count: 1, length: 20 }, { count: 1, length: 20 }],
    base64: '',
    text: 'I cannot create that image.',
  })
  const result = await generateImage(browser, { prompt: 'a logo of a brand' }, { pollMs: 0 })

  expect(result.ok).toBe(false)
  expect(!result.ok && result.markdown).toBe('I cannot create that image.')
  expect(!result.ok && result.error).toContain('instead of an image')
  expect(calls).not.toContain('image')
})

test('generateImage stops before sending when the reference does not attach', async () => {
  const { browser, calls } = fakeImagePane({ shots: [{}], base64: '', attached: false })
  const reference = { name: 'ref.png', type: 'image/png', base64: 'AAAA' }
  const result = await generateImage(browser, { prompt: 'a lamp', reference }, { pollMs: 0 })

  expect(!result.ok && result.error).toContain('image input not found')
  expect(calls).not.toContain('send')
})

test('image file names and types', () => {
  expect(fileName('Uma luminária de mesa', new Date('2026-10-06T12:00:00Z'), 'png')).toBe('20261006-120000-uma-luminaria-de-mesa.png')
  expect(extensionOf('image/webp')).toBe('webp')
  expect(extensionOf('image/unknown')).toBe('png')
  expect(typeOf('/x/Ref.JPG')).toBe('image/jpeg')
  expect(typeOf('/x/ref.bmp')).toBeUndefined()
})

test('generateImage with saveOnly reads the chat\'s last image without sending anything', async () => {
  const { browser, calls } = fakeImagePane({ shots: [{}], base64: 'C'.repeat(DOWNLOAD_CHUNK + 1) })
  const chatUrl = 'https://chatgpt.com/c/6ac53b54-ec00'
  const result = await generateImage(browser, { prompt: 'lamp', chatUrl, saveOnly: true }, { pollMs: 0 })

  expect(calls).toEqual([`navigate ${chatUrl}`, 'image'])
  expect(result.ok && result.base64.length).toBe(DOWNLOAD_CHUNK + 1)
  const missing = await generateImage(browser, { prompt: 'lamp', saveOnly: true }, { pollMs: 0 })
  expect(!missing.ok && missing.error).toContain('saveOnly needs the chatUrl')
})

test('a download slice stays under the host\'s output cap', () => {
  // The host caps a tool's output at about 25,000 tokens; base64 runs about 3 chars a token.
  expect(DOWNLOAD_CHUNK / 3).toBeLessThan(20_000)
})

// The first bytes of a 1254x1254 PNG, as the clipboard would hand them back.
const PNG_1254 = 'iVBORw0KGgoAAAANSUhEUgAABOYAAATmCAYAAAA=' + 'A'.repeat(100)

function fakeClipboard(image: string | undefined) {
  const seen: string[] = []
  const clipboard: Clipboard = {
    save: async () => {
      seen.push('save')
    },
    readImage: async () => {
      seen.push('read')
      return image
    },
    restore: async () => {
      seen.push('restore')
    },
  }
  return { clipboard, seen }
}

test('pngSize reads the width and height from a PNG header', () => {
  expect(pngSize(PNG_1254)).toEqual({ width: 1254, height: 1254 })
  expect(pngSize('R0lGODlhAQABAAAAACw=')).toBeUndefined()
})

test('readImage takes the clipboard path when the copy works, and restores the clipboard', async () => {
  const { browser, calls } = fakeImagePane({ shots: [{}], base64: 'B'.repeat(DOWNLOAD_CHUNK * 3) })
  const { clipboard, seen } = fakeClipboard(PNG_1254)
  const chatUrl = 'https://chatgpt.com/c/6ac53b54-ec00'
  const result = await generateImage(browser, { prompt: 'lamp', chatUrl, saveOnly: true }, { pollMs: 0, clipboard })

  expect(result.ok && result.base64).toBe(PNG_1254)
  expect(calls).toEqual([`navigate ${chatUrl}`, 'copy'])
  expect(seen).toEqual(['save', 'read', 'restore'])
})

test('readImage falls back to slices when the page cannot copy or the clipboard holds another image', async () => {
  const chatUrl = 'https://chatgpt.com/c/6ac53b54-ec00'
  const refused = fakeImagePane({ shots: [{}], base64: 'B'.repeat(10), copied: false })
  const first = fakeClipboard(PNG_1254)
  const viaSlices = await generateImage(refused.browser, { prompt: 'lamp', chatUrl, saveOnly: true }, { pollMs: 0, clipboard: first.clipboard })
  expect(viaSlices.ok && viaSlices.base64).toBe('B'.repeat(10))
  expect(refused.calls).toEqual([`navigate ${chatUrl}`, 'copy', 'image'])
  expect(first.seen).toEqual(['save', 'restore'])

  const other = fakeImagePane({ shots: [{}], base64: 'B'.repeat(10) })
  const small = fakeClipboard('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ')
  const mismatch = await generateImage(other.browser, { prompt: 'lamp', chatUrl, saveOnly: true }, { pollMs: 0, clipboard: small.clipboard })
  expect(mismatch.ok && mismatch.base64).toBe('B'.repeat(10))
  expect(small.seen).toEqual(['save', 'read', 'restore'])
})
