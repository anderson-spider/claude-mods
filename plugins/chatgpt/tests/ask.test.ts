import { expect, test } from 'claude-code/testing'
import { ask } from '../hooks/ask'
import { isChatUrl } from '../hooks/browser'
import { isHardBlocker } from '../hooks/conversation'
import { inputFor, sendScript } from '../hooks/scripts'
import { fakeBrowser, printed } from './helpers'

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
