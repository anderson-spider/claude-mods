import { expect, test } from 'claude-code/testing'

import { ask } from '../hooks/ask'
import { isChatUrl, listTabs, openedTab, parseOutput, splitTabId } from '../hooks/browser'
import { isHardBlocker } from '../hooks/conversation'
import { diagnose, report } from '../hooks/doctor'
import { extensionOf, fileName, limitMs, mimeOf, typeOf } from '../hooks/files'
import { generateImage } from '../hooks/image'
import { jobsReport, summary } from '../hooks/presentation'
import { taskQueue } from '../hooks/queue'
import { inputFor, sendScript } from '../hooks/scripts'
import type { Browser } from '../hooks/model'

// terminal-browser's eval prints a string result as a JSON literal.
const printed = (value: unknown) => `${JSON.stringify(JSON.stringify(value))}\n`

type Page = { href: string; composer: boolean; login: boolean; stop: boolean; count: number; length: number; images: number; blocker: string }

// A fake browser: each state poll returns the next page in `pages` (the last one repeats).
// The URL a leaveScript sends the tab to, or undefined for any other script.
const leftFor = (code: string) => /location\.assign\(("[^"]*")\)/.exec(code)?.[1] && JSON.parse(/location\.assign\(("[^"]*")\)/.exec(code)![1]!)

