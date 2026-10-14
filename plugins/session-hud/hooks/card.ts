// Pure updates of the card from what the host reported. register.tsx owns every `$` call and passes the figures in.
import type { SessionHudAgent, SessionHudCard, SessionHudLimit, SessionHudTurn } from '../types'
import { cacheShare } from './usage'

export const EMPTY: SessionHudCard = { limits: [], edits: 0, errors: 0, turns: 0, output: 0, agents: [], history: [] }

/** The turns the card keeps: the history chart draws one bar each. */
export const HISTORY = 12

/** What the host measures: the context and the rate-limit windows (`session.measure`, `$.session.usage()`). */
export type Measured = {
  context: { tokens?: number; window: number; percent?: number }
  rateLimits: readonly SessionHudLimit[]
}

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n)

/** A measurement replaces the context and the windows. */
export function measured(card: SessionHudCard, usage: Measured): SessionHudCard {
  const { tokens, window, percent } = usage.context
  const context = finite(window) ? { window, ...(finite(tokens) ? { tokens } : {}), ...(finite(percent) ? { percent } : {}) } : undefined
  const limits = usage.rateLimits.filter(limit => typeof limit.kind === 'string' && finite(limit.percentUsed))
    .map(limit => ({ kind: limit.kind, percentUsed: limit.percentUsed, ...(typeof limit.resetsAt === 'string' ? { resetsAt: limit.resetsAt } : {}) }))
  return context ? { ...card, limits, context } : { ...card, limits }
}

const count = (n: unknown): n is number => finite(n) && n >= 0

type StepUsage = { model: string; input_tokens: number; output_tokens?: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }

/** Whether a step's request read or wrote the prompt cache. */
export const touchedCache = (usage: StepUsage | null): boolean =>
  usage !== null && count(usage.cache_read_input_tokens) && count(usage.cache_creation_input_tokens) && usage.cache_read_input_tokens + usage.cache_creation_input_tokens > 0

/** The prompt cache was read or written at `at`. */
export const cacheUsed = (card: SessionHudCard, at: unknown): SessionHudCard => (finite(at) ? { ...card, cacheUsedAt: at } : card)

/** A main-session step: its effort and, from its usage, the model that answered, the cache share, its output tokens and the running turn's context (the first prompt, the last prompt plus its output). */
export function stepped(card: SessionHudCard, effort: unknown, usage: StepUsage | null): SessionHudCard {
  const next = { ...card }
  if (typeof effort === 'string') next.effort = effort
  if (usage) {
    if (typeof usage.model === 'string') next.model = usage.model
    const share = cacheShare(usage)
    if (share !== undefined) next.cache = share
    const output = count(usage.output_tokens) ? usage.output_tokens : undefined
    if (output !== undefined) next.output = card.output + output
    const { input_tokens: input, cache_read_input_tokens: read, cache_creation_input_tokens: written } = usage
    if (count(input) && count(read) && count(written) && output !== undefined) {
      const prompt = input + read + written
      next.pending = { before: card.pending?.before ?? prompt, after: prompt + output, output: (card.pending?.output ?? 0) + output }
    }
  }
  return next
}

/** A model switch: the cache's lifetime as the host reported it (`5m` or `1h`, anything else kept as it was); a switch to another model forfeits the cache, so its last use is forgotten. */
export function switched(card: SessionHudCard, ttl: unknown, from: unknown, to: unknown): SessionHudCard {
  const next: SessionHudCard = ttl === '5m' || ttl === '1h' ? { ...card, cacheTtl: ttl } : { ...card }
  if (from !== to) delete next.cacheUsedAt
  return next
}

/** A compaction ran: the next turn to join the history is marked. */
export const compactedNow = (card: SessionHudCard): SessionHudCard => ({ ...card, compacted: true })

/** The window the host compacts against (`rawMaxTokens` of a context breakdown); anything but a positive count leaves it. */
export const windowed = (card: SessionHudCard, window: unknown): SessionHudCard =>
  finite(window) && window > 0 ? { ...card, contextWindow: window } : card

/** A main-session turn began: its context starts afresh. */
export function began(card: SessionHudCard): SessionHudCard {
  const { pending: _left, ...rest } = card
  return rest
}

