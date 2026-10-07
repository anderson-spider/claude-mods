import type { Browser, PageState, TabHolder } from './model'
import { CHATGPT_URL, LOAD_MS, ORIGIN } from './constants'
import { COMPOSER, LANDED, LOGIN, leaveScript, stateScript } from './scripts'

// Every page script returns JSON.stringify(...): terminal-browser's eval
// prints a string result as a JSON literal.
export function parseOutput<T>(text: string): T {
  try {
    return JSON.parse(JSON.parse(text.trim())) as T
  } catch {
    throw new Error(`unexpected browser output: ${text.slice(0, 200)}`)
  }
}

/** Whether `url` names one of the user's chats (`https://chatgpt.com/c/<id>`). */
export function isChatUrl(url: string): boolean {
  return /^https:\/\/chatgpt\.com\/c\/[\w-]+\/?$/.test(url)
}

/** Why `url` cannot be a `chatUrl`, or undefined when it can. */
export function chatUrlError(url: string): string | undefined {
  return isChatUrl(url) ? undefined : `chatUrl must be a chat link like https://chatgpt.com/c/<id>, not ${url}.`
}

/** Whether `url` starts a new chat: the home page. */
export function isNewChatUrl(url: string): boolean {
  return url === CHATGPT_URL
}

// Goes to `target` in the plugin's own tab, opening one when it is gone, and
// waits for the composer (or a login page); never touches a tab it did not
// open. The home page is a new chat, so going there is what the "New chat"
// button does.
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
        'Ask the user to log in to chatgpt.com in terminal-browser (or clear what the page shows) and try again; never type credentials.',
    }
  }
  if (page.stop && !options.busy) return { ok: false, url: page.href, error: 'ChatGPT is still answering in that chat; wait and try again.' }
  return { ok: true, tabId, page }
}

// terminal-browser names a tab by its browser's key and its own number; the
// plugin carries both as one id, `<key>:<tab>`.

// The JSON object a terminal-browser command prints, after any banner.
function jsonOf<T>(text: string): T | undefined {
  try {
    return JSON.parse(text.slice(text.indexOf('{'))) as T
  } catch {
    return undefined
  }
}

/** The ids of every browser's tabs, from `terminal-browser ls --json`. */
export function listTabs(text: string): string[] {
  const parsed = jsonOf<{ browsers?: { key: string; tabs?: { id: number }[] }[] }>(text)
  return (parsed?.browsers ?? []).flatMap(b => (b.tabs ?? []).map(t => `${b.key}:${t.id}`))
}

/** The `--browser` and `--tab` a `<key>:<tab>` id stands for. */
export function splitTabId(tabId: string): { browser: string; tab: string } {
  const at = tabId.lastIndexOf(':')
  return { browser: tabId.slice(0, at), tab: tabId.slice(at + 1) }
}

/**
 * The tab `terminal-browser new-tab <url>` opened, from its JSON output. When
 * it had to start a browser, `openedTab` is null and the tab is the new
 * browser's first.
 */
export function openedTab(text: string): string | undefined {
  const parsed = jsonOf<{ key?: string; openedTab?: number | null; tabs?: { id: number; active?: boolean }[] }>(text)
  if (!parsed?.key) return undefined
  const tab = parsed.openedTab ?? parsed.tabs?.find(t => t.active)?.id ?? parsed.tabs?.[0]?.id ?? 1
  return `${parsed.key}:${tab}`
}
