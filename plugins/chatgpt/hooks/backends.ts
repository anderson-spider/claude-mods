import type { Browser, ProcessRunner, TabHolder } from './model'
import { BUILTIN_SPEC } from './builtin-browser'
import { CHROME_SPEC } from './chrome-browser'
import { type McpBackend, mcpBackend } from './mcp-backend'
import { TERMINAL_BROWSER, openTerminalBrowser } from './terminal-browser'

/** The plugin's own name: the origin the host reports for its calls. */
const PLUGIN = 'chatgpt'

// A backend: terminal-browser runs as a host process; the others are MCP servers (see `mcpBackend`), whose `stays` says
// which of the plugin's own calls to them stay on chatgpt.com. Every backend's `hint` is its setup advice, which the
// chooser strings together when none works.
export type Backend =
  | { name: string; hint: string; open(run: ProcessRunner): Promise<Browser | string> }
  | McpBackend

/**
 * The backends in the order the plugin tries them outside the desktop app (see `backendsFor`), and the only place
 * that lists them: the chooser's advice, the "not ready" advice and the plugin's own-call allow below all read this
 * list. A new MCP backend is a spec here (or in a module of its own, like the two below) and its row in
 * `tests/backends.test.ts`.
 */
export const BACKENDS: Backend[] = [
  {
    name: TERMINAL_BROWSER,
    hint: 'Run Claude Code in a Ghostty or kitty pane with terminal-browser (https://terminal-browser.sh)',
    open: openTerminalBrowser,
  },
  mcpBackend(CHROME_SPEC),
  mcpBackend(BUILTIN_SPEC),
]

/** What the Claude desktop app sets `CLAUDE_CODE_ENTRYPOINT` to. */
export const DESKTOP_ENTRYPOINT = 'claude-desktop'

/** BACKENDS in the order to try them in a session started from `entrypoint`: inside the desktop app, its built-in browser first. */
export function backendsFor(entrypoint: string | undefined): Backend[] {
  if (entrypoint !== DESKTOP_ENTRYPOINT) return BACKENDS
  const builtin = (backend: Backend) => backend.name === BUILTIN_SPEC.name
  return [...BACKENDS.filter(builtin), ...BACKENDS.filter(backend => !builtin(backend))]
}

export type OwnCall = { prefix: string; stays: (tool: string, input: unknown, tabId: string | undefined) => boolean }

/** Which of the plugin's own calls to each browser server stay on chatgpt.com, by the tool's `mcp__` prefix. */
export const OWN_CALLS: OwnCall[] = BACKENDS.flatMap(backend => ('server' in backend ? [{ prefix: `mcp__${backend.server}__`, stays: backend.stays }] : []))

/**
 * Whether `tool.check` allows a call outright: only the plugin's own call (`plugin` is the call's origin) to a browser
 * backend's tool that stays on chatgpt.com, in the plugin's own `tab`. The model's calls and every other tool go on to
 * the session's rules.
 */
export function ownCallAllowed({ plugin, tool, input, tab }: { plugin: string; tool: string; input: unknown; tab: TabHolder }): boolean {
  if (plugin !== PLUGIN) return false
  const own = OWN_CALLS.find(({ prefix }) => tool.startsWith(prefix))
  return own !== undefined && own.stays(tool.slice(own.prefix.length), input, tab.id)
}
