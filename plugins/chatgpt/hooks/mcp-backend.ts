import type { Browser } from './model'
import type { McpCall } from './mcp-call'
import { type BrowserDeps, pageBrowser } from './page-browser'
import { CHATGPT_URL } from './scripts'
import { isChatUrl } from './tab'
import { scriptText } from './tool-text'

/**
 * Whether a backend's call stays on chatgpt.com, so the plugin's `tool.check` hook may allow it: auto mode's
 * classifier gives no verdict on a call no prompt asked for. `listing` names the backend's tools that only list or
 * open tabs; a script runs only in `ownTab`, the plugin's tab as the backend names it.
 */
export function staysOnChatgpt(tool: string, input: unknown, listing: readonly string[], ownTab: string | undefined): boolean {
  const args = (input ?? {}) as Record<string, unknown>
  if (listing.includes(tool)) return true
  if (tool === 'navigate') return typeof args.url === 'string' && (args.url === CHATGPT_URL || isChatUrl(args.url))
  if (tool === 'javascript_tool') return args.action === 'javascript_exec' && ownTab !== undefined && String(args.tabId) === ownTab
  return false
}

/**
 * What differs between two MCP browser backends. A backend's tab ids are its own (`tabs` and `openTab` speak them);
 * the plugin's ids carry the backend as `<idPrefix><id>`, so a tab id means nothing in another backend.
 */
export type McpSpec = {
  /** The name `/chatgpt-doctor` and the chooser's report show. */
  name: string
  /** The MCP server's name: its tools are `mcp__<server>__<tool>`. */
  server: string
  /** The setup advice the chooser gives for this backend when none works; read in a sentence after "or". */
  hint: string
  /** What the plugin's tab ids start with, e.g. `chrome:`. */
  idPrefix: string
  /** The backend's tools that only list or open tabs (see `staysOnChatgpt`). */
  listing: readonly string[]
  /** Whether its javascript_tool returns a page script's last expression only when it is awaited (see `pageBrowser`). */
  awaitResult?: boolean
  /** How a script call names the backend's own tab id. */
  tabArg(id: string): string | number
  /** The ids of the backend's tabs; it throws when the backend cannot be reached or prints no tab list. */
  tabs(call: McpCall): Promise<string[]>
  /** Opens a tab at `url` and returns its id. */
  openTab(call: McpCall, url: string): Promise<string>
}

/** A backend driven through an MCP server: `stays` says which of the plugin's own calls to it stay on chatgpt.com. */
export type McpBackend = {
  name: string
  server: string
  hint: string
  /** The Browser on the server; it throws when the server cannot be reached, which is how the chooser moves on. */
  open(deps: BrowserDeps): Promise<Browser>
  stays(tool: string, input: unknown, tabId: string | undefined): boolean
}

/** The backend a spec describes: the same prefix, listing and tab naming serve its Browser and its `stays`. */
export function mcpBackend(spec: McpSpec): McpBackend {
  const { name, server, hint, idPrefix, listing } = spec
  const ownId = (id: string) => id.slice(idPrefix.length)
  return {
    name,
    server,
    hint,
    stays: (tool, input, tabId) => staysOnChatgpt(tool, input, listing, tabId?.startsWith(idPrefix) ? ownId(tabId) : undefined),
    open: async deps => {
      const { call } = deps
      const tabs = async () => (await spec.tabs(call)).map(id => `${idPrefix}${id}`)
      const page = {
        name,
        awaitResult: spec.awaitResult,
        tabs,
        openTab: async (url: string) => `${idPrefix}${await spec.openTab(call, url)}`,
        evaluate: async (id: string, expression: string) =>
          scriptText(await call('javascript_tool', { action: 'javascript_exec', tabId: spec.tabArg(ownId(id)), text: expression })),
      }
      await tabs()
      return pageBrowser(page, deps)
    },
  }
}
