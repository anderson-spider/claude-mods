import { expect, test } from 'claude-code/testing'
import { isHardBlocker, send, watch } from '../hooks/conversation'
import type { PageState } from '../hooks/model'
import { stateScript } from '../hooks/scripts'
import { basePage, printed } from './fake-page'

test('send reports why the prompt could not be sent, and nothing on success', async () => {
  const answering = (value: unknown) => ({ js: async () => printed(value) })
  expect(await send(answering({ sent: false, reason: 'no composer' }), 't1', 'hello')).toEqual({ ok: false, text: 'Could not send the prompt: no composer.' })
  expect(await send(answering({ sent: true }), 't1', 'hello')).toEqual({ ok: true })
})

// watch: the first comparison of the page against itself, and the length that must hold across two reads.

const pageOf = (state: Partial<PageState> = {}): PageState => ({ ...basePage, href: 'https://chatgpt.com/c/abc', ...state })

// A browser whose state polls answer `polls` in order (the last one repeats), recording every script it runs.
function polled(polls: Partial<PageState>[]) {
  const ran: { tabId: string; body: string }[] = []
  const browser = {
    js: async (tabId: string, body: string) => {
      const state = polls[Math.min(ran.length, polls.length - 1)] ?? {}
      ran.push({ tabId, body })
      return printed(pageOf(state))
    },
  }
  return { browser, ran }
}

// `until` that records each (page, settled) pair and ends on a settled new answer, as `ask` does.
function settledAnswer() {
  const seen: { count: number; length: number; stop: boolean; settled: boolean }[] = []
  const reads: PageState[] = []
  return {
    seen,
    reads,
    options: (before: number, extra: { pollMs?: number; timeoutMs?: number } = {}) => ({
      before,
      pollMs: extra.pollMs ?? 0,
      timeoutMs: extra.timeoutMs ?? 60_000,
      until: (page: PageState, settled: boolean) => {
        seen.push({ count: page.count, length: page.length, stop: page.stop, settled })
        return settled && ('answer' as const)
      },
      onPoll: (page: PageState) => {
        reads.push(page)
      },
    }),
  }
}

test('watch compares the starting page against itself: a settled new answer ends the run with no poll', async () => {
  const { browser, ran } = polled([{ count: 9, length: 1 }])
  const w = settledAnswer()
  const start = pageOf({ count: 2, length: 40 })

  const watched = await watch(browser, 't1', start, w.options(1))

  expect(watched).toEqual({ end: 'answer', page: start })
  expect(w.seen).toEqual([{ count: 2, length: 40, stop: false, settled: true }])
  expect(ran).toEqual([])
  expect(w.reads).toEqual([])
})

test('watch does not take a starting page as settled while it streams, is empty or holds no new answer', async () => {
  // Each start page, with how many polls it takes for two equal reads of a 40-char new answer to follow it.
  const starts: { state: Partial<PageState>; polls: number }[] = [
    // Streaming: its length is held, so the first read at the same length with no stop button settles.
    { state: { count: 2, length: 40, stop: true }, polls: 1 },
    // Empty: the first read differs from 0, the second equals the first.
    { state: { count: 2, length: 0 }, polls: 2 },
    // No new answer yet (count not past `before`): nothing is held, two reads are needed.
    { state: { count: 1, length: 40 }, polls: 2 },
    { state: { count: 0, length: 40 }, polls: 2 },
  ]
  for (const { state, polls } of starts) {
    const { browser, ran } = polled([{ count: 2, length: 40 }])
    const w = settledAnswer()

    const watched = await watch(browser, 't1', pageOf(state), w.options(1))

    expect(w.seen[0]?.settled).toBe(false)
    expect(watched.end).toBe('answer')
    expect(ran).toHaveLength(polls)
  }
})

test('watch settles when a new answer has the same length on two reads in a row', async () => {
  const { browser, ran } = polled([
    { count: 2, length: 10 },
    { count: 2, length: 25 },
    { count: 2, length: 25 },
    { count: 2, length: 99 },
  ])
  const w = settledAnswer()
  const start = pageOf({ count: 1 })

  const watched = await watch(browser, 't7', start, w.options(1, { pollMs: 25 }))

  expect(w.seen.map(s => s.settled)).toEqual([false, false, false, true])
  expect(w.seen.map(s => s.length)).toEqual([0, 10, 25, 25])
  expect(watched.end).toBe('answer')
  expect(watched.page.length).toBe(25)
  expect(ran).toHaveLength(3)
  // Every poll runs the state script for the poll length, in the tab it was given.
  for (const run of ran) expect(run).toEqual({ tabId: 't7', body: stateScript(25) })
  // onPoll sees each read that was not the end.
  expect(w.reads.map(p => p.length)).toEqual([10, 25])
})

test('watch compares each read with the one before it, so a still-growing answer never settles', async () => {
  const { browser, ran } = polled([
    { count: 2, length: 10 },
    { count: 2, length: 20 },
    { count: 2, length: 30 },
    { count: 2, length: 40 },
  ])
  const seen: boolean[] = []

  const watched = await watch(browser, 't1', pageOf({ count: 1 }), {
    before: 1,
    pollMs: 0,
    timeoutMs: 60_000,
    until: (_page, settled) => {
      seen.push(settled)
      return seen.length === 5 && 'cut'
    },
    onPoll: () => {},
  })

  expect(watched.end).toBe('cut')
  expect(seen).toEqual([false, false, false, false, false])
  expect(ran).toHaveLength(4)
})

