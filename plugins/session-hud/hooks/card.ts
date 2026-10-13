// Pure updates of the card from what the host reported. register.tsx owns every `$` call and passes the figures in.
import type { SessionHudCard, SessionHudLimit } from '../types'
import { cacheShare } from './usage'

export const EMPTY: SessionHudCard = { limits: [], edits: 0, errors: 0 }

/** What the host measures: the context, the rate-limit windows and the cost (`session.measure`, `$.session.usage()`). */
export type Measured = {
  context: { tokens?: number; window: number; percent?: number }
  rateLimits: readonly SessionHudLimit[]
  cost?: { usd: number }
}

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n)

/** A measurement replaces the context, the windows and the cost; `baseline` is the cost when the turn began. */
export function measured(card: SessionHudCard, usage: Measured, baseline: number | undefined): SessionHudCard {
  const { tokens, window, percent } = usage.context
  const context = finite(window) ? { window, ...(finite(tokens) ? { tokens } : {}), ...(finite(percent) ? { percent } : {}) } : undefined
  const limits = usage.rateLimits.filter(limit => typeof limit.kind === 'string' && finite(limit.percentUsed))
    .map(limit => ({ kind: limit.kind, percentUsed: limit.percentUsed, ...(typeof limit.resetsAt === 'string' ? { resetsAt: limit.resetsAt } : {}) }))
  const cost = finite(usage.cost?.usd) ? usage.cost.usd : undefined
  const next: SessionHudCard = { ...card, limits }
  if (context) next.context = context
  if (cost !== undefined) next.cost = cost
  if (cost !== undefined && baseline !== undefined && cost >= baseline) next.lastTurnCost = cost - baseline
  return next
}

/** A main-session step: its effort and, from its usage, the model that answered and the cache share. */
export function stepped(card: SessionHudCard, effort: unknown, usage: {
  model: string; input_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number
} | null): SessionHudCard {
  const next = { ...card }
  if (typeof effort === 'string') next.effort = effort
  if (usage) {
    if (typeof usage.model === 'string') next.model = usage.model
    const share = cacheShare(usage)
    if (share !== undefined) next.cache = share
  }
  return next
}

/** A main-session turn ended after `durationMs`. */
export const completed = (card: SessionHudCard, durationMs: unknown): SessionHudCard =>
  finite(durationMs) && durationMs >= 0 ? { ...card, lastTurnMs: durationMs } : card

const EDITS: ReadonlySet<string> = new Set(['Write', 'Edit', 'NotebookEdit'])

/** A main-session tool call, after its result: a successful edit or an error counts; anything else leaves the card as it is. */
export function tooled(card: SessionHudCard, tool: unknown, result: { isError?: boolean; deny?: string }): SessionHudCard {
  if (result.isError === true) return { ...card, errors: card.errors + 1 }
  if (result.deny === undefined && typeof tool === 'string' && EDITS.has(tool)) return { ...card, edits: card.edits + 1 }
  return card
}
