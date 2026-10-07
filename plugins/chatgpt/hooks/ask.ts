import type { AskInput, AskOptions, AskResult, Browser } from './model'
import { prepare } from './browser'
import { compose, readAnswer, stopped, unfinished, watch } from './conversation'
import { parseOutput, sendScript } from './scripts'

export async function ask(browser: Browser, input: AskInput, options: AskOptions = {}): Promise<AskResult> {
  const timeoutMs = options.timeoutMs ?? 6 * 60_000
  const pollMs = options.pollMs ?? 3000
  const progress = options.progress ?? (() => {})
  const tab = options.tab ?? {}

  if (input.saveOnly && input.chatUrl === undefined) return { ok: false, error: 'saveOnly needs the chatUrl of the chat with the answer.' }
  const ready = await prepare(browser, input, { progress, tab, busy: input.saveOnly })
  if (!ready.ok) return ready
  const { tabId, page } = ready

  // Saving what the chat holds: its last answer counts as the new one.
  const before = input.saveOnly ? page.count - 1 : page.count
  if (!input.saveOnly) {
    const failed = await compose(browser, tabId, input, progress)
    if (failed) return { ok: false, url: page.href, error: failed }
    const sent = parseOutput<{ sent: boolean; reason?: string }>(await browser.js(tabId, sendScript(input.prompt)))
    if (!sent.sent) return { ok: false, url: page.href, error: `Could not send the prompt: ${sent.reason}.` }
  }

  progress('waiting for the answer')
  const watched = await watch(browser, tabId, page, {
    before,
    pollMs,
    timeoutMs,
    until: (_page, settled) => settled && 'answer',
    onPoll: p => progress(p.count > before ? `receiving (${p.length} chars)` : 'waiting for the answer'),
  })
  if (watched.end === 'blocked') return stopped(watched.page)
  if (watched.end === 'timeout') {
    const partial = await readAnswer(browser, tabId)
    const markdown = watched.page.count > before ? partial.markdown : undefined
    return { ...unfinished(partial.url, watched.page, timeoutMs, 'complete answer', 'streaming'), markdown }
  }

  const { url, markdown } = await readAnswer(browser, tabId)
  if (!markdown) return { ok: false, url, error: 'The answer was empty or the page layout changed.' }
  return { ok: true, url, markdown }
}
