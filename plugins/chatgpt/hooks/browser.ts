import type { Browser, PageState, TabHolder } from './model'
import { COMPOSER, LANDED, LOGIN, leaveScript, parseOutput, stateScript } from './scripts'

export const CHATGPT_URL = 'https://chatgpt.com/'
export const ORIGIN = 'https://chatgpt.com'

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

type Ready = { ok: true; tabId: string; page: PageState } | { ok: false; error: string; url?: string }

export function blocked(page: { blocker: string }): string {
  return page.blocker ? ` ChatGPT shows: "${page.blocker}".` : ''
}

// Opens a new chat, or `chatUrl` to continue one, and waits for the composer.
// `busy` accepts a chat still answering (to save what it is writing).
export async function prepare(
  browser: Pick<Browser, 'tabs' | 'openTab' | 'js' | 'waitFor'>,
  input: { chatUrl?: string },
  options: { progress: (text: string) => void; tab: TabHolder; busy?: boolean },
): Promise<Ready> {
  const { chatUrl } = input
  const invalid = chatUrl === undefined ? undefined : chatUrlError(chatUrl)
  if (invalid) return { ok: false, error: invalid }
  options.progress('opening chatgpt.com')
  const tabId = await findTab(browser, chatUrl ?? CHATGPT_URL, options.tab)

  let page = parseOutput<PageState>(await browser.js(tabId, stateScript(0)))
  if (!page.href.startsWith(ORIGIN) || page.login || !page.composer) {
    return {
      ok: false,
      url: page.href,
      error:
        `ChatGPT is not ready in the browser (at ${page.href}).${blocked(page)} ` +
        'Ask the user to log in to chatgpt.com in the browser the plugin uses (terminal-browser, Claude in Chrome or the Claude app\'s built-in browser), or to clear what the page shows, and try again; never type credentials.',
    }
  }
  if (page.stop && !options.busy) return { ok: false, url: page.href, error: 'ChatGPT is still answering in that chat; wait and try again.' }
  return { ok: true, tabId, page }
}
