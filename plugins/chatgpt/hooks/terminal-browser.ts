import type { Browser, ProcessRunner } from './model'

export const TERMINAL_BROWSER = 'terminal-browser'

// A tab new-tab just opened takes a moment to accept automation.
export const STARTING = /no CDP target yet/

// The JSON object a terminal-browser command prints, after any banner.
export function jsonOf<T>(text: string): T | undefined {
  try {
    return JSON.parse(text.slice(text.indexOf('{'))) as T
  } catch {
    return undefined
  }
}

/**
 * The ids of every browser's tabs, from `terminal-browser ls --json`.
 * terminal-browser names a tab by its browser's key and its own number; the
 * plugin carries both as one id, `<key>:<tab>`.
 */
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

async function terminalBrowser(run: ProcessRunner, args: string[], timeoutMs = 120_000): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    const done = await run([TERMINAL_BROWSER, ...args], { timeoutMs })
    if (done.exitCode === 0) return done.stdout
    const said = (done.stderr || done.stdout).trim()
    // A host process call does not use up the hook's time, unlike a clock sleep.
    if (STARTING.test(said) && attempt < 40) await run(['sleep', '0.25'])
    else throw new Error(`terminal-browser ${args[0]}: ${said.slice(0, 400)}`)
  }
}

// `listed` is the `ls --json` output `browserOf` already has, so the first
// `tabs` call does not run it again.
function terminalBrowserOf(run: ProcessRunner, listed?: string): Browser {
  const select = (tabId: string) => {
    const { browser, tab } = splitTabId(tabId)
    return ['action', '--browser', browser, '--tab', tab, '--']
  }
  return {
    tabs: async () => {
      const text = listed ?? (await terminalBrowser(run, ['ls', '--json']))
      listed = undefined
      return listTabs(text)
    },
    // new-tab opens the browser too (in a split, since this is no TTY) when none is open.
    openTab: async url => {
      const id = openedTab(await terminalBrowser(run, ['new-tab', url]))
      if (!id) throw new Error('terminal-browser new-tab did not name a tab')
      return id
    },
    waitFor: (tabId, fn, timeoutMs) =>
      terminalBrowser(run, [...select(tabId), 'wait', '--fn', fn, '--timeout', String(timeoutMs)], timeoutMs + 10_000).then(
        () => true,
        () => false,
      ),
    // Every page script is a function body; eval refuses a top-level `await` but waits for a returned promise, hence the async wrapper.
    js: (tabId, body) => terminalBrowser(run, [...select(tabId), 'eval', `(async () => {\n${body}\n})()`]),
    upload: async (tabId, selector, files) => {
      await terminalBrowser(run, [...select(tabId), 'upload', selector, ...files.map(file => file.path)])
    },
  }
}

export const NO_PANE = 'not running inside a terminal pane terminal-browser can drive'

// terminal-browser answers only where Claude Code runs in a terminal pane it
// can find (Ghostty, kitty); not under tmux, Herdr or a background session.
// The string is why it cannot answer; the chooser in browsers.ts says so for it.
export async function openTerminalBrowser(run: ProcessRunner): Promise<Browser | string> {
  const listed = await run([TERMINAL_BROWSER, 'ls', '--json'], { timeoutMs: 15_000 }).catch(() => undefined)
  if (listed?.exitCode === 0) {
    // Outside a pane it can drive, terminal-browser exits 0 with no pane (`self` null) and no browser: nothing to drive.
    const parsed = jsonOf<{ self?: unknown; browsers?: unknown[] }>(listed.stdout)
    if (parsed?.self === null && (parsed.browsers ?? []).length === 0) return NO_PANE
    return terminalBrowserOf(run, listed.stdout)
  }
  if (!listed) return 'terminal-browser is not installed (https://terminal-browser.sh)'
  return (listed.stderr || listed.stdout).trim().slice(0, 300) || 'it exited with an error and no output'
}
