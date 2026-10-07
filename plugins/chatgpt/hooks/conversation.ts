import type { AskInput, Browser, PageState } from './model'
import { blocked, isChatUrl } from './browser'
import { chipScript, inputFor, modelScript, parseOutput, READ_SCRIPT, stateScript } from './scripts'

/** A blocker that ends a run at once (a limit, a verification), not just any dialog. */
export function isHardBlocker(text: string): boolean {
  return /limit|limite|cap\b|captcha|verif|unusual activity|atividade incomum|try again|tente novamente|too many|muitas/i.test(text)
}

// Picks the model and attaches the files, in that order; an error string stops the run.
export async function compose(browser: Pick<Browser, 'js' | 'upload'>, tabId: string, input: AskInput, progress: (text: string) => void): Promise<string | undefined> {
  if (input.model) {
    progress(`picking ${input.model}`)
    const picked = parseOutput<{ picked: boolean; reason?: string; offered?: string[] }>(await browser.js(tabId, modelScript(input.model)))
    if (!picked.picked) {
      const offered = picked.offered?.length ? ` The menu offers: ${picked.offered.join(', ')}.` : ''
      return `Could not pick the model "${input.model}": ${picked.reason}.${offered}`
    }
  }
  for (const file of input.files ?? []) {
    progress(`attaching ${file.name}`)
    await browser.upload(tabId, inputFor(file.type), [file.path])
    const attached = parseOutput<{ attached: boolean; reason?: string }>(await browser.js(tabId, chipScript(file.name)))
    if (!attached.attached) return `Could not attach ${file.name}: ${attached.reason}.`
  }
  return undefined
}

type Answer = { url: string; markdown: string }

export async function readAnswer(browser: Pick<Browser, 'js'>, tabId: string): Promise<Answer> {
  const read = parseOutput<{ url: string; markdown: string; text: string }>(await browser.js(tabId, READ_SCRIPT))
  return { url: read.url, markdown: read.markdown || read.text }
}

type Watch<E extends string> = {
  /** How many answers the chat had before this run; a later one is the run's. */
  before: number
  pollMs: number
  timeoutMs: number
  /** How the run ended, or false while it goes on; `settled` is a new answer whose length held across two reads. */
  until: (page: PageState, settled: boolean) => E | false
  /** Called with each page read that is not the end yet. */
  onPoll: (page: PageState) => void
}

// Checks the page as it stands, then polls it until `until` names an end, a
// hard blocker shows, or time runs out.
export async function watch<E extends string>(
  browser: Pick<Browser, 'js'>,
  tabId: string,
  page: PageState,
  o: Watch<E>,
): Promise<{ end: E | 'blocked' | 'timeout'; page: PageState }> {
  const started = Date.now()
  const script = stateScript(o.pollMs)
  const lengthOf = (p: PageState) => (p.count > o.before ? p.length : -1)
  let lastLength = lengthOf(page)
  const settledOf = (p: PageState) => p.count > o.before && !p.stop && p.length > 0 && p.length === lastLength
  let end = o.until(page, settledOf(page))
  while (!end) {
    page = parseOutput<PageState>(await browser.js(tabId, script))
    end = o.until(page, settledOf(page))
    if (end) break
    if (page.blocker && !page.stop && isHardBlocker(page.blocker)) return { end: 'blocked', page }
    lastLength = lengthOf(page)
    if (Date.now() - started > o.timeoutMs) return { end: 'timeout', page }
    o.onPoll(page)
  }
  return { end, page }
}

export const stopped = (page: PageState) => ({ ok: false as const, url: page.href, error: `ChatGPT stopped: "${page.blocker}".` })

// A run that ran out of time at `url`; `timedOut` when the chat may still finish there.
export function unfinished(url: string, page: PageState, timeoutMs: number, what: string, doing: string) {
  return {
    ok: false as const,
    url,
    timedOut: isChatUrl(url),
    error: `No ${what} after ${Math.round(timeoutMs / 1000)} s; it may still be ${doing} at ${url}.${blocked(page)}`,
  }
}
