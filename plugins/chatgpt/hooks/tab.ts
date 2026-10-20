import type { Browser, PageState, TabHolder } from './model'
import { CHATGPT_URL, COMPOSER, LANDED, LOGIN, ORIGIN, leaveScript, parseOutput, stateScript } from './scripts'

// How long a page may take to load and show the composer.
export const LOAD_MS = 20_000

/** Whether `url` names one of the user's chats (`https://chatgpt.com/c/<id>`). */
export function isChatUrl(url: string): boolean {
  return /^https:\/\/chatgpt\.com\/c\/[\w-]+\/?$/.test(url)
}

/** Why `url` cannot be a `chatUrl`, or undefined when it can. */
export function chatUrlError(url: string): string | undefined {
  return isChatUrl(url) ? undefined : `chatUrl must be a chat link like https://chatgpt.com/c/<id>, not ${url}.`
}

/**
 * The page report a backend's page script printed, parsed as `T`. A result of another shape (a page script that
 * returned no value, say) fails here, named after the backend that answered it.
 */
export function pageStateOf<T extends { href: string } = PageState>(browser: Pick<Browser, 'name'>, text: string): T {
  const state = parseOutput<Partial<T>>(text)
  if (typeof state?.href !== 'string') throw new Error(`${browser.name} returned no page state: ${text.slice(0, 200)}`)
  return state as T
}

// Goes to `target` in the plugin's own tab, opening one when it is gone, and
// waits for the composer (or a login page); never touches a tab it did not
// open. The home page is a new chat, so going there is what the "New chat"
// button does. The browser's `open` action would open a new tab instead of navigating, so the tab
// is moved by script (`leaveScript`).
export async function findTab(browser: Pick<Browser, 'tabs' | 'openTab' | 'js' | 'waitFor'>, target: string, holder: TabHolder): Promise<string> {
  if (holder.id && (await browser.tabs()).includes(holder.id)) {
    await browser.js(holder.id, leaveScript(target))
    await browser.waitFor(holder.id, LANDED, LOAD_MS)
  } else {
    holder.id = await browser.openTab(target)
  }
  await browser.waitFor(holder.id, `!!${COMPOSER} || ${LOGIN}`, LOAD_MS)
  return holder.id
}

// "A, B or C": the browsers the plugin tries, as the advice names them.
function orList(names: readonly string[]): string {
  return names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} or ${names.at(-1)}`
}

type Ready = { ok: true; tabId: string; page: PageState } | { ok: false; error: string; url?: string; held?: boolean }

export function blocked(page: { blocker: string }): string {
  return page.blocker ? ` ChatGPT shows: "${page.blocker}".` : ''
}

// Opens a new chat, or `chatUrl` to continue one, and waits for the composer.
// `busy` accepts a chat still answering (to save what it is writing); `backends` names the browsers the plugin tries
// (it cannot import them: the list lives in a module that imports this one).
export async function prepare(
  browser: Pick<Browser, 'name' | 'signIn' | 'notReady' | 'tabs' | 'openTab' | 'js' | 'waitFor'>,
  input: { chatUrl?: string },
  options: { progress: (text: string) => void; tab: TabHolder; busy?: boolean; backends: readonly string[] },
): Promise<Ready> {
  const { chatUrl } = input
  const invalid = chatUrl === undefined ? undefined : chatUrlError(chatUrl)
  if (invalid) return { ok: false, error: invalid }
  options.progress('opening chatgpt.com')
  const tabId = await findTab(browser, chatUrl ?? CHATGPT_URL, options.tab)

  let page = pageStateOf(browser, await browser.js(tabId, stateScript(0)))
  if (!page.href.startsWith(ORIGIN) || page.login || !page.composer) {
    const named = options.backends.length ? ` (${orList(options.backends)})` : ''
    const general = `Ask the user to log in to chatgpt.com in the browser the plugin uses${named}, or to clear what the page shows, and try again; never type credentials.`
    const notReady = (advice: string) => `ChatGPT is not ready in the browser (at ${page.href}).${blocked(page)} ${advice}`
    if (page.login) return { ok: false, url: page.href, error: notReady(browser.signIn ?? general) }
    // Nobody sees this backend's page, so nobody can clear what holds it (see Browser.notReady).
    if (browser.notReady) return { ok: false, url: page.href, error: notReady(browser.notReady), held: true }
    return { ok: false, url: page.href, error: notReady(general) }
  }
  if (page.stop && !options.busy) return { ok: false, url: page.href, error: 'ChatGPT is still answering in that chat; wait and try again.' }
  return { ok: true, tabId, page }
}
