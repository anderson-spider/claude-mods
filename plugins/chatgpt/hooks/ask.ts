import type { AskInput, AskOptions, AskResult, Browser } from './model'
import { openRun, readAnswer, stopped, submit, unfinished, watch } from './conversation'

// The ask flow's noun for the saveOnly guard, and its poll interval.
const ASK = { noun: 'answer', pollMs: 3000 }

export async function ask(browser: Browser, input: AskInput, options: AskOptions = {}): Promise<AskResult> {
  const run = await openRun(browser, input, options, ASK)
  if (!run.ok) return run
  const { tabId, start: page, pollMs, timeoutMs, progress } = run

  // Saving what the chat holds: its last answer counts as the new one.
  const before = input.saveOnly ? page.count - 1 : page.count
  if (!input.saveOnly) {
    const failed = await submit(run, input)
    if (failed) return failed
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
