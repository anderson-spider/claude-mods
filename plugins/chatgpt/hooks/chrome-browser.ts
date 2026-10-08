import type { Browser } from './model'
import { type BrowserDeps, leadingJson, pageBrowser, scriptText } from './mcp-browser'

export const CHROME = 'Claude in Chrome'
export const CHROME_SERVER = 'claude-in-chrome'

// Chrome's tab ids are numbers; the plugin's ids carry the backend as `chrome:<number>`.
const PREFIX = 'chrome:'

const numberOf = (id: string) => Number(id.slice(PREFIX.length))

// A tab that shows nothing yet: openTab reuses one rather than leaving another blank tab behind.
const BLANK = /^(chrome:\/\/newtab\/?|about:blank)$/

// What tabs_context_mcp prints: `tabGroupId` is absent (or null) when the MCP tab group does not exist yet.
type Listing = { tabGroupId?: number | null; availableTabs?: { tabId: number; url?: string }[] }

/**
 * The Browser on Claude in Chrome's MCP tab group. It throws when Chrome cannot
 * be reached, which is how the chooser knows to try the next backend.
 */
export async function chromeBrowserOf(deps: BrowserDeps): Promise<Browser> {
  const { call } = deps
  // Lists the group without creating anything, so probing never leaves a tab behind.
  const listing = async (args: Record<string, unknown> = {}): Promise<Listing> => {
    const listed = leadingJson<Listing>(await call('tabs_context_mcp', args))
    if (!listed) throw new Error('unexpected output from tabs_context_mcp')
    return listed
  }
  const tabs = async () => ((await listing()).availableTabs ?? []).map(tab => `${PREFIX}${tab.tabId}`)
  const page = {
    tabs,
    openTab: async (url: string) => {
      const before = await listing()
      const known = before.availableTabs ?? []
      // With no group yet, createIfEmpty starts one, and its first tab is the one to use.
      const started = before.tabGroupId == null ? (await listing({ createIfEmpty: true })).availableTabs?.[0]?.tabId : undefined
      const blank = known.find(tab => BLANK.test(tab.url ?? ''))?.tabId
      let tab = started ?? blank
      if (tab === undefined) {
        const created = /Tab ID:\s*(\d+)/.exec(await call('tabs_create_mcp', {}))?.[1]
        tab = created ? Number(created) : (await listing()).availableTabs?.find(t => !known.some(k => k.tabId === t.tabId))?.tabId
      }
      if (tab === undefined) throw new Error('Claude in Chrome opened no tab')
      await call('navigate', { url, tabId: tab })
      return `${PREFIX}${tab}`
    },
    evaluate: async (id: string, expression: string) =>
      scriptText(await call('javascript_tool', { action: 'javascript_exec', tabId: numberOf(id), text: expression })),
  }
  await tabs()
  return pageBrowser(page, deps)
}
