import { leadingJson } from './mcp-browser'
import type { McpSpec } from './mcp-backend'

export const BUILTIN = "the Claude app's built-in browser"
export const BUILTIN_SERVER = 'Claude_Browser'

/**
 * The Claude desktop app's built-in browser pane. It keeps its own sign-ins, so chatgpt.com must be logged in there.
 * Its tab ids are strings; the plugin's carry the backend as `builtin:<id>`.
 */
export const BUILTIN_SPEC: McpSpec = {
  name: BUILTIN,
  server: BUILTIN_SERVER,
  hint: "log in to chatgpt.com in the Claude app's built-in browser",
  idPrefix: 'builtin:',
  listing: ['tabs_context', 'tabs_create'],
  tabArg: id => id,
  tabs: async call => {
    const listed = leadingJson<{ tabs?: { tabId: string }[] }>(await call('tabs_context', {}))
    if (!listed) throw new Error('unexpected output from tabs_context')
    return (listed.tabs ?? []).map(tab => `${tab.tabId}`)
  },
  openTab: async (call, url) => {
    if ((await BUILTIN_SPEC.tabs(call)).length === 0) {
      // With no pane open, navigate opens one, and the tab it returns is the one navigated.
      const opened = leadingJson<{ tabId?: string }>(await call('navigate', { url }))
      if (!opened?.tabId) throw new Error('the built-in browser opened no tab')
      return opened.tabId
    }
    // With the pane open, navigate with no tabId would move the person's own tab, so the plugin opens its own.
    const created = leadingJson<{ tabId?: string }>(await call('tabs_create', { foreground: false }))
    if (!created?.tabId) throw new Error('the built-in browser opened no tab')
    await call('navigate', { url, tabId: created.tabId })
    return created.tabId
  },
}
