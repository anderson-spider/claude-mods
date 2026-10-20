import type { HttpInit } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import type { ProcessRunner } from '../hooks/model'
import {
  NOT_SET_UP,
  NO_NODE,
  PLAYWRIGHT,
  PLAYWRIGHT_BLOCKED,
  PLAYWRIGHT_SIGN_IN,
  type PlaywrightHost,
  helperHome,
  helperReply,
  installedMarker,
  older,
  openPlaywright,
  signIn,
} from '../hooks/playwright-browser'

const HOME = '/home/u'
const SOCKET = '/home/u/.claude/chatgpt/playwright/run/helper.sock'

type Fake = {
  installed?: boolean
  /** The version `/health` reports; undefined: nothing answers until `start` runs. */
  running?: string
  /** What each helper command prints; `missing` makes node fail to start. */
  start?: string
  login?: string
  node?: 'missing'
  /** Replies by route, after the health check. */
  routes?: Record<string, unknown>
}

function fakeHost(fake: Fake = {}) {
  const calls: string[] = []
  const bodies: { route: string; body: unknown; socketPath?: string }[] = []
  const runs: { argv: string[]; timeoutMs?: number }[] = []
  let running = fake.running
  const run: ProcessRunner = async (argv, init) => {
    runs.push({ argv, timeoutMs: init?.timeoutMs })
    calls.push(`node ${argv[2]}`)
    if (fake.node === 'missing') throw new Error('spawn node ENOENT')
    const stdout = argv[2] === 'login' ? (fake.login ?? '{"status":"opened"}\n') : (fake.start ?? '{"status":"ok"}\n')
    if (argv[2] === 'start' && JSON.parse(stdout).status === 'ok') running = '1.0.0'
    return { exitCode: 0, stdout, stderr: '' }
  }
  const host: PlaywrightHost = {
    fetch: async (url: string, init: HttpInit) => {
      const route = url.replace('http://chatgpt-helper', '')
      calls.push(`post ${route}`)
      bodies.push({ route, body: JSON.parse(init.body ?? '{}'), socketPath: init.socketPath })
      if (route === '/health') {
        if (!running) throw new Error('connect ECONNREFUSED')
        return { status: 200, ok: true, headers: {}, text: JSON.stringify({ status: 'ok', version: running }) }
      }
      const reply = fake.routes?.[route] ?? { status: 'ok' }
      return { status: 200, ok: true, headers: {}, text: typeof reply === 'string' ? reply : JSON.stringify(reply) }
    },
    run,
    exists: async path => (calls.push(`exists ${path}`), fake.installed ?? true),
    home: HOME,
    root: '/plugin',
    version: '1.0.0',
  }
  return { host, calls, bodies, runs }
}

const TABS = { '/tabs': { status: 'ok', tabs: ['1'] } }

test('the helper lives under the home, and its socket path fits a Unix socket', () => {
  expect(helperHome(HOME)).toBe('/home/u/.claude/chatgpt/playwright')
  expect(installedMarker(HOME)).toBe('/home/u/.claude/chatgpt/playwright/runtime/node_modules/playwright-core/package.json')
  expect(new TextEncoder().encode(SOCKET).length).toBeLessThan(104)
})

test("a helper command's last line is its reply; anything else is an error carrying what it said", () => {
  expect(helperReply('downloading...\n{"status":"opened"}\n')).toEqual({ status: 'opened' })
  expect(helperReply('', 'npm ERR! network')).toEqual({ status: 'error', message: 'npm ERR! network' })
  expect(helperReply('{"no":"status"}')).toEqual({ status: 'error', message: '{"no":"status"}' })
  expect(helperReply('')).toEqual({ status: 'error', message: 'the helper printed nothing' })
})

test('with no HOME, or Playwright never installed, the backend says so without starting anything', async () => {
  const noHome = fakeHost()
  expect(await openPlaywright({ ...noHome.host, home: undefined })).toBe('HOME is not set')
  expect(noHome.calls).toEqual([])

  const fresh = fakeHost({ installed: false })
  expect(await openPlaywright(fresh.host)).toBe(NOT_SET_UP)
  expect(fresh.calls).toEqual([`exists ${installedMarker(HOME)}`])
})

test('a helper that is not running is started through node with its home, then the tabs are listed', async () => {
  const { host, calls, runs, bodies } = fakeHost({ routes: TABS })
  const browser = await openPlaywright(host)

  expect(typeof browser).toBe('object')
  expect(calls).toEqual([`exists ${installedMarker(HOME)}`, 'post /health', 'node start', 'post /tabs'])
  expect(runs).toEqual([{ argv: ['node', '/plugin/helper/helper.mjs', 'start', '--home', '/home/u/.claude/chatgpt/playwright'], timeoutMs: 120_000 }])
  expect(bodies.every(call => call.socketPath === SOCKET)).toBe(true)
})

test('a running helper of this version or newer is used as is; an older one is replaced through start', async () => {
  for (const running of ['1.0.0', '1.2.0']) {
    const kept = fakeHost({ running, routes: TABS })
    await openPlaywright(kept.host)
    expect(kept.calls).toEqual([`exists ${installedMarker(HOME)}`, 'post /health', 'post /tabs'])
  }

  const old = fakeHost({ running: '0.9.0', routes: TABS })
  await openPlaywright(old.host)
  expect(old.calls).toEqual([`exists ${installedMarker(HOME)}`, 'post /health', 'node start', 'post /tabs'])
})

