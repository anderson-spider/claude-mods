// The session panel's agents, keyed by the `agentId` their spawn answered: how each runs, the usage of its requests,
// its latest tools and how it ended; and the main session's usage and turns. Pure: the clock is injected.
import type { SessionHudPanel, SessionHudPanelAgent, SessionHudPanelMain, SessionHudUsage } from '../../types'

export const ZERO: SessionHudUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
export const EMPTY_PANEL: SessionHudPanel = { agents: [], main: { usage: ZERO, turns: [] } }

/** How many agents the panel keeps; the oldest finished go first. */
export const AGENTS_KEPT = 200
/** How many of an agent's latest tools it keeps by name. */
export const TOOLS_KEPT = 3
/** How far back the main session's turns are kept: the timeline's span. */
export const TIMELINE_MS = 15 * 60_000

const FIELDS = { input: 'input_tokens', output: 'output_tokens', cacheRead: 'cache_read_input_tokens', cacheWrite: 'cache_creation_input_tokens' } as const

/** A step's usage: an absent count is zero, a present one that is not a non-negative finite number spoils the whole usage. */
export function usageOf(raw: unknown): SessionHudUsage | null {
  if (!raw || typeof raw !== 'object') return null
  const out = { ...ZERO }
  for (const [key, field] of Object.entries(FIELDS) as [keyof SessionHudUsage, string][]) {
    const n = (raw as Record<string, unknown>)[field]
    if (n === undefined) continue
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return null
    out[key] = n
  }
  return out
}

export const addUsage = (a: SessionHudUsage, b: SessionHudUsage): SessionHudUsage =>
  ({ input: a.input + b.input, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite })

/** The tokens a usage sent: input and cache read and written. */
export const sent = (u: SessionHudUsage): number => u.input + u.cacheRead + u.cacheWrite

const replace = (list: SessionHudPanelAgent[], agent: SessionHudPanelAgent, next: SessionHudPanelAgent) => list.map(a => (a === agent ? next : a))

/** At most `limit` agents: the oldest finished go first, and a running agent is never dropped. */
export function capped(list: SessionHudPanelAgent[], limit = AGENTS_KEPT): SessionHudPanelAgent[] {
  const extra = list.length - limit
  if (extra <= 0) return list
  const dropped = new Set(list.filter(a => a.status !== 'running').slice(0, extra))
  return list.filter(a => !dropped.has(a))
}

/** A spawned agent of any type joins the list as running; a second spawn event for the same id changes nothing. */
export function spawned(list: SessionHudPanelAgent[], a: { agentId: string; type?: string; model?: string; now: number }, limit = AGENTS_KEPT): SessionHudPanelAgent[] {
  if (list.some(agent => agent.id === a.agentId)) return list
  const agent: SessionHudPanelAgent = {
    id: a.agentId, ...(a.type ? { type: a.type } : {}), ...(a.model ? { model: a.model } : {}),
    status: 'running', startedAt: a.now, usage: ZERO, requests: 0,
  }
  return capped([...list, agent], limit)
}

/** A resumed agent (SendMessage, a teammate's wake) runs again under its id, with its usage and tools kept. */
export function resumed(list: SessionHudPanelAgent[], agentId: string): SessionHudPanelAgent[] {
  const agent = list.find(a => a.id === agentId && a.status !== 'running')
  if (!agent) return list
  const { endedAt: _ended, endReason: _reason, ...rest } = agent
  return replace(list, agent, { ...rest, status: 'running' })
}

/** One request's usage: the model that answered and its tokens. A turn's end sums every request, so it leaves the context unknown. */
function used(agent: SessionHudPanelAgent, model: string | undefined, raw: unknown, oneRequest = true): SessionHudPanelAgent {
  const u = usageOf(raw)
  const answered = typeof (raw as { model?: unknown } | null | undefined)?.model === 'string' ? (raw as { model: string }).model : model
  const next: SessionHudPanelAgent = { ...agent, ...(answered ? { model: answered } : {}) }
  if (!u) return next
  return { ...next, usage: addUsage(agent.usage, u), requests: agent.requests + 1, ...(oneRequest ? { contextTokens: sent(u) } : {}) }
}

