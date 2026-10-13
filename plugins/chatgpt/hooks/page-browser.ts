import type { Browser } from './model'
import type { McpCall } from './mcp-call'
import { uploadFiles } from './upload'

export type BrowserDeps = {
  call: McpCall
  readBytes(path: string): Promise<Uint8Array>
  /** Waits `ms` (a host process call, so the hook's clock budget is not spent meanwhile). */
  sleep(ms: number): Promise<void>
  /** The wall clock, in ms. */
  now(): number
}

// How often waitFor looks again inside a page.
const STEP_MS = 250

// Polls `check` until it is true or `timeoutMs` of wall-clock time (by `now`) has passed. The time a check takes
// counts too, so slow checks cannot stretch the timeout; a check that throws (a navigation may destroy the page) counts as not yet.
export async function pollUntil(
  check: () => Promise<boolean>,
  sleep: (ms: number) => Promise<void>,
  timeoutMs: number,
  now: () => number,
): Promise<boolean> {
  const started = now()
  for (;;) {
    if (await check().catch(() => false)) return true
    if (now() - started >= timeoutMs) return false
    await sleep(STEP_MS)
  }
}

/** What a backend must say: its name, its tabs, how it opens one, and how it runs a function body in a tab. */
export type Page = {
  name: string
  /** Whether the backend's javascript_tool returns the last expression's value only when it is awaited (see `run`). */
  awaitResult?: boolean
  tabs(): Promise<string[]>
  openTab(url: string): Promise<string>
  /** Runs `expression` in the tab, a page-context program whose last expression is the result; returns its text, as `scriptText` reads it. */
  evaluate(tabId: string, expression: string): Promise<string>
}

/** The Browser the flows use, built on a backend's `Page`. */
export function pageBrowser(page: Page, deps: Pick<BrowserDeps, 'readBytes' | 'sleep' | 'now'>): Browser {
  // A backend whose tool returns the last expression's value (awaitResult) gets an awaited IIFE: a bare async IIFE
  // would return its Promise, which serializes as {}. Other backends keep the bare IIFE they always had.
  const run = (tabId: string, body: string) => page.evaluate(tabId, `${page.awaitResult ? 'await ' : ''}(async () => {\n${body}\n})()`)
  return {
    name: page.name,
    tabs: () => page.tabs(),
    openTab: url => page.openTab(url),
    waitFor: (tabId, fn, timeoutMs) =>
      pollUntil(async () => (await run(tabId, `return JSON.stringify(Boolean(${fn}))`)) === 'true', deps.sleep, timeoutMs, deps.now),
    js: async (tabId, body) => JSON.stringify(await run(tabId, body)),
    upload: (tabId, selector, files) => uploadFiles(body => run(tabId, body), deps.readBytes, selector, files),
  }
}
