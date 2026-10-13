import type { AskInput, AskOptions, Browser, PageState } from './model'
import { blocked, isChatUrl, prepare } from './tab'
import { chipScript, inputFor, modelScript, parseOutput, READ_SCRIPT, sendScript, stateScript } from './scripts'

/** A blocker that ends a run at once (a limit, a verification), not just any dialog. */
export function isHardBlocker(text: string): boolean {
  return /limit|limite|cap\b|captcha|verif|unusual activity|atividade incomum|try again|tente novamente|too many|muitas/i.test(text)
}

/** A prepared run: the plugin's tab, the page as prepare left it, and the run's limits. */
export type OpenRun = {
  ok: true
  browser: Browser
  tabId: string
  start: PageState
  pollMs: number
  timeoutMs: number
  progress: (text: string) => void
}

/**
 * The prologue every flow shares: the saveOnly guard, then the plugin's tab at the chat (see `prepare`).
 * `flow` gives the noun the guard names and the flow's default poll interval.
 */
export async function openRun(
  browser: Browser,
  input: AskInput,
  options: AskOptions,
  flow: { noun: string; pollMs: number },
): Promise<OpenRun | { ok: false; error: string; url?: string }> {
  const timeoutMs = options.timeoutMs ?? 6 * 60_000
  const pollMs = options.pollMs ?? flow.pollMs
  const progress = options.progress ?? (() => {})
  if (input.saveOnly && input.chatUrl === undefined) return { ok: false, error: `saveOnly needs the chatUrl of the chat with the ${flow.noun}.` }
  const ready = await prepare(browser, input, { progress, tab: options.tab ?? {}, busy: input.saveOnly, backends: options.backends ?? [] })
  if (!ready.ok) return ready
  return { ok: true, browser, tabId: ready.tabId, start: ready.page, pollMs, timeoutMs, progress }
}

/** Picks the model, attaches the files and sends the prompt of a run; the failure as the run's answer, or undefined once sent. */
export async function submit(run: OpenRun, input: AskInput): Promise<{ ok: false; url: string; error: string } | undefined> {
  const failed = await compose(run.browser, run.tabId, input, run.progress)
  if (failed) return { ok: false, url: run.start.href, error: failed }
  const sent = await send(run.browser, run.tabId, input.prompt)
  if (!sent.ok) return { ok: false, url: run.start.href, error: sent.text }
  return undefined
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
    await browser.upload(tabId, inputFor(file.type), [file])
    const attached = parseOutput<{ attached: boolean; reason?: string }>(await browser.js(tabId, chipScript(file.name)))
    if (!attached.attached) return `Could not attach ${file.name}: ${attached.reason}.`
  }
  return undefined
}

// Sends the prompt in the composer; the text to answer when the page would not take it.
export async function send(browser: Pick<Browser, 'js'>, tabId: string, prompt: string): Promise<{ ok: true } | { ok: false; text: string }> {
  const sent = parseOutput<{ sent: boolean; reason?: string }>(await browser.js(tabId, sendScript(prompt)))
  return sent.sent ? { ok: true } : { ok: false, text: `Could not send the prompt: ${sent.reason}.` }
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
