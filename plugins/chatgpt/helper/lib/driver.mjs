import { randomBytes } from 'node:crypto'

import { PROFILE_BUSY } from './daemon.mjs'

// The plugin's own Chromium, through Playwright: one persistent profile, headless, launched on first use.
//
// chatgpt.com's Cloudflare check refuses a browser that calls itself HeadlessChrome, so the profile runs with the
// user agent the build reports, renamed to Chrome. The login window (login.mjs) is the same build with the real
// keychain, so the mock keychain Playwright uses on macOS stays off: the cookies it wrote stay readable.
export const LAUNCH = {
  headless: true,
  channel: 'chromium',
  args: ['--disable-blink-features=AutomationControlled'],
  ignoreDefaultArgs: ['--enable-automation', '--use-mock-keychain'],
  viewport: { width: 1280, height: 900 },
}

// How long a page script may run before its tab is given up on; the plugin's scripts return in seconds.
export const EVAL_MS = 60_000

// What Chromium says when another process holds the profile: the login window, here.
const IN_USE = /ProcessSingleton|SingletonLock|profile (?:appears to be |is )?(?:already )?in use/i

// How long `wait` rests after a check that failed for another reason than its timeout (a navigation destroyed the page's context).
const RETRY_MS = 250

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** The user agent `chromium` reports, with HeadlessChrome named Chrome. */
export async function userAgentOf(chromium) {
  const probe = await chromium.launch({ headless: true, channel: 'chromium' })
  try {
    const page = await probe.newPage()
    return (await page.evaluate(() => navigator.userAgent)).replace('HeadlessChrome', 'Chrome')
  } finally {
    await probe.close()
  }
}

/**
 * Tabs by id over the profile's pages, the Browser of hooks/model.ts on the helper's side. An id is `<instance>-<n>`:
 * `instance` is new for each daemon, so a session holding a tab id of a daemon that stopped never reaches a page the
 * next daemon gave another session. `readFile` reads an upload's bytes; `now` is the clock `wait` measures with.
 */
export function createDriver({ chromium, profile, readFile, now = Date.now, instance = randomBytes(3).toString('hex'), evalMs = EVAL_MS }) {
  let context
  let launching
  let next = 1
  const ids = new Map()
  // The blank page a launch opens, which the first `open` takes instead of opening another.
  const fresh = new Set()

  const track = page => {
    if (ids.has(page)) return
    ids.set(page, `${instance}-${next++}`)
    page.once('close', () => {
      ids.delete(page)
      fresh.delete(page)
    })
  }

  async function launch() {
    const userAgent = await userAgentOf(chromium)
    try {
      context = await chromium.launchPersistentContext(profile, { ...LAUNCH, userAgent })
    } catch (error) {
      throw IN_USE.test(String(error?.message)) ? new Error(PROFILE_BUSY) : error
    }
    for (const page of context.pages()) {
      track(page)
      fresh.add(page)
    }
    context.on('page', track)
    context.on('close', () => {
      context = undefined
      ids.clear()
      fresh.clear()
    })
  }

  // Concurrent first calls share one launch.
  const ready = () => {
    if (context) return Promise.resolve()
    launching ??= launch().finally(() => (launching = undefined))
    return launching
  }

  const pageOf = id => {
    for (const [page, own] of ids) if (own === id) return page
    throw new Error(`no tab ${id}`)
  }

  return {
    async tabs() {
      await ready()
      return [...ids.values()]
    },

    async open(url) {
      await ready()
      const [blank] = fresh
      fresh.delete(blank)
      const page = blank ?? (await context.newPage())
      track(page)
      await page.goto(url, { waitUntil: 'commit' })
      return ids.get(page)
    },

    // Like the other backends, a check that throws counts as not yet, and a navigation does not end the wait.
    async wait(id, fn, timeoutMs) {
      const page = pageOf(id)
      const deadline = now() + timeoutMs
      for (;;) {
        const left = deadline - now()
        if (left <= 0) return false
        try {
          await page.waitForFunction(fn, undefined, { timeout: left, polling: RETRY_MS })
          return true
        } catch (error) {
          if (page.isClosed()) throw new Error(`tab ${id} was closed`)
          if (error?.name === 'TimeoutError') return false
          await sleep(RETRY_MS)
        }
      }
    },

    // A function body that may await; the page's own value comes back, a string from every page script.
    async eval(id, body) {
      let timer
      const late = new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`the page script in tab ${id} did not finish in ${evalMs / 1000} s`)), evalMs)
      })
      try {
        return await Promise.race([pageOf(id).evaluate(`(async () => {\n${body}\n})()`), late])
      } finally {
        clearTimeout(timer)
      }
    },

    // Playwright's own action timeout bounds the wait for the input.
    async upload(id, selector, files) {
      const payloads = await Promise.all(files.map(async file => ({ name: file.name, mimeType: file.type, buffer: await readFile(file.path) })))
      await pageOf(id).setInputFiles(selector, payloads)
    },

    async close() {
      await context?.close()
    },
  }
}
