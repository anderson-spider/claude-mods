// Token usage as the host reports it, its estimated cost and the figures the pane prints.
import type { SpiderAgent, SpiderMain, SpiderUsage } from '../types'
import { STRINGS } from './i18n'
import { priceOf } from './prices'

export const ZERO: SpiderUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

const FIELDS = { input: 'input_tokens', output: 'output_tokens', cacheRead: 'cache_read_input_tokens', cacheWrite: 'cache_creation_input_tokens' } as const

/** A step's usage: an absent count is zero, a present one that is not a non-negative finite number spoils the whole usage. */
export function usageOf(raw: unknown): SpiderUsage | null {
  if (!raw || typeof raw !== 'object') return null
  const out = { ...ZERO }
  for (const [key, field] of Object.entries(FIELDS) as [keyof SpiderUsage, string][]) {
    const n = (raw as Record<string, unknown>)[field]
    if (n === undefined) continue
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return null
    out[key] = n
  }
  return out
}

export const addUsage = (a: SpiderUsage, b: SpiderUsage): SpiderUsage =>
  ({ input: a.input + b.input, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite })

/** Whether `u` counted any token. */
export const hasTokens = (u: SpiderUsage): boolean => Object.values(u).some(n => n > 0)

/**
 * The estimated USD cost of `u` on `model`; undefined when the model has no price. A long-prompt card applies only to
 * one request's usage: `u` summed over several requests (`oneRequest` false) says nothing of any one prompt's size.
 */
export function costOf(model: string | undefined, u: SpiderUsage, oneRequest = true): number | undefined {
  const price = model ? priceOf(model, oneRequest ? u.input + u.cacheRead + u.cacheWrite : 0) : undefined
  if (!price) return undefined
  return (u.input * price.input + u.output * price.output + u.cacheRead * price.cacheRead + u.cacheWrite * price.cacheWrite) / 1_000_000
}

/** Main's request: the model that answered, its usage and cost; an unpriced request marks the cost partial only when it used tokens. */
export function mainUsed(main: SpiderMain, model: string | undefined, raw: unknown): SpiderMain {
  const u = usageOf(raw)
  const next = { ...main, ...(model ? { model } : {}) }
  if (!u) return next
  const cost = costOf(model, u)
  return {
    ...next, usage: addUsage(main.usage, u), contextTokens: u.input + u.cacheRead + u.cacheWrite,
    ...(cost !== undefined ? { costUsd: (main.costUsd ?? 0) + cost } : hasTokens(u) ? { costPartial: true as const } : {}),
  }
}

export type Totals = { usage: SpiderUsage; costUsd?: number; costPartial: boolean }

const totalOf = (parts: { usage: SpiderUsage; costUsd?: number; costPartial?: true }[]): Totals => {
  let costUsd: number | undefined
  let costPartial = false
  let usage = ZERO
  for (const part of parts) {
    usage = addUsage(usage, part.usage)
    if (part.costUsd !== undefined) costUsd = (costUsd ?? 0) + part.costUsd
    if (part.costPartial || (part.costUsd === undefined && hasTokens(part.usage))) costPartial = true
  }
  return { usage, ...(costUsd !== undefined ? { costUsd } : {}), costPartial }
}

/** Main's, the subagents' and the whole session's usage and cost, kept apart. */
export function totalsOf(main: SpiderMain, agents: SpiderAgent[]): { main: Totals; agents: Totals; session: Totals } {
  return { main: totalOf([main]), agents: totalOf(agents), session: totalOf([main, ...agents]) }
}

export function formatTokens(n: number): string {
  // A value that rounds up to the next unit (999_950 → 1000.0K) is written in that unit.
  if (n >= 999_950) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(Math.round(n))
}

/** `~$2.14`, with `+` when part of the usage ran on a model with no price, or `na` when none had one. */
export const formatCost = (t: Totals, na = STRINGS.en.na): string => (t.costUsd === undefined ? na : `~$${t.costUsd.toFixed(2)}${t.costPartial ? '+' : ''}`)

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const two = (n: number) => String(n).padStart(2, '0')
  const h = Math.floor(s / 3600)
  return h ? `${h}:${two(Math.floor((s % 3600) / 60))}:${two(s % 60)}` : `${two(Math.floor(s / 60))}:${two(s % 60)}`
}
