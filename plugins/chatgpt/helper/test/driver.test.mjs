import assert from 'node:assert/strict'
import { test } from 'node:test'

import { LAUNCH, LOGIN_OPEN, createDriver, userAgentOf } from '../lib/driver.mjs'

const HEADLESS_UA = 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/156.0.0.0 Safari/537.36'

/** A page that records what reached it; `checks` scripts each waitForFunction call: 'ok', 'timeout' or 'navigated'. */
function fakePage(log, checks = []) {
  const listeners = {}
  const page = {
    closed: false,
    goto: async (url, options) => log.push(['goto', url, options]),
    waitForFunction: async (fn, _arg, options) => {
      log.push(['waitForFunction', fn, options.polling])
      const next = checks.shift() ?? 'ok'
      if (next === 'timeout') throw Object.assign(new Error('Timeout exceeded'), { name: 'TimeoutError' })
      if (next === 'navigated') throw new Error('Execution context was destroyed')
      if (next === 'closed') {
        page.closed = true
        throw new Error('Target closed')
      }
    },
    isClosed: () => page.closed,
    evaluate: async expression => (log.push(['evaluate', expression]), typeof expression === 'function' ? HEADLESS_UA : '{"ok":true}'),
    setInputFiles: async (selector, payloads) => log.push(['setInputFiles', selector, payloads]),
    once: (event, listener) => (listeners[event] = listener),
    close: () => listeners.close?.(),
  }
  return page
}

function fakeChromium({ launchError, checks } = {}) {
  const log = []
  const blank = fakePage(log, checks)
  const pages = [blank]
  const listeners = {}
  const context = {
    pages: () => pages,
    newPage: async () => {
      const page = fakePage(log, checks)
      pages.push(page)
      listeners.page?.(page)
      return page
    },
    on: (event, listener) => (listeners[event] = listener),
    close: async () => (log.push(['close']), listeners.close?.()),
  }
  const chromium = {
    launch: async options => {
      log.push(['launch', options])
      return { newPage: async () => fakePage(log), close: async () => log.push(['probe closed']) }
    },
    launchPersistentContext: async (profile, options) => {
      log.push(['launchPersistentContext', profile, options])
      if (launchError) throw new Error(launchError)
      return context
    },
  }
  return { chromium, log, blank, context }
}

test('the user agent the build reports is renamed from HeadlessChrome to Chrome, and the probe browser is closed', async () => {
  const { chromium, log } = fakeChromium()
  assert.equal(await userAgentOf(chromium), HEADLESS_UA.replace('HeadlessChrome', 'Chrome'))
  assert.deepEqual(log.at(0), ['launch', { headless: true, channel: 'chromium' }])
  assert.deepEqual(log.at(-1), ['probe closed'])
})

test('the profile launches headless on the full build, without the automation flag or the mock keychain, under the renamed user agent', async () => {
  const { chromium, log } = fakeChromium()
  const driver = createDriver({ chromium, profile: '/home/profile', readFile: async () => Buffer.from(''), instance: 'i' })

  assert.deepEqual(await driver.tabs(), ['i-1'])
  const launched = log.find(([kind]) => kind === 'launchPersistentContext')
  assert.deepEqual(launched, ['launchPersistentContext', '/home/profile', { ...LAUNCH, userAgent: HEADLESS_UA.replace('HeadlessChrome', 'Chrome') }])
  assert.equal(LAUNCH.headless, true)
  assert.equal(LAUNCH.channel, 'chromium')
  assert.deepEqual(LAUNCH.ignoreDefaultArgs, ['--enable-automation', '--use-mock-keychain'])
})

test('concurrent first calls share one launch', async () => {
  const { chromium, log } = fakeChromium()
  const driver = createDriver({ chromium, profile: '/p', readFile: async () => Buffer.from(''), instance: 'i' })
  await Promise.all([driver.tabs(), driver.tabs(), driver.open('https://chatgpt.com/')])
  assert.equal(log.filter(([kind]) => kind === 'launchPersistentContext').length, 1)
})

test('a profile another Chromium holds is the login window, said so', async () => {
  const { chromium } = fakeChromium({ launchError: 'Failed to create a ProcessSingleton for your profile directory.' })
  const driver = createDriver({ chromium, profile: '/p', readFile: async () => Buffer.from(''), instance: 'i' })
  await assert.rejects(driver.tabs(), { message: LOGIN_OPEN })
})

test('any other launch failure passes through as it came', async () => {
  const { chromium } = fakeChromium({ launchError: 'Executable does not exist' })
  const driver = createDriver({ chromium, profile: '/p', readFile: async () => Buffer.from(''), instance: 'i' })
  await assert.rejects(driver.tabs(), { message: 'Executable does not exist' })
})

