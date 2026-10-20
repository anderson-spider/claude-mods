import type { HttpInit, HttpResponse } from 'claude-code'
import type { Browser, ProcessRunner } from './model'

// The plugin's own browser: a headless Chromium that helper/helper.mjs drives through Playwright and serves on a Unix
// socket (helper/lib/server.mjs holds the routes). The helper is started on demand and idles out by itself.

export const PLAYWRIGHT = 'headless Chromium'

export const PLAYWRIGHT_HINT = "Run /chatgpt-login to install the plugin's headless Chromium and sign in to ChatGPT there"

/** What the person does when the headless page is logged out; it replaces the not-ready advice for this backend. */
export const PLAYWRIGHT_SIGN_IN =
  'Ask the user to run /chatgpt-login, sign in to chatgpt.com in the window it opens and quit that browser (⌘Q on macOS), then try again; never type credentials.'

/** What the person does when something else keeps the headless page from being ready: nobody can clear it there. */
export const PLAYWRIGHT_BLOCKED =
  "Nobody can clear what the plugin's headless Chromium shows, so the plugin tries the other browsers in its place. " +
  'If it persists, the user can turn off "Headless Chromium first" (claude plugin configure chatgpt@spider-claude-mods) so requests ' +
  'skip it; never type credentials.'

export const NOT_SET_UP = 'it is not set up: /chatgpt-login installs it and opens the sign-in window'

export const NO_NODE = 'node was not found: the headless Chromium needs Node.js 20 or newer on PATH'

/** What the hooks hand the backend: `$.http.fetch`, `$.process.run`, the user's home, the plugin's folder and version. */
export type PlaywrightHost = {
  fetch(url: string, init: HttpInit): Promise<HttpResponse>
  run: ProcessRunner
  exists(path: string): Promise<boolean>
  home: string | undefined
  root: string
  version: string
}

/** Whether version `a` is older than `b` (dotted numbers), as helper/lib/daemon.mjs decides it. */
export function older(a: string, b: string): boolean {
  const parts = (version: string) => version.split('.').map(part => Number.parseInt(part, 10) || 0)
  const [x, y] = [parts(a), parts(b)]
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0)
  }
  return false
}

/** The helper's folder for the user whose home is `home`; its socket path must stay short (see helper/lib/paths.mjs). */
export const helperHome = (home: string) => `${home}/.claude/chatgpt/playwright`

const socketOf = (home: string) => `${helperHome(home)}/run/helper.sock`

/** The file whose presence says Playwright was installed (helper/lib/install.mjs installs it). */
export const installedMarker = (home: string) => `${helperHome(home)}/runtime/node_modules/playwright-core/package.json`

type Reply = { status: string; message?: string } & Record<string, unknown>

/** POSTs `body` to the helper's `route`; rejects when nothing answers on the socket. */
async function post(host: PlaywrightHost, home: string, route: string, body: unknown = {}): Promise<Reply> {
  const response = await host.fetch(`http://chatgpt-helper${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    socketPath: socketOf(home),
  })
  try {
    return JSON.parse(response.text) as Reply
  } catch {
    return { status: 'error', message: `the helper answered ${response.status} with something that is not JSON: ${response.text.slice(0, 200)}` }
  }
}

/** The one JSON line a helper command printed, or an error reply that carries what it said instead. */
export function helperReply(stdout: string, stderr = ''): Reply {
  const line = stdout.trim().split('\n').at(-1) ?? ''
  try {
    const parsed = JSON.parse(line) as Reply
    if (typeof parsed?.status === 'string') return parsed
  } catch {}
  return { status: 'error', message: (stderr || stdout).trim().slice(-300) || 'the helper printed nothing' }
}

// What a host process call rejects with when the command is not there.
const NOT_FOUND = /ENOENT|not found|no such file/i

/** Runs `node helper.mjs <command> --home <dir>`; node that cannot start answers NO_NODE, a run past its limit says so. */
async function helper(host: PlaywrightHost, home: string, command: 'start' | 'login', timeoutMs: number): Promise<Reply> {
  const argv = ['node', `${host.root}/helper/helper.mjs`, command, '--home', helperHome(home)]
  try {
    const done = await host.run(argv, { timeoutMs })
    return helperReply(done.stdout, done.stderr)
  } catch (error) {
    const said = error instanceof Error ? error.message : String(error)
    if (NOT_FOUND.test(said)) return { status: 'error', message: NO_NODE }
    return { status: 'error', message: `the helper's ${command} did not finish within ${timeoutMs / 60_000} minutes or failed: ${said.slice(0, 200)}` }
  }
}

const failed = (reply: Reply) => reply.message ?? `the helper answered ${reply.status}`

/**
 * The Browser on the helper, or why it cannot be used: not installed, no node, a helper that will not start, or a
 * browser that will not launch (the login window still open). A running helper of this version or newer is used as
 * is; an older one is replaced through `start`.
 */
export async function openPlaywright(host: PlaywrightHost): Promise<Browser | string> {
  const { home } = host
  if (!home) return 'HOME is not set'
  if (!(await host.exists(installedMarker(home)))) return NOT_SET_UP
  const health = await post(host, home, '/health').catch(() => undefined)
  if (health?.status !== 'ok' || older(String(health.version), host.version)) {
    // Past an older helper's drain and stop (up to 50 s) and the new one's start (up to 10 s).
    const started = await helper(host, home, 'start', 120_000)
    if (started.status === 'not-installed') return NOT_SET_UP
    if (started.status !== 'ok') return failed(started)
  }
  // Listing the tabs launches the browser, so a launch that fails is said here, and the chooser moves on.
  const first = await post(host, home, '/tabs')
  if (first.status !== 'ok') return failed(first)
  let listed: string[] | undefined = first.tabs as string[]

  const call = async (route: string, body: unknown) => {
    const reply = await post(host, home, route, body)
    if (reply.status !== 'ok') throw new Error(`${PLAYWRIGHT}: ${failed(reply)}`)
    return reply
  }
  return {
    name: PLAYWRIGHT,
    signIn: PLAYWRIGHT_SIGN_IN,
    notReady: PLAYWRIGHT_BLOCKED,
    tabs: async () => {
      const tabs = listed ?? ((await call('/tabs', {})).tabs as string[])
      listed = undefined
      return tabs
    },
    openTab: async url => String((await call('/open', { url })).tab),
    // Like the other backends, a wait that cannot run counts as not met.
    waitFor: async (tabId, fn, timeoutMs) => {
      const reply = await post(host, home, '/wait', { tab: tabId, fn, timeoutMs }).catch(() => undefined)
      return reply?.status === 'ok' && reply.ok === true
    },
    js: async (tabId, body) => JSON.stringify((await call('/eval', { tab: tabId, body })).value),
    upload: async (tabId, selector, files) => {
      await call('/upload', { tab: tabId, selector, files })
    },
  }
}

/** What /chatgpt-login answers: the window it opened, or why it could not. */
export async function signIn(host: PlaywrightHost): Promise<string> {
  if (!host.home) return '✗ HOME is not set'
  // The first run downloads Playwright and Chromium (a few hundred MB).
  const reply = await helper(host, host.home, 'login', 600_000)
  if (reply.status === 'opened') {
    return "A Chromium window opened on chatgpt.com. Sign in there, then quit that browser (⌘Q on macOS; closing the window leaves it running): ChatGPT requests run in the plugin's headless Chromium after that."
  }
  return `✗ ${failed(reply)}`
}
