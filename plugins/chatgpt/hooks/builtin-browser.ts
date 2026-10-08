import type { Browser } from './model'
import { type BrowserDeps, leadingJson, pageBrowser, scriptText } from './mcp-browser'

export const BUILTIN = "the Claude app's built-in browser"
export const BUILTIN_SERVER = 'Claude_Browser'

// The built-in browser's tab ids are strings; the plugin's ids carry the backend as `builtin:<id>`.
const PREFIX = 'builtin:'

const idOf = (id: string) => id.slice(PREFIX.length)

/**
 * The Browser on the Claude desktop app's built-in browser pane. It keeps its own
 * sign-ins, so chatgpt.com must be logged in there. It throws when the pane cannot
 * be reached, which is how the chooser knows to stop trying it.
 */
export async function builtinBrowserOf(deps: BrowserDeps): Promise<Browser> {
  const { call } = deps
  const tabs = async () => {
    const listed = leadingJson<{ tabs?: { tabId: string }[] }>(await call('tabs_context', {}))
    if (!listed) throw new Error('unexpected output from tabs_context')
    return (listed.tabs ?? []).map(tab => `${PREFIX}${tab.tabId}`)
  }
  const page = {
    tabs,
    openTab: async (url: string) => {
      if ((await tabs()).length === 0) {
        // With no pane open, navigate opens one, and the tab it returns is the one navigated.
        const opened = leadingJson<{ tabId?: string }>(await call('navigate', { url }))
        if (!opened?.tabId) throw new Error('the built-in browser opened no tab')
        return `${PREFIX}${opened.tabId}`
      }
      // With the pane open, navigate with no tabId would move the person's own tab, so the plugin opens its own.
      const created = leadingJson<{ tabId?: string }>(await call('tabs_create', { foreground: false }))
      if (!created?.tabId) throw new Error('the built-in browser opened no tab')
      await call('navigate', { url, tabId: created.tabId })
      return `${PREFIX}${created.tabId}`
    },
    evaluate: async (id: string, expression: string) =>
      scriptText(await call('javascript_tool', { action: 'javascript_exec', tabId: idOf(id), text: expression })),
  }
  await tabs()
  return pageBrowser(page, deps)
}