test('watch keeps the length across a read that still streams, and starts over when the answer count falls back', async () => {
  // Streaming at 30 chars, then the same 30 without the stop button: settled on the second read.
  const streaming = polled([
    { count: 2, length: 30, stop: true },
    { count: 2, length: 30, stop: false },
  ])
  const a = settledAnswer()
  const watchedStreaming = await watch(streaming.browser, 't1', pageOf({ count: 1 }), a.options(1))
  expect(a.seen.map(s => s.settled)).toEqual([false, false, true])
  expect(watchedStreaming.end).toBe('answer')
  expect(streaming.ran).toHaveLength(2)

  // The count falls back to the old answers (a chat reload): the held length is forgotten.
  const reloaded = polled([
    { count: 2, length: 30 },
    { count: 1, length: 30 },
    { count: 2, length: 30 },
    { count: 2, length: 30 },
  ])
  const b = settledAnswer()
  const watchedReloaded = await watch(reloaded.browser, 't1', pageOf({ count: 1 }), b.options(1))
  expect(b.seen.map(s => s.settled)).toEqual([false, false, false, false, true])
  expect(watchedReloaded.end).toBe('answer')
  expect(reloaded.ran).toHaveLength(4)
})

test('watch never settles on an empty answer', async () => {
  const { browser } = polled([{ count: 2, length: 0 }])
  const seen: boolean[] = []

  const watched = await watch(browser, 't1', pageOf({ count: 2, length: 0 }), {
    before: 1,
    pollMs: 0,
    timeoutMs: 60_000,
    until: (_page, settled) => {
      seen.push(settled)
      return seen.length === 4 && 'cut'
    },
    onPoll: () => {},
  })

  expect(watched.end).toBe('cut')
  expect(seen).toEqual([false, false, false, false])
})

test('watch stops at a hard blocker that is not a streaming page, and not at a soft one or while streaming', async () => {
  const w = settledAnswer()
  const hard = polled([{ count: 1, blocker: 'You have reached the usage limit' }])
  const blocked = await watch(hard.browser, 't1', pageOf({ count: 1 }), w.options(1))
  expect(blocked.end).toBe('blocked')
  expect(blocked.page.blocker).toBe('You have reached the usage limit')
  expect(w.reads).toEqual([])

  // A hard blocker while the stop button shows, or a dialog that is not a limit, goes on.
  const ignored = polled([
    { count: 1, blocker: 'You have reached the usage limit', stop: true },
    { count: 1, blocker: 'Cookie preferences' },
    { count: 2, length: 5 },
    { count: 2, length: 5 },
  ])
  const w2 = settledAnswer()
  const watched = await watch(ignored.browser, 't1', pageOf({ count: 1 }), w2.options(1))
  expect(watched.end).toBe('answer')
  expect(ignored.ran).toHaveLength(4)
  expect(w2.reads.map(p => p.blocker)).toEqual(['You have reached the usage limit', 'Cookie preferences', ''])
})

test('watch lets an end named by until win over a blocker on the same read', async () => {
  const { browser } = polled([{ count: 2, length: 5, blocker: 'limit' }])
  const w = settledAnswer()

  const watched = await watch(browser, 't1', pageOf({ count: 2, length: 5, stop: true }), w.options(1))

  expect(watched.end).toBe('answer')
  expect(watched.page.blocker).toBe('limit')
})

test('watch times out after the read that passes the budget, and a blocker is reported before the timeout', async () => {
  // A negative budget is spent as soon as one read is done, whatever the clock says.
  const slow = polled([{ count: 1 }, { count: 2, length: 5 }])
  const w = settledAnswer()
  const timedOut = await watch(slow.browser, 't1', pageOf({ count: 1 }), w.options(1, { timeoutMs: -1 }))
  expect(timedOut).toEqual({ end: 'timeout', page: pageOf({ count: 1 }) })
  expect(slow.ran).toHaveLength(1)
  expect(w.reads).toEqual([])

  const stopped = polled([{ count: 1, blocker: 'Too many requests' }])
  const w2 = settledAnswer()
  const blocked = await watch(stopped.browser, 't1', pageOf({ count: 1 }), w2.options(1, { timeoutMs: -1 }))
  expect(blocked.end).toBe('blocked')
})

test('watch returns whatever end `until` names, a plain string for the image flow too', async () => {
  const { browser, ran } = polled([{ stop: true }, { stop: false }])
  const watched = await watch(browser, 't1', pageOf({ stop: true }), {
    before: 0,
    pollMs: 0,
    timeoutMs: 60_000,
    until: page => !page.stop && 'finished',
    onPoll: () => {},
  })
  expect(watched.end).toBe('finished')
  expect(ran).toHaveLength(2)
})

test('isHardBlocker stops on limits and verifications, not on any dialog', () => {
  expect(isHardBlocker("You've reached your limit for image generation")).toBe(true)
  expect(isHardBlocker('Você atingiu o limite. Tente novamente mais tarde.')).toBe(true)
  expect(isHardBlocker('a human verification (captcha)')).toBe(true)
  expect(isHardBlocker('Copied to clipboard')).toBe(false)
})