/** The running main-session turn began at `at`. */
export const timed = (card: SessionHudCard, at: unknown): SessionHudCard => (finite(at) ? { ...card, turnStartedAt: at } : card)

const turnsOf = (card: SessionHudCard): SessionHudTurn[] => (Array.isArray(card.history) ? card.history : [])

/** A main-session turn ended after `durationMs`: it is no longer running, it counts, and its context joins the history. */
export function completed(card: SessionHudCard, durationMs: unknown): SessionHudCard {
  const { turnStartedAt: _ended, pending, compacted, ...rest } = card
  const history = pending ? [...turnsOf(card), compacted ? { ...pending, compacted } : pending].slice(-HISTORY) : turnsOf(card)
  const counted: SessionHudCard = { ...rest, history, turns: card.turns + 1, ...(!pending && compacted ? { compacted } : {}) }
  return finite(durationMs) && durationMs >= 0 ? { ...counted, lastTurnMs: durationMs } : counted
}

const EDITS: ReadonlySet<string> = new Set(['Write', 'Edit', 'NotebookEdit'])

/** A main-session tool call, after its result: a successful edit or an error counts; anything else leaves the card as it is. */
export function tooled(card: SessionHudCard, tool: unknown, result: { isError?: boolean; deny?: string }): SessionHudCard {
  if (result.isError === true) return { ...card, errors: card.errors + 1 }
  if (result.deny === undefined && typeof tool === 'string' && EDITS.has(tool)) return { ...card, edits: card.edits + 1 }
  return card
}

const named = (s: unknown): s is string => typeof s === 'string' && s.length > 0
const agentsOf = (card: SessionHudCard): SessionHudAgent[] => (Array.isArray(card.agents) ? card.agents : [])

/** The agent `id` is tracked, with `model` when it is one; a known model is kept when this one is not. */
function tracked(card: SessionHudCard, id: unknown, model: unknown): SessionHudCard {
  if (!named(id)) return card
  const agents = agentsOf(card)
  const at = agents.findIndex(agent => agent.id === id)
  if (at < 0) return { ...card, agents: [...agents, named(model) ? { id, model } : { id }] }
  if (!named(model) || agents[at]!.model === model) return card
  return { ...card, agents: agents.map((agent, i) => (i === at ? { id, model } : agent)) }
}

/** A subagent started (`agent.spawn`'s `agentId` and `model`): it runs on that model. */
export const spawned = (card: SessionHudCard, agentId: unknown, model: unknown): SessionHudCard => tracked(card, agentId, model)

/** An agent's turn began: a resumed agent or a teammate waking runs again, its model unknown until it steps. */
export const agentBegan = (card: SessionHudCard, agentId: unknown): SessionHudCard => tracked(card, agentId, undefined)

/** A tracked agent's step: the model that answered (`usage.model`, else the one the request named) is the one it runs on. A step adds no agent: one enters through its spawn or its turn's start, which the host skips together with its steps, so a late step cannot bring back an agent that ended. */
export const agentStepped = (card: SessionHudCard, agentId: unknown, model: unknown): SessionHudCard =>
  agentsOf(card).some(agent => agent.id === agentId) ? tracked(card, agentId, model) : card

/** An agent's turn ended: it no longer runs (a teammate goes idle until its next turn). */
export function agentEnded(card: SessionHudCard, agentId: unknown): SessionHudCard {
  const agents = agentsOf(card)
  return named(agentId) && agents.some(agent => agent.id === agentId) ? { ...card, agents: agents.filter(agent => agent.id !== agentId) } : card
}

const STOPPED: ReadonlySet<string> = new Set(['idle', 'completed', 'failed', 'killed'])

/** `$.agent.list()`'s word on each agent: one it lists as idle or ended no longer runs. One it does not list (a workflow's) stays; the list adds none. */
export function reconciled(card: SessionHudCard, list: readonly { id: unknown; status: unknown }[]): SessionHudCard {
  const stopped = new Set(list.filter(info => named(info.id) && typeof info.status === 'string' && STOPPED.has(info.status)).map(info => info.id))
  const agents = agentsOf(card)
  return agents.some(agent => stopped.has(agent.id)) ? { ...card, agents: agents.filter(agent => !stopped.has(agent.id)) } : card
}
