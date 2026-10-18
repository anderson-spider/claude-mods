import { expect, test } from 'claude-code/testing'
import { ask } from '../hooks/ask'
import { isChatUrl } from '../hooks/tab'
import { inputFor } from '../hooks/scripts'
import { fakeBrowser, fakeMenu, printed, turns } from './fake-page'

test('ask reuses the plugin\'s tab, starts a new chat and waits until the answer settles', async () => {
  const { browser, calls } = fakeBrowser({
    tabs: ['seed'],
    pages: [
      { turns: turns(2) },
      { turns: turns(2), stop: true },
      { turns: turns(3), stop: true, length: 10 },
      { turns: turns(3), stop: false, length: 40 },
      { turns: turns(3), stop: false, length: 40 },
    ],
    markdown: '## Answer',
  })
  const result = await ask(browser, { prompt: 'hi' }, { pollMs: 0, tab: { id: 'seed' } })

  expect(result).toEqual({ ok: true, url: 'https://chatgpt.com/c/abc', markdown: '## Answer' })
  expect(calls).toEqual(['tabs', 'navigate seed https://chatgpt.com/', 'model rows seed', 'model click seed', 'model rows seed', 'model close seed', 'send seed', 'read seed'])
})

test('ask opens a tab of its own when it has none or its tab is gone', async () => {
  const settled = [{ turns: turns(0) }, { turns: turns(1), length: 5 }, { turns: turns(1), length: 5 }]
  const none = fakeBrowser({ tabs: [], pages: settled, markdown: 'a' })
  await ask(none.browser, { prompt: 'hi' }, { pollMs: 0 })
  expect(none.calls[0]).toBe('open https://chatgpt.com/')

  const gone = fakeBrowser({ tabs: ['other'], pages: settled, markdown: 'a' })
  await ask(gone.browser, { prompt: 'hi' }, { pollMs: 0, tab: { id: 'seed' } })
  expect(gone.calls.slice(0, 2)).toEqual(['tabs', 'open https://chatgpt.com/'])
})

test('ask leaves the user\'s own chatgpt tab alone and keeps its tab for the next request', async () => {
  const settled = [{ turns: turns(0) }, { turns: turns(1), length: 5 }, { turns: turns(1), length: 5 }]
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
    pages: [{ turns: turns(1) }, { turns: turns(2), length: 3 }, { turns: turns(2), length: 3 }],
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

test('ask lists the browsers it was given in the not-ready advice, and no list when it has none', async () => {
  const page = { composer: false, login: true }
  const given = fakeBrowser({ tabs: ['seed'], pages: [page], markdown: '' })
  const none = fakeBrowser({ tabs: ['seed'], pages: [page], markdown: '' })
  const text = (browsers: string) =>
    `ChatGPT is not ready in the browser (at https://chatgpt.com/). Ask the user to log in to chatgpt.com in the browser the plugin uses${browsers}, ` +
    'or to clear what the page shows, and try again; never type credentials.'

  expect(await ask(given.browser, { prompt: 'hi' }, { pollMs: 0, backends: ['one', 'two', 'three'] })).toEqual({ ok: false, url: 'https://chatgpt.com/', error: text(' (one, two or three)') })
  expect(await ask(none.browser, { prompt: 'hi' }, { pollMs: 0 })).toEqual({ ok: false, url: 'https://chatgpt.com/', error: text('') })
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
    pages: [{ turns: turns(0) }, { turns: turns(1), stop: true, length: 10 }],
    markdown: 'partial',
  })
  const result = await ask(browser, { prompt: 'hi' }, { pollMs: 0, timeoutMs: -1 })

  expect(result.ok).toBe(false)
  expect(!result.ok && result.markdown).toBe('partial')
})

test('ask picks the model and attaches files by path where the browser uploads', async () => {
  const { browser, calls } = fakeBrowser({
    tabs: ['seed'],
    pages: [{ turns: turns(0) }, { turns: turns(1), length: 5 }, { turns: turns(1), length: 5 }],
    markdown: 'ok',
  })
  const js = browser.js
  browser.js = async (tabId, code) => {
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
    'model rows seed',
    'model click seed',
    `upload seed ${inputFor('text/markdown')} /x/notes.md`,
    'chip',
    'model rows seed',
    'model close seed',
    'send seed',
    'read seed',
  ])
})

test('ask names the models on offer when the one asked for is missing, and sends nothing', async () => {
  const { browser, calls } = fakeBrowser({ tabs: [], pages: [{}], markdown: '', menu: fakeMenu(['Latest', 'GPT-5.6 Sol'], 'Latest') })
  const result = await ask(browser, { prompt: 'hi', model: 'gpt-9' }, { pollMs: 0 })

  expect(!result.ok && result.error).toContain('The menu offers: latest, gpt-5.6 sol')
  expect(calls.some(call => call.startsWith('send'))).toBe(false)
})

test('ask with saveOnly waits for a streaming answer and saves it without sending', async () => {
  const { browser, calls } = fakeBrowser({
    tabs: [],
    pages: [{ turns: turns(4), stop: true, length: 10 }, { turns: turns(4), stop: true, length: 30 }, { turns: turns(4), length: 50 }, { turns: turns(4), length: 50 }],
    markdown: 'the long answer',
  })
  const chatUrl = 'https://chatgpt.com/c/abc-1'
  // A short limit: a run that never settles (a mutated `before`) times out and fails the assertion, instead of hanging.
  const result = await ask(browser, { prompt: 'x', chatUrl, saveOnly: true }, { pollMs: 0, timeoutMs: 1000 })

  expect(result).toEqual({ ok: true, url: 'https://chatgpt.com/c/abc', markdown: 'the long answer' })
  expect(calls.some(call => call.startsWith('send'))).toBe(false)
  const missing = await ask(browser, { prompt: 'x', saveOnly: true }, { pollMs: 0 })
  expect(!missing.ok && missing.error).toContain('saveOnly needs the chatUrl')
})

test('ask stops at a usage limit and marks a timeout that may still finish', async () => {
  const limited = fakeBrowser({
    tabs: [],
    pages: [{ turns: turns(0) }, { turns: turns(0), blocker: "You've reached your message limit" }],
    markdown: '',
  })
  const stopped = await ask(limited.browser, { prompt: 'hi' }, { pollMs: 0 })
  expect(!stopped.ok && stopped.error).toContain('reached your message limit')

  const slow = fakeBrowser({ tabs: [], pages: [{ turns: turns(0) }, { turns: turns(1), stop: true, length: 3 }], markdown: 'par' })
  const late = await ask(slow.browser, { prompt: 'hi' }, { pollMs: 0, timeoutMs: -1 })
  expect(!late.ok && late.timedOut).toBe(true)
})

test('a page that answers no page state fails by the backend name, not with a TypeError', async () => {
  const { browser } = fakeBrowser({ tabs: ['seed'], pages: [{}], markdown: '', name: 'Claude in Chrome' })
  browser.js = async () => printed({})
  const error = String(await ask(browser, { prompt: 'hi' }, { pollMs: 0, tab: { id: 'seed' } }).catch(e => e))
  expect(error).toContain('Claude in Chrome returned no page state')
  expect(error).not.toContain('TypeError')
})
