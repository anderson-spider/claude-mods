import type { AskInput, AskOptions, Browser, PageState } from './model'
import { blocked, isChatUrl, prepare } from './tab'
import { chipScript, effortStepScript, inputFor, MODEL_CLOSE_SCRIPT, MODEL_ROWS_SCRIPT, modelClickScript, parseOutput, READ_SCRIPT, sendScript, stateScript } from './scripts'

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
  const choice = choiceOf(input)
  const wrong = choice ? await checkModel(run.browser, run.tabId, choice) : undefined
  if (wrong) return { ok: false, url: run.start.href, error: wrong }
  const sent = await send(run.browser, run.tabId, input.prompt)
  if (!sent.ok) return { ok: false, url: run.start.href, error: sent.text }
  return undefined
}

/** A model to pick by its menu label, and the effort to set on it; without `effort`, the model keeps the one it comes with. */
export type Choice = { model: string; effort?: string }

/** What a new chat runs with when the request names no model. */
export const DEFAULT_CHOICE: Choice = { model: 'GPT-6', effort: 'medium' }

/** What a run picks before it sends: the model asked for, else the default on a new chat; nothing on a chat that goes on. */
export function choiceOf(input: AskInput): Choice | undefined {
  if (input.model) return { model: input.model }
  return input.chatUrl === undefined ? DEFAULT_CHOICE : undefined
}

/** The effort the model button shows and where the effort slider stands; `at` is null without a slider. */
type Effort = { effort: string; at: number | null; min: number | null; max: number | null }

type ModelRows = { found: boolean; rows: { name: string; checked: boolean }[]; effort: Effort }

// What a model is matched by: one rollout of chatgpt.com names a row "GPT-6" and another only "6", so a
// "GPT" before the version number is not part of it.
const modelKey = (name: string) =>
  name
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^gpt[-\s]?(?=\d)/, '')

/** The index of the row `label` names among the menu's row names: the one named exactly, else the first whose name starts with it; -1 for none. */
export function modelRow(names: readonly string[], label: string): number {
  const want = modelKey(label)
  const keys = names.map(modelKey)
  const exact = keys.indexOf(want)
  return exact >= 0 ? exact : keys.findIndex(key => key.startsWith(want))
}

// Moves the effort slider to `effort`: down to its first step, then up one step at a time until the button
// shows it. The efforts a model offers differ, so the slider is walked rather than its steps named; a step
// that does not move it ends the walk. The error, or undefined once it shows `effort`.
async function setEffort(browser: Pick<Browser, 'js'>, tabId: string, effort: string, start: Effort, progress: (text: string) => void): Promise<string | undefined> {
  if (start.effort === effort) return undefined
  progress(`setting the effort to ${effort}`)
  if (start.at === null || start.min === null || start.max === null) return `Could not set the effort "${effort}": the model menu has no effort slider.`
  const seen = [start.effort]
  let state = start
  for (const key of ['ArrowLeft', 'ArrowRight'] as const) {
    const end = key === 'ArrowLeft' ? start.min : start.max
    while (state.at !== null && state.at !== end) {
      const next = parseOutput<Effort>(await browser.js(tabId, effortStepScript(key)))
      if (next.effort === effort) return undefined
      if (!seen.includes(next.effort)) seen.push(next.effort)
      if (next.at === state.at) break
      state = next
    }
  }
  return `Could not set the effort "${effort}": the slider offers ${seen.join(', ')}.`
}

// Picks the model and its effort, then attaches the files, in that order; an error string stops the run.
export async function compose(browser: Pick<Browser, 'js' | 'upload'>, tabId: string, input: AskInput, progress: (text: string) => void): Promise<string | undefined> {
  const choice = choiceOf(input)
  if (choice) {
    progress(`picking ${choice.model}`)
    const menu = parseOutput<ModelRows>(await browser.js(tabId, MODEL_ROWS_SCRIPT))
    if (!menu.found) return `Could not pick the model "${choice.model}": model menu not found.`
    const names = menu.rows.map(row => row.name)
    const index = modelRow(names, choice.model)
    if (index < 0) {
      await browser.js(tabId, MODEL_CLOSE_SCRIPT)
      const offered = names.length ? ` The menu offers: ${names.join(', ')}.` : ''
      return `Could not pick the model "${choice.model}": no such entry.${offered}`
    }
    const picked = parseOutput<{ clicked: boolean; effort: Effort }>(await browser.js(tabId, modelClickScript(index)))
    if (choice.effort) {
      const failed = await setEffort(browser, tabId, choice.effort, picked.effort, progress)
      if (failed) {
        await browser.js(tabId, MODEL_CLOSE_SCRIPT)
        return failed
      }
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

// Whether the model menu still has the choice's model checked, and its effort when it names one, read again
// just before the prompt goes; the error otherwise.
export async function checkModel(browser: Pick<Browser, 'js'>, tabId: string, choice: Choice): Promise<string | undefined> {
  const menu = parseOutput<ModelRows>(await browser.js(tabId, MODEL_ROWS_SCRIPT))
  if (menu.found) await browser.js(tabId, MODEL_CLOSE_SCRIPT)
  const checked = menu.rows.findIndex(row => row.checked)
  if (checked < 0 || checked !== modelRow(menu.rows.map(row => row.name), choice.model)) {
    const shown = checked >= 0 ? `"${menu.rows[checked]!.name}" checked` : 'no model checked'
    return `The model menu shows ${shown} instead of "${choice.model}"; the prompt was not sent.`
  }
  if (choice.effort && menu.effort?.effort !== choice.effort) {
    return `The model menu shows the effort "${menu.effort?.effort ?? ''}" instead of "${choice.effort}"; the prompt was not sent.`
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

/** Whether the chat's last exchange is one `known` does not hold: the run's own. */
export function isNewTurn(page: PageState, known: readonly string[]): boolean {
  const last = page.turns.at(-1)
  return last !== undefined && !known.includes(last)
}

type Watch<E extends string> = {
  /** The chat's exchanges before this run: a last exchange outside them is the run's. */
  known: readonly string[]
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
  const lengthOf = (p: PageState) => (isNewTurn(p, o.known) ? p.length : -1)
  let lastLength = lengthOf(page)
  const settledOf = (p: PageState) => isNewTurn(p, o.known) && !p.stop && p.length > 0 && p.length === lastLength
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

// A run whose stream dropped at `url`: timed out, since ChatGPT may still finish the answer there.
export function interrupted(url: string) {
  return { ok: false as const, url, timedOut: isChatUrl(url), error: `ChatGPT lost the connection while answering; the answer may still finish at ${url}.` }
}

// A run that ran out of time at `url`; `timedOut` when the chat may still finish there.
export function unfinished(url: string, page: PageState, timeoutMs: number, what: string, doing: string) {
  return {
    ok: false as const,
    url,
    timedOut: isChatUrl(url),
    error: `No ${what} after ${Math.round(timeoutMs / 1000)} s; it may still be ${doing} at ${url}.${blocked(page)}`,
  }
}
