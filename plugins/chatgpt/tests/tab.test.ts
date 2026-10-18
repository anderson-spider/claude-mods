import { expect, test } from 'claude-code/testing'
import type { Browser, PageState, TabHolder } from '../hooks/model'
import { blocked, chatUrlError, findTab, LOAD_MS, pageStateOf, prepare } from '../hooks/tab'
import { COMPOSER, LANDED, LOGIN } from '../hooks/scripts'
import { fakeBrowser, printed, turns } from './fake-page'

// Every browser call a tab test makes, in order, with the waits it asked for.
function recording(options: { tabs: string[]; pages?: Partial<PageState>[]; markdown?: string }) {
  const { browser, calls } = fakeBrowser({ tabs: options.tabs, pages: options.pages ?? [{}], markdown: options.markdown ?? '' })
  const waits: [string, string, number][] = []
  const waitFor = browser.waitFor
  browser.waitFor = async (tabId, fn, timeoutMs) => {
    waits.push([tabId, fn, timeoutMs])
    return waitFor(tabId, fn, timeoutMs)
  }
  return { browser, calls, waits }
}

// A browser that fails on any call: a validation error must not reach it.
const untouchable: Pick<Browser, 'name' | 'tabs' | 'openTab' | 'js' | 'waitFor'> = {
  name: 'untouchable',
  tabs: async () => {
    throw new Error('the browser was touched')
  },
  openTab: async () => {
    throw new Error('the browser was touched')
  },
  js: async () => {
    throw new Error('the browser was touched')
  },
  waitFor: async () => {
    throw new Error('the browser was touched')
  },
}

const TARGET = 'https://chatgpt.com/'

test('findTab reuses the plugin\'s own tab when it is still open, navigating it and waiting for the page to land', async () => {
  const { browser, calls, waits } = recording({ tabs: ['seed', 'user'] })
  const holder: TabHolder = { id: 'seed' }
  const id = await findTab(browser, TARGET, holder)

  expect(id).toBe('seed')
  expect(holder).toEqual({ id: 'seed' })
  expect(calls).toEqual(['tabs', 'navigate seed https://chatgpt.com/'])
  expect(waits).toEqual([
    ['seed', LANDED, LOAD_MS],
    ['seed', `!!${COMPOSER} || ${LOGIN}`, LOAD_MS],
  ])
})

test('findTab opens a tab at the target when the holder has none, and records it', async () => {
  const { browser, calls, waits } = recording({ tabs: ['user'] })
  const holder: TabHolder = {}
  const id = await findTab(browser, TARGET, holder)

  expect(id).toBe('t2')
  expect(holder).toEqual({ id: 't2' })
  expect(calls).toEqual(['open https://chatgpt.com/'])
  expect(waits).toEqual([['t2', `!!${COMPOSER} || ${LOGIN}`, LOAD_MS]])
})

test('findTab never navigates a tab it did not open: a holder id that is gone opens a new tab instead', async () => {
  const { browser, calls } = recording({ tabs: ['user'] })
  const holder: TabHolder = { id: 'closed' }
  const id = await findTab(browser, TARGET, holder)

  expect(id).toBe('t2')
  expect(holder).toEqual({ id: 't2' })
  expect(calls).toEqual(['tabs', 'open https://chatgpt.com/'])
  expect(calls.some(call => call.includes('user'))).toBe(false)
})

test('prepare answers an invalid chatUrl before the browser is touched', async () => {
  const result = await prepare(untouchable, { chatUrl: 'https://evil.example/c/1' }, { progress: () => {}, tab: {}, backends: [] })

  expect(result).toEqual({ ok: false, error: 'chatUrl must be a chat link like https://chatgpt.com/c/<id>, not https://evil.example/c/1.' })
})

