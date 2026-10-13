import type { Browser, ProcessRunner, TabHolder } from './model'
import { BUILTIN, BUILTIN_SERVER, builtinBrowserOf, builtinStaysOnChatgpt } from './builtin-browser'
import { CHROME, CHROME_SERVER, chromeBrowserOf, chromeStaysOnChatgpt } from './chrome-browser'
import type { BrowserDeps } from './mcp-browser'
import { TERMINAL_BROWSER, openTerminalBrowser } from './terminal-browser'

/** The plugin's own name: the origin the host reports for its calls. */
const PLUGIN = 'chatgpt'

// A backend: terminal-browser runs as a host process; the others are MCP servers, whose `stays` says which of the
// plugin's own calls to them stay on chatgpt.com.
export type Backend =
  | { name: string; open(run: ProcessRunner): Promise<Browser | string> }
  | {
      name: string
      server: string
      open(deps: BrowserDeps): Promise<Browser>
      stays(tool: string, input: unknown, tabId: string | undefined): boolean
    }

/** The backends in the order the plugin tries them. */
export const BACKENDS: Backend[] = [
  { name: TERMINAL_BROWSER, open: openTerminalBrowser },
  { name: CHROME, server: CHROME_SERVER, open: chromeBrowserOf, stays: chromeStaysOnChatgpt },
  { name: BUILTIN, server: BUILTIN_SERVER, open: builtinBrowserOf, stays: builtinStaysOnChatgpt },
]

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