test('older compares dotted versions as the helper does', () => {
  expect(older('0.10.4', '0.11.0')).toBe(true)
  expect(older('0.9.10', '0.10.0')).toBe(true)
  expect(older('1.2.0', '1.0.0')).toBe(false)
  expect(older('1.0.0', '1.0.0')).toBe(false)
})

test('a start that fails, no node, a missing browser or a launch that fails is the reason the chooser reports', async () => {
  expect(await openPlaywright(fakeHost({ start: '{"status":"not-installed","missing":"browser"}' }).host)).toBe(NOT_SET_UP)
  expect(await openPlaywright(fakeHost({ start: '{"status":"error","message":"the helper did not start; see /log"}' }).host)).toBe(
    'the helper did not start; see /log',
  )
  expect(await openPlaywright(fakeHost({ node: 'missing' }).host)).toBe(NO_NODE)
  // A run that fails for another reason than a missing node is said as it is, never as a missing node.
  const slow = fakeHost()
  slow.host.run = async () => Promise.reject(new Error('the command was still running after 60000 ms'))
  expect(await openPlaywright(slow.host)).toBe(
    "the helper's start did not finish within 2 minutes or failed: the command was still running after 60000 ms",
  )
  const locked = fakeHost({ routes: { '/tabs': { status: 'error', message: 'another Chromium holds the profile (the /chatgpt-login window?): quit it (⌘Q on macOS), then try again' } } })
  expect(await openPlaywright(locked.host)).toBe('another Chromium holds the profile (the /chatgpt-login window?): quit it (⌘Q on macOS), then try again')
})

test('the Browser speaks the helper routes: the first listing is reused, scripts come back as a JSON string literal', async () => {
  const { host, bodies } = fakeHost({
    running: '1.0.0',
    routes: { ...TABS, '/open': { status: 'ok', tab: '2' }, '/eval': { status: 'ok', value: '{"a":1}' }, '/wait': { status: 'ok', ok: true } },
  })
  const browser = await openPlaywright(host)
  if (typeof browser === 'string') throw new Error(browser)

  expect(browser.name).toBe(PLAYWRIGHT)
  expect(browser.signIn).toBe(PLAYWRIGHT_SIGN_IN)
  expect(browser.notReady).toBe(PLAYWRIGHT_BLOCKED)
  expect(await browser.tabs()).toEqual(['1'])
  expect(await browser.openTab('https://chatgpt.com/')).toBe('2')
  expect(await browser.js('2', 'return JSON.stringify({a: 1})')).toBe('"{\\"a\\":1}"')
  expect(await browser.waitFor('2', '!!document.body', 20_000)).toBe(true)
  await browser.upload('2', 'input[type=file]', [{ name: 'a.png', type: 'image/png', path: '/tmp/a.png' }])
  await browser.tabs()

  expect(bodies.slice(2).map(({ route, body }) => ({ route, body }))).toEqual([
    { route: '/open', body: { url: 'https://chatgpt.com/' } },
    { route: '/eval', body: { tab: '2', body: 'return JSON.stringify({a: 1})' } },
    { route: '/wait', body: { tab: '2', fn: '!!document.body', timeoutMs: 20_000 } },
    { route: '/upload', body: { tab: '2', selector: 'input[type=file]', files: [{ name: 'a.png', type: 'image/png', path: '/tmp/a.png' }] } },
    { route: '/tabs', body: {} },
  ])
})

test('a route that fails throws with the backend name, except a wait, which counts as not met', async () => {
  const { host } = fakeHost({
    running: '1.0.0',
    routes: { ...TABS, '/eval': { status: 'error', message: 'no tab 9' }, '/wait': { status: 'error', message: 'tab 9 was closed' } },
  })
  const browser = await openPlaywright(host)
  if (typeof browser === 'string') throw new Error(browser)

  await expect(browser.js('9', 'return 1')).rejects.toThrow('headless Chromium: no tab 9')
  expect(await browser.waitFor('9', 'true', 100)).toBe(false)
})

test('/chatgpt-login runs the helper login with a ten-minute limit and answers what happened', async () => {
  const opened = fakeHost()
  expect(await signIn(opened.host)).toBe(
    "A Chromium window opened on chatgpt.com. Sign in there, then quit that browser (⌘Q on macOS; closing the window leaves it running): ChatGPT requests run in the plugin's headless Chromium after that.",
  )
  expect(opened.runs).toEqual([{ argv: ['node', '/plugin/helper/helper.mjs', 'login', '--home', '/home/u/.claude/chatgpt/playwright'], timeoutMs: 600_000 }])

  expect(await signIn(fakeHost({ login: '{"status":"error","message":"npm install exited with 1"}' }).host)).toBe('✗ npm install exited with 1')
  expect(await signIn(fakeHost({ node: 'missing' }).host)).toBe(`✗ ${NO_NODE}`)
  expect(await signIn({ ...fakeHost().host, home: undefined })).toBe('✗ HOME is not set')
})