test('the first open takes the blank page a launch opens; later ones open new pages, and a closed page leaves the list', async () => {
  const { chromium, log, blank } = fakeChromium()
  const driver = createDriver({ chromium, profile: '/p', readFile: async () => Buffer.from(''), instance: 'i' })

  assert.equal(await driver.open('https://chatgpt.com/'), 'i-1')
  assert.equal(await driver.open('https://chatgpt.com/c/abc'), 'i-2')
  assert.deepEqual(await driver.tabs(), ['i-1', 'i-2'])
  assert.deepEqual(
    log.filter(([kind]) => kind === 'goto'),
    [
      ['goto', 'https://chatgpt.com/', { waitUntil: 'commit' }],
      ['goto', 'https://chatgpt.com/c/abc', { waitUntil: 'commit' }],
    ],
  )
  blank.close()
  assert.deepEqual(await driver.tabs(), ['i-2'])
  await assert.rejects(driver.eval('i-1', 'return 1'), { message: 'no tab i-1' })
})

test('tab ids carry the daemon instance, so an id from a daemon that stopped matches no page of the next one', async () => {
  const first = createDriver({ chromium: fakeChromium().chromium, profile: '/p', readFile: async () => Buffer.from(''), instance: 'aaa' })
  const second = createDriver({ chromium: fakeChromium().chromium, profile: '/p', readFile: async () => Buffer.from(''), instance: 'bbb' })
  const held = await first.open('https://chatgpt.com/')
  assert.equal(held, 'aaa-1')
  assert.deepEqual(await second.tabs(), ['bbb-1'])
  assert.equal((await second.tabs()).includes(held), false)
  const unnamed = createDriver({ chromium: fakeChromium().chromium, profile: '/p', readFile: async () => Buffer.from('') })
  assert.match((await unnamed.tabs())[0], /^[0-9a-f]{6}-1$/)
})

test('a page script that never settles is given up on after evalMs', async () => {
  const { chromium } = fakeChromium()
  const driver = createDriver({ chromium, profile: '/p', readFile: async () => Buffer.from(''), instance: 'i', evalMs: 20 })
  await driver.tabs()
  const page = (await chromium.launchPersistentContext()).pages()[0]
  page.evaluate = () => new Promise(() => {})
  await assert.rejects(driver.eval('i-1', 'await new Promise(() => {})'), { message: 'the page script in tab i-1 did not finish in 0.02 s' })
})

test('a closed browser is launched again on the next call', async () => {
  const { chromium, log } = fakeChromium()
  const driver = createDriver({ chromium, profile: '/p', readFile: async () => Buffer.from(''), instance: 'i' })
  await driver.tabs()
  await driver.close()
  await driver.tabs()
  assert.equal(log.filter(([kind]) => kind === 'launchPersistentContext').length, 2)
})

test('eval runs the body as an async function and answers the page value', async () => {
  const { chromium, log } = fakeChromium()
  const driver = createDriver({ chromium, profile: '/p', readFile: async () => Buffer.from(''), instance: 'i' })
  await driver.tabs()
  assert.equal(await driver.eval('i-1', 'return JSON.stringify({ok: true})'), '{"ok":true}')
  assert.deepEqual(log.at(-1), ['evaluate', '(async () => {\nreturn JSON.stringify({ok: true})\n})()'])
})

test('wait is true once the expression holds, false on its timeout, and looks again after a navigation', async () => {
  const fixed = () => 0
  for (const [checks, expected, calls] of [
    [['ok'], true, 1],
    [['timeout'], false, 1],
    [['navigated', 'ok'], true, 2],
  ]) {
    const { chromium, log } = fakeChromium({ checks: [...checks] })
    const driver = createDriver({ chromium, profile: '/p', readFile: async () => Buffer.from(''), now: fixed, instance: 'i' })
    await driver.tabs()
    assert.equal(await driver.wait('i-1', '!!document.body', 5000), expected)
    const waits = log.filter(([kind]) => kind === 'waitForFunction')
    assert.equal(waits.length, calls)
    assert.deepEqual(waits[0], ['waitForFunction', '!!document.body', 250])
  }
})

test('wait stops at its deadline even when every check fails for another reason, and a closed tab ends it with an error', async () => {
  let clock = 0
  const { chromium } = fakeChromium({ checks: ['navigated', 'navigated', 'navigated'] })
  const driver = createDriver({ chromium, profile: '/p', readFile: async () => Buffer.from(''), now: () => (clock += 400), instance: 'i' })
  await driver.tabs()
  assert.equal(await driver.wait('i-1', 'false', 1000), false)

  const closing = fakeChromium({ checks: ['closed'] })
  const other = createDriver({ chromium: closing.chromium, profile: '/p', readFile: async () => Buffer.from(''), now: () => 0, instance: 'i' })
  await other.tabs()
  await assert.rejects(other.wait('i-1', 'false', 1000), { message: 'tab i-1 was closed' })
})

test('upload sets the files on the selector with the name and type the hooks read, from the bytes on disk', async () => {
  const { chromium, log } = fakeChromium()
  const read = []
  const driver = createDriver({
    chromium,
    profile: '/p',
    readFile: async path => (read.push(path), Buffer.from(path)),
    instance: 'i',
  })
  await driver.tabs()
  await driver.upload('i-1', 'input[type=file]', [{ name: 'a.png', type: 'image/png', path: '/tmp/x.png' }])
  assert.deepEqual(read, ['/tmp/x.png'])
  assert.deepEqual(log.at(-1), ['setInputFiles', 'input[type=file]', [{ name: 'a.png', mimeType: 'image/png', buffer: Buffer.from('/tmp/x.png') }]])
})