function fakeBrowser(options: { tabs: string[]; pages: Partial<Page>[]; markdown: string; sent?: boolean }) {
  const calls: string[] = []
  let poll = 0
  const base: Page = { href: 'https://chatgpt.com/', composer: true, login: false, stop: false, count: 0, length: 0, images: 0, blocker: '' }
  const browser: Browser = {
    tabs: async () => {
      calls.push('tabs')
      return options.tabs
    },
    openTab: async url => {
      calls.push(`open ${url}`)
      return 't2'
    },
    waitFor: async () => true,
    js: async (tabId, code) => {
      const url = leftFor(code)
      if (url) {
        calls.push(`navigate ${tabId} ${url}`)
        return printed({ leaving: true })
      }
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
    upload: async (tabId, selector, paths) => {
      calls.push(`upload ${tabId} ${selector} ${paths.join(' ')}`)
    },
  }
  return { browser, calls }
}

test('parseOutput reads the JSON a page script returns', () => {
  expect(parseOutput(printed({ a: 'x "y"\nz', b: [1] }))).toEqual({ a: 'x "y"\nz', b: [1] })
  expect(() => parseOutput('Error: no tab')).toThrow()
})

test('sendScript embeds the prompt as a string literal', () => {
  const script = sendScript('line "1"\n`code` ${x}')
  expect(script).toContain(JSON.stringify('line "1"\n`code` ${x}'))
})

test('ask reuses the plugin\'s tab, starts a new chat and waits until the answer settles', async () => {
  const { browser, calls } = fakeBrowser({
    tabs: ['seed'],
    pages: [
      { count: 2 },
      { count: 2, stop: true },
      { count: 3, stop: true, length: 10 },
      { count: 3, stop: false, length: 40 },
      { count: 3, stop: false, length: 40 },
    ],
    markdown: '## Answer',
  })
  const result = await ask(browser, { prompt: 'hi' }, { pollMs: 0, tab: { id: 'seed' } })

  expect(result).toEqual({ ok: true, url: 'https://chatgpt.com/c/abc', markdown: '## Answer' })
  expect(calls).toEqual(['tabs', 'navigate seed https://chatgpt.com/', 'send seed', 'read seed'])
})

test('ask opens a tab of its own when it has none or its tab is gone', async () => {
  const settled = [{ count: 0 }, { count: 1, length: 5 }, { count: 1, length: 5 }]
  const none = fakeBrowser({ tabs: [], pages: settled, markdown: 'a' })
  await ask(none.browser, { prompt: 'hi' }, { pollMs: 0 })
  expect(none.calls[0]).toBe('open https://chatgpt.com/')

  const gone = fakeBrowser({ tabs: ['other'], pages: settled, markdown: 'a' })
  await ask(gone.browser, { prompt: 'hi' }, { pollMs: 0, tab: { id: 'seed' } })
  expect(gone.calls.slice(0, 2)).toEqual(['tabs', 'open https://chatgpt.com/'])
})

test('ask leaves the user\'s own chatgpt tab alone and keeps its tab for the next request', async () => {
  const settled = [{ count: 0 }, { count: 1, length: 5 }, { count: 1, length: 5 }]
  const first = fakeBrowser({ tabs: ['seed'], pages: settled, markdown: 'a' })
  const tab = {}
  await ask(first.browser, { prompt: 'hi' }, { pollMs: 0, tab })
  expect(first.calls[0]).toBe('open https://chatgpt.com/')
  expect(tab).toEqual({ id: 't2' })

  const second = fakeBrowser({ tabs: ['seed', 't2'], pages: settled, markdown: 'a' })
  await ask(second.browser, { prompt: 'again' }, { pollMs: 0, tab })
  expect(second.calls.slice(0, 2)).toEqual(['tabs', 'navigate t2 https://chatgpt.com/'])
})

test('ask continues the chat at chatUrl', async () => {
  const { browser, calls } = fakeBrowser({
    tabs: ['seed'],
    pages: [{ count: 1 }, { count: 2, length: 3 }, { count: 2, length: 3 }],
    markdown: 'ok',
  })
  await ask(browser, { prompt: 'more', chatUrl: 'https://chatgpt.com/c/6ac52f21-493c' }, { pollMs: 0, tab: { id: 'seed' } })
  expect(calls[1]).toBe('navigate seed https://chatgpt.com/c/6ac52f21-493c')
})

test('ask refuses a chatUrl that is not a chat link, before touching the browser', async () => {
  const { browser, calls } = fakeBrowser({ tabs: [], pages: [{}], markdown: '' })
  const result = await ask(browser, { prompt: 'more', chatUrl: 'https://evil.example/c/1' }, { pollMs: 0 })

  expect(!result.ok && result.error).toContain('chatUrl must be a chat link')
  expect(calls).toEqual([])
  expect(isChatUrl('https://chatgpt.com/c/abc-123')).toBe(true)
  expect(isChatUrl('https://chatgpt.com/')).toBe(false)
})

test('ask refuses a logged-out page without sending anything', async () => {
  const { browser, calls } = fakeBrowser({
    tabs: ['seed'],
    pages: [{ composer: false, login: true }],
    markdown: '',
  })
  const result = await ask(browser, { prompt: 'hi' }, { pollMs: 0 })

  expect(result.ok).toBe(false)
  expect(!result.ok && result.error).toContain('log in')
  expect(calls.some(call => call.startsWith('send'))).toBe(false)
})

test('ask sends the prompt once even when the send fails after running', async () => {
  const { browser, calls } = fakeBrowser({
    tabs: ['seed'],
    pages: [{}],
    markdown: '',
  })
  const send = browser.js
  browser.js = async (tabId, code) => {
    const output = await send(tabId, code)
    if (code.includes('ClipboardEvent')) throw new Error('terminal-browser action: socket hang up')
    return output
  }

  await expect(ask(browser, { prompt: 'hi' }, { pollMs: 0, tab: { id: 'seed' } })).rejects.toThrow('socket hang up')
  expect(calls.filter(call => call.startsWith('send'))).toEqual(['send seed'])
})

test('ask reports a prompt it could not send', async () => {
  const { browser } = fakeBrowser({
    tabs: ['seed'],
    pages: [{}],
    markdown: '',
    sent: false,
  })
  const result = await ask(browser, { prompt: 'hi' }, { pollMs: 0 })
  expect(!result.ok && result.error).toContain('send button not found')
})

test('ask gives up after the timeout and returns what streamed so far', async () => {
  const { browser } = fakeBrowser({
    tabs: ['seed'],
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

// A fake browser for images: each state poll returns the next shot (the last one repeats).
function fakeImageBrowser(options: { shots: Shot[]; base64: string; attached?: boolean; text?: string }) {
  const calls: string[] = []
  let poll = 0
  const browser: Browser = {
    tabs: async () => [],
    openTab: async url => {
      calls.push(`navigate ${url}`)
      return 't2'
    },
    waitFor: async () => true,
    js: async (_tabId, code) => {
      if (code.includes('attachment did not show up')) {
        calls.push('attach')
        return printed(options.attached === false ? { attached: false, reason: 'the attachment did not show up in the composer' } : { attached: true })
      }
      if (code.includes('ClipboardEvent')) {
        calls.push('send')
        return printed({ sent: true })
      }
      if (code.includes('readAsDataURL')) {
        calls.push('image')
        return printed({ found: true, url: 'https://chatgpt.com/c/img', type: 'image/png', base64: options.base64, width: 1024, height: 1024, alt: 'Imagem 1 gerada' })
      }
      if (code.includes('function convert')) return printed({ url: 'https://chatgpt.com/c/img', markdown: options.text ?? '', text: options.text ?? '' })
      const shot = options.shots[Math.min(poll++, options.shots.length - 1)]!
      return printed({ href: 'https://chatgpt.com/c/img', composer: true, login: false, stop: false, images: 0, count: 0, length: 0, blocker: '', ...shot })
    },
    upload: async (_tabId, selector, paths) => {
      calls.push(`upload ${selector} ${paths.join(' ')}`)
    },
  }
  return { browser, calls }
}

test('generateImage uploads the reference by path, waits for a finished image and reads it back', async () => {
  const reference = { name: 'ref.png', type: 'image/png', path: '/x/ref.png' }
  const image = 'B'.repeat(5_000_005)
  const { browser, calls } = fakeImageBrowser({
    shots: [{}, { stop: true }, { stop: true, images: 1 }, { images: 1 }],
    base64: image,
  })
  const result = await generateImage(browser, { prompt: 'a lamp', files: [reference] }, { pollMs: 0 })

  expect(calls).toEqual(['navigate https://chatgpt.com/', `upload ${inputFor('image/png')} /x/ref.png`, 'attach', 'send', 'image'])
  expect(result.ok && result.images.map(i => i.base64)).toEqual([image])
  expect(result.ok && [result.images[0]!.width, result.images[0]!.type]).toEqual([1024, 'image/png'])
})

test('generateImage returns the text when ChatGPT answers without an image', async () => {
  const { browser, calls } = fakeImageBrowser({
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
  const { browser, calls } = fakeImageBrowser({ shots: [{}], base64: '', attached: false })
  const reference = { name: 'ref.png', type: 'image/png', path: '/x/ref.png' }
  const result = await generateImage(browser, { prompt: 'a lamp', files: [reference] }, { pollMs: 0 })

  expect(!result.ok && result.error).toContain('did not show up')
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
  const { browser, calls } = fakeImageBrowser({ shots: [{}], base64: 'C'.repeat(11) })
  const chatUrl = 'https://chatgpt.com/c/6ac53b54-ec00'
  const result = await generateImage(browser, { prompt: 'lamp', chatUrl, saveOnly: true }, { pollMs: 0 })

  expect(calls).toEqual([`navigate ${chatUrl}`, 'image'])
  expect(result.ok && result.images[0]!.base64.length).toBe(11)
  const missing = await generateImage(browser, { prompt: 'lamp', saveOnly: true }, { pollMs: 0 })
  expect(!missing.ok && missing.error).toContain('saveOnly needs the chatUrl')
})

test('taskQueue runs requests one after another and says how many wait ahead', async () => {
  const run = taskQueue()
  const order: string[] = []
  const ahead: number[] = []
  let release = () => {}
  const gate = new Promise<string>(resolve => (release = () => resolve('a')))
  const first = run(
    () => gate.then(v => (order.push(v), v)),
    n => ahead.push(n),
  )
  const second = run(async () => (order.push('b'), 'b'), n => ahead.push(n))
  const third = run(async () => {
    throw new Error('boom')
  })
  const fourth = run(async () => (order.push('d'), 'd'))
  release()
  expect(await first).toBe('a')
  expect(await second).toBe('b')
  await expect(third).rejects.toThrow('boom')
  expect(await fourth).toBe('d')
  expect(order).toEqual(['a', 'b', 'd'])
  expect(ahead).toEqual([0, 1])
  expect(order.indexOf('b')).toBeGreaterThan(order.indexOf('a'))
})

test('terminal-browser output: tabs, ids and the tab new-tab opened', () => {
  const listed = listTabs(
    JSON.stringify({
      self: { tab: 't', pane: 'p' },
      browsers: [{ key: '96217-1', tabs: [{ id: 1, url: 'https://chatgpt.com/c/abc', active: true }, { id: 2, url: 'about:blank', active: false }] }],
    }),
  )
  expect(listed).toEqual(['96217-1:1', '96217-1:2'])
  expect(listTabs('{"browsers": []}')).toEqual([])
  expect(listTabs('terminal-browser: no pane')).toEqual([])
  expect(splitTabId('96217-1:3')).toEqual({ browser: '96217-1', tab: '3' })
  expect(openedTab('{ "key": "76085-1", "openedTab": 2, "tabs": [] }')).toBe('76085-1:2')
  expect(openedTab('{ "key": "97220-1", "openedTab": null, "splitDir": "right" }')).toBe('97220-1:1')
  expect(openedTab('nothing')).toBeUndefined()
})

test('mimeOf and inputFor pick the type and the file input of an attachment', () => {
  expect(mimeOf('/x/notes.md')).toBe('text/markdown')
  expect(mimeOf('/x/report.PDF')).toBe('application/pdf')
  expect(mimeOf('/x/main.rs')).toBe('text/plain')
  expect(mimeOf('/x/ref.png')).toBe('image/png')
  expect(inputFor('image/png')).toBe('input[type=file][accept="image/*"]')
  expect(inputFor('application/pdf')).toContain(':not([accept])')
})

test('isHardBlocker stops on limits and verifications, not on any dialog', () => {
  expect(isHardBlocker("You've reached your limit for image generation")).toBe(true)
  expect(isHardBlocker('Você atingiu o limite. Tente novamente mais tarde.')).toBe(true)
  expect(isHardBlocker('a human verification (captcha)')).toBe(true)
  expect(isHardBlocker('Copied to clipboard')).toBe(false)
})

test('ask picks the model and attaches files by path where the browser uploads', async () => {
  const { browser, calls } = fakeBrowser({
    tabs: ['seed'],
    pages: [{ count: 0 }, { count: 1, length: 5 }, { count: 1, length: 5 }],
    markdown: 'ok',
  })
  const js = browser.js
  browser.js = async (tabId, code) => {
    if (code.includes('Selecionar modelo')) {
      calls.push('model')
      return printed({ picked: true })
    }
    if (code.includes('attachment did not show up')) {
      calls.push('chip')
      return printed({ attached: true })
    }
    return js(tabId, code)
  }
  const files = [{ name: 'notes.md', type: 'text/markdown', path: '/x/notes.md' }]
  const result = await ask(browser, { prompt: 'summarise', model: 'GPT-5.6 Sol', files }, { pollMs: 0, tab: { id: 'seed' } })

  expect(result.ok).toBe(true)
  expect(calls).toEqual([
    'tabs',
    'navigate seed https://chatgpt.com/',
    'model',
    `upload seed ${inputFor('text/markdown')} /x/notes.md`,
    'chip',
    'send seed',
    'read seed',
  ])
})

test('ask names the models on offer when the one asked for is missing, and sends nothing', async () => {
  const { browser, calls } = fakeBrowser({ tabs: [], pages: [{}], markdown: '' })
  const js = browser.js
  browser.js = async (tabId, code) =>
    code.includes('Selecionar modelo') ? printed({ picked: false, reason: 'no such entry', offered: ['latest', 'gpt-5.6 sol'] }) : js(tabId, code)
  const result = await ask(browser, { prompt: 'hi', model: 'gpt-9' }, { pollMs: 0 })

  expect(!result.ok && result.error).toContain('The menu offers: latest, gpt-5.6 sol')
  expect(calls.some(call => call.startsWith('send'))).toBe(false)
})

test('ask with saveOnly waits for a streaming answer and saves it without sending', async () => {
  const { browser, calls } = fakeBrowser({
    tabs: [],
    pages: [{ count: 4, stop: true, length: 10 }, { count: 4, stop: true, length: 30 }, { count: 4, length: 50 }, { count: 4, length: 50 }],
    markdown: 'the long answer',
  })
  const chatUrl = 'https://chatgpt.com/c/abc-1'
  const result = await ask(browser, { prompt: 'x', chatUrl, saveOnly: true }, { pollMs: 0 })

  expect(result).toEqual({ ok: true, url: 'https://chatgpt.com/c/abc', markdown: 'the long answer' })
  expect(calls.some(call => call.startsWith('send'))).toBe(false)
  const missing = await ask(browser, { prompt: 'x', saveOnly: true }, { pollMs: 0 })
  expect(!missing.ok && missing.error).toContain('saveOnly needs the chatUrl')
})

test('ask stops at a usage limit and marks a timeout that may still finish', async () => {
  const limited = fakeBrowser({
    tabs: [],
    pages: [{ count: 0 }, { count: 0, blocker: "You've reached your message limit" }],
    markdown: '',
  })
  const stopped = await ask(limited.browser, { prompt: 'hi' }, { pollMs: 0 })
  expect(!stopped.ok && stopped.error).toContain('reached your message limit')

  const slow = fakeBrowser({ tabs: [], pages: [{ count: 0 }, { count: 1, stop: true, length: 3 }], markdown: 'par' })
  const late = await ask(slow.browser, { prompt: 'hi' }, { pollMs: 0, timeoutMs: -1 })
  expect(!late.ok && late.timedOut).toBe(true)
})

test('generateImage saves every variant ChatGPT drew, oldest first', async () => {
  const { browser, calls } = fakeImageBrowser({ shots: [{}, { stop: true, images: 2 }, { images: 2 }], base64: 'B'.repeat(10) })
  const result = await generateImage(browser, { prompt: 'two lamps' }, { pollMs: 0 })

  expect(result.ok && result.images.length).toBe(2)
  expect(calls.filter(call => call === 'image')).toEqual(['image', 'image'])
})

test('generateImage with saveOnly waits while the image is still generating', async () => {
  const { browser, calls } = fakeImageBrowser({ shots: [{ stop: true }, { stop: true }, { images: 1 }], base64: 'C'.repeat(10) })
  const chatUrl = 'https://chatgpt.com/c/6ac53b54-ec00'
  const result = await generateImage(browser, { prompt: 'lamp', chatUrl, saveOnly: true }, { pollMs: 0 })

  expect(result.ok && result.images[0]!.base64).toBe('C'.repeat(10))
  expect(calls).not.toContain('send')
})

test('jobsReport lists jobs newest first with where they saved', () => {
  expect(jobsReport([], 0)).toBe('No ChatGPT jobs in this session.')
  const text = jobsReport(
    [
      { id: 1, kind: 'ask', prompt: 'first question', status: 'done', startedAt: 0, endedAt: 120_000, chatUrl: 'https://chatgpt.com/c/a', paths: ['/tmp/a.md'] },
      { id: 2, kind: 'image', prompt: 'a lamp', status: 'running', startedAt: 60_000 },
    ],
    240_000,
  )
  expect(text.split('\n')[0]).toBe('#2 image running (for 3 min): a lamp')
  expect(text).toContain('#1 ask done (took 2 min): first question\n  chat https://chatgpt.com/c/a; saved to /tmp/a.md')
})

test('diagnose reports which page parts are in place', async () => {
  const { browser } = fakeBrowser({ tabs: [], pages: [{}], markdown: '' })
  browser.js = async (_tabId, code) =>
    code.includes('imageInput')
      ? printed({ href: 'https://chatgpt.com/', login: false, composer: true, send: 0, imageInput: true, fileInput: false, model: true, answers: 0, images: 0, codeBlocks: 0, blocker: '' })
      : printed({})
  const checks = await diagnose(browser, undefined, {})
  const text = report(checks)

  expect(text).toContain('✓ composer: found')
  expect(text).toContain('✗ file input: not found')
  expect(text).toContain('1 check(s) failed.')
  expect(report(await diagnose(browser, 'https://evil.example/c/1', {}))).toContain('✗ chat link')
})

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

test('limitMs reads minutes, falls back and caps', () => {
  expect(limitMs(undefined, 6)).toBe(360_000)
  expect(limitMs('abc', 6)).toBe(360_000)
  expect(limitMs(0, 6)).toBe(360_000)
  expect(limitMs(-3, 6)).toBe(360_000)
  expect(limitMs(NaN, 6)).toBe(360_000)
  expect(limitMs(0.5, 6)).toBe(30_000)
  expect(limitMs('12', 6)).toBe(720_000)
  expect(limitMs(1e9, 6)).toBe(86_400_000)
})
