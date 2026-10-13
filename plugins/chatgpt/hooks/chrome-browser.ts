import { type McpCall, leadingJson } from './mcp-browser'
import type { McpSpec } from './mcp-backend'

export const CHROME = 'Claude in Chrome'
export const CHROME_SERVER = 'claude-in-chrome'

// A tab that shows nothing yet: openTab reuses one rather than leaving another blank tab behind.
const BLANK = /^(chrome:\/\/newtab\/?|about:blank)$/

// What tabs_context_mcp prints: `tabGroupId` is absent (or null) when the MCP tab group does not exist yet.
type ListedTab = { tabId: number; url?: string }
type Listing = { tabGroupId?: number | null; availableTabs?: ListedTab[] }

// Lists the group without creating anything, so probing never leaves a tab behind.
async function listing(call: McpCall, args: Record<string, unknown> = {}): Promise<Listing> {
  const listed = leadingJson<Listing>(await call('tabs_context_mcp', args))
  if (!listed) throw new Error('unexpected output from tabs_context_mcp')
  return listed
}

// The group's tabs, and the one of them to use: the first of a group just started, else a blank one.
async function groupTab(call: McpCall): Promise<{ known: ListedTab[]; tab: number | undefined }> {
  const before = await listing(call)
  const known = before.availableTabs ?? []
  // With no group yet, createIfEmpty starts one, and its first tab is the one to use.
  const started = before.tabGroupId == null ? (await listing(call, { createIfEmpty: true })).availableTabs?.[0]?.tabId : undefined
  const blank = known.find(tab => BLANK.test(tab.url ?? ''))?.tabId
  return { known, tab: started ?? blank }
}

// A new tab in the group: the id tabs_create_mcp prints, else the listed tab `known` lacks.
async function newTab(call: McpCall, known: ListedTab[]): Promise<number | undefined> {
  const created = /Tab ID:\s*(\d+)/.exec(await call('tabs_create_mcp', {}))?.[1]
  return created ? Number(created) : (await listing(call)).availableTabs?.find(t => !known.some(k => k.tabId === t.tabId))?.tabId
}

/**
 * Claude in Chrome's MCP tab group. Its tab ids are numbers; the plugin's carry the backend as `chrome:<number>`.
 */
export const CHROME_SPEC: McpSpec = {
  name: CHROME,
  server: CHROME_SERVER,
  hint: 'connect Claude in Chrome',
  idPrefix: 'chrome:',
  listing: ['tabs_context_mcp', 'tabs_create_mcp'],
  tabArg: id => Number(id),
  tabs: async call => ((await listing(call)).availableTabs ?? []).map(tab => `${tab.tabId}`),
  openTab: async (call, url) => {
    const group = await groupTab(call)
    const tab = group.tab === undefined ? await newTab(call, group.known) : group.tab
    if (tab === undefined) throw new Error('Claude in Chrome opened no tab')
    await call('navigate', { url, tabId: tab })
    return `${tab}`
  },
}