test('prepare goes to the chatUrl it is given, not to the home page', async () => {
  const { browser, calls } = recording({ tabs: ['seed'] })
  const result = await prepare(browser, { chatUrl: 'https://chatgpt.com/c/abc-1' }, { progress: () => {}, tab: { id: 'seed' }, backends: [] })

  expect(result).toMatchObject({ ok: true, tabId: 'seed', page: { composer: true } })
  expect(calls).toEqual(['tabs', 'navigate seed https://chatgpt.com/c/abc-1'])
})

test('prepare reports the opening step to the progress callback, then returns the tab and its page', async () => {
  const { browser } = recording({ tabs: [] })
  const progress: string[] = []
  const result = await prepare(browser, {}, { progress: text => progress.push(text), tab: {}, backends: [] })

  expect(progress).toEqual(['opening chatgpt.com'])
  expect(result).toEqual({ ok: true, tabId: 't2', page: expect.objectContaining({ href: 'https://chatgpt.com/', composer: true, stop: false }) })
})

test('prepare on a page that is not ready names the browsers it was given, and quotes what the page shows first', async () => {
  const { browser } = recording({ tabs: ['seed'], pages: [{ composer: false, login: true, blocker: 'Verify you are human' }] })
  const result = await prepare(browser, {}, { progress: () => {}, tab: { id: 'seed' }, backends: ['terminal-browser', 'Claude in Chrome'] })

  expect(result).toEqual({
    ok: false,
    url: 'https://chatgpt.com/',
    error:
      'ChatGPT is not ready in the browser (at https://chatgpt.com/). ChatGPT shows: "Verify you are human". ' +
      'Ask the user to log in to chatgpt.com in the browser the plugin uses (terminal-browser or Claude in Chrome), ' +
      'or to clear what the page shows, and try again; never type credentials.',
  })
})

test('prepare on a page outside chatgpt.com is not ready, whatever the composer shows', async () => {
  const { browser } = recording({ tabs: ['seed'], pages: [{ href: 'https://example.com/', composer: true }] })
  const result = await prepare(browser, {}, { progress: () => {}, tab: { id: 'seed' }, backends: [] })

  expect(!result.ok && result.url).toBe('https://example.com/')
  expect(!result.ok && result.error).toContain('ChatGPT is not ready in the browser (at https://example.com/).')
})

test('prepare refuses a chat that is still answering, unless the run is saving it', async () => {
  const busy = recording({ tabs: ['seed'], pages: [{ stop: true, turns: turns(2) }] })
  const refused = await prepare(busy.browser, {}, { progress: () => {}, tab: { id: 'seed' }, backends: [] })
  expect(refused).toEqual({ ok: false, url: 'https://chatgpt.com/', error: 'ChatGPT is still answering in that chat; wait and try again.' })

  const saving = recording({ tabs: ['seed'], pages: [{ stop: true, turns: turns(2) }] })
  const accepted = await prepare(saving.browser, {}, { progress: () => {}, tab: { id: 'seed' }, busy: true, backends: [] })
  expect(accepted).toMatchObject({ ok: true, tabId: 'seed', page: { stop: true, turns: turns(2) } })
})

test('blocked quotes a blocker on the page and says nothing without one', () => {
  expect(blocked({ blocker: '' })).toBe('')
  expect(blocked({ blocker: 'Unusual activity' })).toBe(' ChatGPT shows: "Unusual activity".')
})

test('chatUrlError accepts a chat link and names the link it refuses', () => {
  expect(chatUrlError('https://chatgpt.com/c/6ac52f21-493c')).toBeUndefined()
  expect(chatUrlError('https://chatgpt.com/')).toBe('chatUrl must be a chat link like https://chatgpt.com/c/<id>, not https://chatgpt.com/.')
})

test('pageStateOf reads the page state of a browser output, and names the browser when the output holds none', () => {
  expect(pageStateOf({ name: 'Claude in Chrome' }, printed({ href: 'https://chatgpt.com/', composer: true }))).toEqual({ href: 'https://chatgpt.com/', composer: true })
  expect(() => pageStateOf({ name: 'Claude in Chrome' }, printed({ tabs: [] }))).toThrow('Claude in Chrome returned no page state: ')
})
