// The card's text pieces, shared by every surface: names, figures and rows of styled segments. Pure: no host access.
import type { SessionHudCard } from '../types'
import { WINDOW_MS, span } from './usage'

export type Style = 'plain' | 'strong' | 'secondary' | 'model' | 'success' | 'warning' | 'danger' | 'sent' | 'bar' | 'track' | 'tick' | 'frame'
export type Segment = { text: string; style: Style }
export type Row = Segment[]

export const seg = (text: string, style: Style = 'plain'): Segment => ({ text, style })
const count = (n: number) => (Number.isSafeInteger(n) && n >= 0 ? n : 0)
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

const FAMILY = /^claude-(opus|sonnet|haiku|fable)-([0-9]{1,2}(?:-[0-9]{1,2})*)(?:-[0-9]{8})?$/
const ALIAS = /^(opus|sonnet|haiku|fable)$/
/** A Claude model as the card names it, `claude-opus-5-5` as `Opus 5.5`; anything else is `?`, so no other text reaches the screen. */
export function modelName(id: string | undefined): string | undefined {
  if (id === undefined) return undefined
  const title = (family: string) => `${family[0]!.toUpperCase()}${family.slice(1)}`
  const full = FAMILY.exec(id)
  if (full) return `${title(full[1]!)} ${full[2]!.replace(/-/g, '.')}`
  return ALIAS.test(id) ? title(id) : '?'
}
const EFFORTS: ReadonlySet<string> = new Set(['low', 'medium', 'high', 'xhigh', 'max'])

/** A token count as the card writes it: `440k`, `1M`, `1.5M`. */
export function tokens(n: number): string {
  if (n >= 1_000_000) return `${Number((n / 1_000_000).toFixed(1))}M`
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(Math.round(n))
}
export const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n)
/** The context's figures: the last input against the window the host compacts at when it is known (a smaller `autoCompactWindow`), else the host's own percent of the model's window. */
export function contextOf(card: SessionHudCard): { percent: number; used?: number; window?: number } | undefined {
  const used = card.context?.tokens
  const window = finite(card.contextWindow) && card.contextWindow > 0 ? card.contextWindow : card.context?.window
  if (finite(used) && used >= 0 && finite(window) && window > 0) return { percent: Math.max(0, Math.round((used / window) * 100)), used, window }
  const percent = card.context?.percent
  return finite(percent) ? { percent: Math.max(0, Math.round(percent)) } : undefined
}
export const cacheCells = (card: SessionHudCard): Row => (card.cache !== undefined && Number.isFinite(card.cache) ? [seg(`cache ${Math.round(card.cache)}%`, 'secondary')] : [])
/** Segments joined with ` · `, empty parts dropped. */
const joined = (parts: Row[], gap = ' · '): Row => parts.filter(part => part.length).flatMap((part, at) => (at ? [seg(gap, 'secondary'), ...part] : part))

/** The dot (yellow with the turn's time while one runs), the model and its effort; empty before the model is known. */
export function headCells(card: SessionHudCard, now: number, working: boolean): Row {
  const name = modelName(card.model)
  if (name === undefined) return []
  const head: Row = [seg('● ', working ? 'warning' : 'success'), seg(name, 'model')]
  if (card.effort !== undefined && EFFORTS.has(card.effort)) head.push(seg(` · ${card.effort}`, 'secondary'))
  if (working && finite(card.turnStartedAt) && finite(now)) head.push(seg(` · working ${span(Math.max(0, now - card.turnStartedAt))}`, 'warning'))
  return head
}

export const LABELS: Readonly<Record<string, string>> = { five_hour: '5h', seven_day: '7d' }
/** The windows the card draws, the shorter first, at most two. */
export const shownLimits = (card: SessionHudCard): SessionHudCard['limits'] => card.limits
  .filter(limit => WINDOW_MS[limit.kind] !== undefined && LABELS[limit.kind] !== undefined)
  .sort((a, b) => WINDOW_MS[a.kind]! - WINDOW_MS[b.kind]!).slice(0, 2)
/** An agent type as the card names it (`Explore`, `spider-team:reviewer`); anything else is `?`, so no other text reaches the screen. */
const TYPE = /^[A-Za-z0-9][\w.:@-]{0,63}$/
export const typeName = (type: string | undefined): string | undefined => (type === undefined ? undefined : TYPE.test(type) ? type : '?')

/**
 * The running agents grouped by type, model and effort, the most first, then by name:
 * `3 agents: spider-team:reviewer Opus 5.5 · high ×2, Explore Haiku 4.5`; a part the host has not reported is left out,
 * an unknown model is `?`; empty when none runs.
 */
export function agentCells(card: SessionHudCard): Row {
  const agents = Array.isArray(card.agents) ? card.agents : []
  if (!agents.length) return []
  const groups = new Map<string, { row: Row; n: number }>()
  for (const agent of agents) {
    const type = typeName(typeof agent?.type === 'string' ? agent.type : undefined)
    const model = modelName(typeof agent?.model === 'string' ? agent.model : undefined) ?? '?'
    const effort = typeof agent?.effort === 'string' && EFFORTS.has(agent.effort) ? agent.effort : undefined
    const key = [type ?? '', model, effort ?? ''].join('|')
    const row: Row = [...(type ? [seg(`${type} `)] : []), seg(model, 'model'), ...(effort ? [seg(` · ${effort}`, 'secondary')] : [])]
    groups.set(key, { row, n: (groups.get(key)?.n ?? 0) + 1 })
  }
  const sorted = [...groups].sort(([a, { n: m }], [b, { n }]) => n - m || (a < b ? -1 : a > b ? 1 : 0))
  return [seg(`${plural(agents.length, 'agent')}: `, 'secondary'),
    ...joined(sorted.map(([, { row, n }]) => [...row, ...(n > 1 ? [seg(` ×${n}`, 'secondary')] : [])]), ', ')]
}

/** The last turn, turn count, edits and errors: `last turn 5s · 4 turns · 2 edits · 1 error`. */
export function turnCells(card: SessionHudCard): Row {
  const parts: string[] = []
  if (card.lastTurnMs !== undefined) parts.push(`last turn ${span(card.lastTurnMs)}`)
  if (count(card.turns) > 0) parts.push(plural(count(card.turns), 'turn'))
  parts.push(plural(count(card.edits), 'edit'), plural(count(card.errors), 'error'))
  return [seg(parts.join(' · '), 'secondary')]
}