/** A running agent's request: its model, effort and usage; a step adds no agent. */
export function agentStepped(list: SessionHudPanelAgent[], agentId: string, step: { model?: string; effort?: string; usage: unknown }): SessionHudPanelAgent[] {
  const agent = list.find(a => a.id === agentId && a.status === 'running')
  if (!agent) return list
  const next = used(agent, step.model, step.usage)
  return replace(list, agent, step.effort ? { ...next, effort: step.effort } : next)
}

/** A tool as the panel names it: an MCP tool by its own name. */
export const toolName = (tool: string): string => (tool.startsWith('mcp__') ? tool.slice(tool.lastIndexOf('__') + 2) || tool : tool)

/** A running agent called a tool: its latest tools by name, its call count and, when the call failed, its error count. */
export function toolUsed(list: SessionHudPanelAgent[], agentId: string, tool: string, failed: boolean): SessionHudPanelAgent[] {
  const agent = list.find(a => a.id === agentId && a.status === 'running')
  if (!agent) return list
  const was = agent.activity ?? { tools: [], calls: 0, errors: 0 }
  const activity = { tools: [...was.tools, toolName(tool)].slice(-TOOLS_KEPT), calls: was.calls + 1, errors: was.errors + (failed ? 1 : 0) }
  return replace(list, agent, { ...agent, activity })
}

/** A running agent's turn ended: `answer` is done, an abort is cancelled, anything else failed; usage no step reported is taken from the end. */
export function agentEnded(list: SessionHudPanelAgent[], agentId: string, reason: string, now: number, usage?: unknown): SessionHudPanelAgent[] {
  const agent = list.find(a => a.id === agentId && a.status === 'running')
  if (!agent) return list
  const status = reason === 'answer' ? 'done' : reason === 'aborted' ? 'cancelled' : 'failed'
  const base = agent.requests === 0 && usage !== undefined ? used(agent, agent.model, usage, false) : agent
  return replace(list, agent, { ...base, status, endedAt: now, ...(status === 'failed' ? { endReason: reason } : {}) })
}

/** What the host says of an agent: its id and where its loop stands. */
export type HostAgent = { id: string; status: string }

const REASON: Readonly<Record<string, string>> = { idle: 'answer', completed: 'answer', failed: 'error', killed: 'aborted' }

/**
 * The running agents the host's list shows stopped, each with the reason to end it by. With `unlisted`, after a reload
 * or a restore, one the list no longer names ends too, as aborted: its ending was missed.
 */
export function endingsOf(list: SessionHudPanelAgent[], host: readonly HostAgent[], unlisted = false): { agentId: string; reason: string }[] {
  const byId = new Map(host.map(agent => [agent.id, agent.status]))
  return list.filter(a => a.status === 'running').flatMap(a => {
    const status = byId.get(a.id)
    if (status === undefined) return unlisted ? [{ agentId: a.id, reason: 'aborted' }] : []
    return REASON[status] ? [{ agentId: a.id, reason: REASON[status]! }] : []
  })
}

/** A main-session request: its tokens join the session's. */
export function mainStepped(main: SessionHudPanelMain, raw: unknown): SessionHudPanelMain {
  const u = usageOf(raw)
  return u ? { ...main, usage: addUsage(main.usage, u) } : main
}

/** A main-session turn ended at `now` after `durationMs`: its span joins those of the last 15 minutes. */
export function mainTurned(main: SessionHudPanelMain, now: number, durationMs: unknown): SessionHudPanelMain {
  if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs < 0) return main
  return { ...main, turns: [...main.turns.filter(([, end]) => end >= now - TIMELINE_MS), [now - durationMs, now]] }
}
