import type { SessionHudCard } from '../types'
import { WINDOW_MS, money, paceOf, span } from './usage'

export type Style = 'plain' | 'strong' | 'secondary' | 'model' | 'success' | 'warning' | 'bar' | 'track' | 'tick' | 'frame'
export type Segment = { text: string; style: Style }
export type Row = Segment[]

/** Everything the card may read: prepared atoms, the clock and the width, never a host. */
export type Snapshot = { card: SessionHudCard; now: number; columns: number; working?: boolean }
/** The card as the screen draws it: the rows above the rule and the row under it; empty when there is nothing to show. */
export type Card = { top: Row[]; bottom: Row[] }

const seg = (text: string, style: Style = 'plain'): Segment => ({ text, style })
const cells = (row: Row) => row.reduce((n, part) => n + part.text.length, 0)
const widthOf = (columns: number) => Math.max(4, Math.floor(Number.isFinite(columns) ? columns : 60))
const count = (n: number) => (Number.isSafeInteger(n) && n >= 0 ? n : 0)
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/** One row cut to the width, the cut ending in an ellipsis; segments keep their styles. */
function cutRow(row: Row, columns: number): Row {
  const width = widthOf(columns)
  const out: Row = []
  let used = 0
  for (const part of row) {
    if (used + part.text.length <= width) { out.push(part); used += part.text.length; continue }
    const room = width - used
    if (room > 1) out.push({ ...part, text: `${part.text.slice(0, room - 1)}…` })
    return out
  }
  return out
}

/** `left` at the start and `right` against the edge; when both do not fit, one row cut to the width. */
function spread(left: Row, right: Row, columns: number): Row {
  const room = widthOf(columns) - cells(left) - cells(right)
  if (!right.length) return cutRow(left, columns)
  if (room < 2) return cutRow([...left, seg('  '), ...right], columns)
  return [...left, seg(' '.repeat(room)), ...right]
}

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

const BAR = 8
/** A token count as the card writes it: `440k`, `1M`, `1.5M`. */
function tokens(n: number): string {
  if (n >= 1_000_000) return `${Number((n / 1_000_000).toFixed(1))}M`
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(Math.round(n))
}
const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n)
/** The context's figures: the last input against the window the host compacts at when it is known (a smaller `autoCompactWindow`), else the host's own percent of the model's window. */
function contextOf(card: SessionHudCard): { percent: number; used?: number; window?: number } | undefined {
  const used = card.context?.tokens
  const window = finite(card.contextWindow) && card.contextWindow > 0 ? card.contextWindow : card.context?.window
  if (finite(used) && used >= 0 && finite(window) && window > 0) return { percent: Math.max(0, Math.round((used / window) * 100)), used, window }
  const percent = card.context?.percent
  return finite(percent) ? { percent: Math.max(0, Math.round(percent)) } : undefined
}
/** A bar of `length` cells lit to `percent` (capped at 100). */
function contextBar(percent: number, length: number): Row {
  const lit = Math.min(length, Math.round((Math.min(100, percent) / 100) * length))
  return [seg('━'.repeat(lit), 'success'), seg('━'.repeat(length - lit), 'track')]
}
/** `ctx ━━━ 88% · 440k/500k`, the compact form on the first row. */
function contextCells(card: SessionHudCard): Row {
  const context = contextOf(card)
  if (!context) return []
  const row = [seg('ctx ', 'secondary'), ...contextBar(context.percent, BAR), seg(` ${context.percent}%`, 'strong')]
  if (context.used !== undefined && context.window !== undefined) row.push(seg(` · ${tokens(context.used)}/${tokens(context.window)}`, 'secondary'))
  return row
}
const outputCells = (card: SessionHudCard): Row => (count(card.output) > 0 ? [seg(`out ${tokens(card.output)}`, 'secondary')] : [])
const cacheCells = (card: SessionHudCard): Row => (card.cache !== undefined && Number.isFinite(card.cache) ? [seg(`cache ${Math.round(card.cache)}%`, 'secondary')] : [])
/** Segments joined with ` · `, empty parts dropped. */
const joined = (parts: Row[], gap = ' · '): Row => parts.filter(part => part.length).flatMap((part, at) => (at ? [seg(gap, 'secondary'), ...part] : part))

/** The session's cost, its hourly rate once a minute has passed, and its age: `session $0.43 · $1.70/h · 18m`. */
function costCells(card: SessionHudCard, now: number): Row {
  if (card.cost === undefined) return []
  const row: Row = [seg('session ', 'secondary'), seg(money(card.cost), 'strong')]
  const age = finite(card.startedAt) && finite(now) ? now - card.startedAt : undefined
  if (age !== undefined && age >= 60_000) row.push(seg(` · ${money(card.cost / (age / 3_600_000))}/h · ${span(age)}`, 'secondary'))
  return row
}

/** The first row: the dot (yellow with the turn's time while one runs), the model and its effort; on a narrow card the context, cache and output too; the session's cost on the right. */
function modelRow(card: SessionHudCard, now: number, working: boolean, inner: number, wide: boolean): Row | undefined {
  const name = modelName(card.model)
  const head: Row = []
  if (name !== undefined) {
    head.push(seg('● ', working ? 'warning' : 'success'), seg(name, 'model'))
    if (card.effort !== undefined && EFFORTS.has(card.effort)) head.push(seg(` · ${card.effort}`, 'secondary'))
    if (working && finite(card.turnStartedAt) && finite(now)) head.push(seg(` · working ${span(Math.max(0, now - card.turnStartedAt))}`, 'warning'))
  }
  const left = wide ? head : joined([head, contextCells(card), cacheCells(card), outputCells(card)], '   ')
  const right = costCells(card, now)
  if (!left.length && !right.length) return undefined
  return spread(left, right, inner)
}

const LABELS: Readonly<Record<string, string>> = { five_hour: '5h', seven_day: '7d' }
/** A window's bar is at most this long, so the percent stays beside it on a wide terminal. */
const LIMIT_BAR = 30
/** A window's block at its widest: label, bar, ` 100%` and ` ▲100`; the second window starts right after it. */
const LIMIT_BLOCK = 4 + LIMIT_BAR + 12

/** One window's two lines: its bar with the elapsed-time tick, percent and lead; then the time left and where the pace ends. */
function limitLines(limit: SessionHudCard['limits'][number], now: number, width: number): Row[] {
  const used = Math.max(0, Number.isFinite(limit.percentUsed) ? limit.percentUsed : 0)
  const pace = paceOf(limit, now)
  const head: Row = [seg(`${LABELS[limit.kind]}`.padEnd(4), 'secondary')]
  const percent = seg(` ${Math.round(used)}%`, 'strong')
  const ahead = pace && pace.ahead > 0 ? [seg(` ▲${pace.ahead}`, 'warning')] : []
  const span_ = Math.min(LIMIT_BAR, Math.max(6, width - 4 - percent.text.length - 4))
  const lit = Math.min(span_, Math.round((Math.min(100, used) / 100) * span_))
  const tick = pace ? Math.min(span_ - 1, Math.round(pace.elapsed * span_)) : -1
  const bar: Row = []
  for (let i = 0; i < span_; i++) {
    const part = i === tick ? seg('│', 'tick') : seg('━', i < lit ? 'bar' : 'track')
    const last = bar[bar.length - 1]
    if (last && last.style === part.style) last.text += part.text
    else bar.push(part)
  }
  const lines = [cutRow([...head, ...bar, percent, ...ahead], width)]
  if (pace) {
    const end = pace.fullIn !== undefined ? `100% in ${span(pace.fullIn)}` : `~${pace.atReset}% at reset`
    lines.push(cutRow([seg('    '), seg(`${span(pace.left)} left · `, 'secondary'), seg(end, pace.fullIn !== undefined || pace.atReset > 100 ? 'warning' : 'secondary')], width))
  }
  return lines
}

/** The windows side by side where two fit (a gap of four between, the second no further than one block in), one under the other where they do not. */
function limitRows(card: SessionHudCard, now: number, inner: number): Row[] {
  const limits = card.limits.filter(limit => WINDOW_MS[limit.kind] !== undefined && LABELS[limit.kind] !== undefined)
    .sort((a, b) => WINDOW_MS[a.kind]! - WINDOW_MS[b.kind]!)
  if (!limits.length) return []
  const half = Math.floor((inner - 4) / 2)
  if (limits.length < 2 || half < 34) return limits.flatMap(limit => limitLines(limit, now, inner))
  const block = Math.min(half, LIMIT_BLOCK)
  const [a, b] = limits.slice(0, 2).map(limit => limitLines(limit, now, block))
  const rows: Row[] = []
  for (let i = 0; i < Math.max(a!.length, b!.length); i++) {
    const left = a![i] ?? []
    rows.push([...left, seg(' '.repeat(block - cells(left) + 4)), ...(b![i] ?? [])])
  }
  return rows
}

/** Three blocks fit side by side from this inner width: the context, then each window, a gap of four between. */
const WIDE = 3 * LIMIT_BLOCK + 8

/** The context as a block like a window's: its bar, then its tokens and what is left of the window, then cache and output. */
function contextBlock(card: SessionHudCard): Row[] {
  const context = contextOf(card)
  const lines: Row[] = []
  if (context) lines.push([seg('ctx ', 'secondary'), ...contextBar(context.percent, LIMIT_BAR), seg(` ${context.percent}%`, 'strong')])
  if (context?.used !== undefined && context.window !== undefined) {
    lines.push([seg('    '), seg(`${tokens(context.used)}/${tokens(context.window)}`, 'secondary'),
      seg(` · ${tokens(Math.max(0, context.window - context.used))} left`, 'secondary')])
  }
  const extra = joined([cacheCells(card), outputCells(card)])
  if (extra.length) lines.push([seg('    '), ...extra])
  return lines
}

/** A wide card: the context and the windows as three aligned blocks. */
function wideRows(card: SessionHudCard, now: number): Row[] {
  const limits = card.limits.filter(limit => WINDOW_MS[limit.kind] !== undefined && LABELS[limit.kind] !== undefined)
    .sort((a, b) => WINDOW_MS[a.kind]! - WINDOW_MS[b.kind]!).slice(0, 2)
  const blocks = [contextBlock(card), ...limits.map(limit => limitLines(limit, now, LIMIT_BLOCK))].filter(block => block.length)
  const rows: Row[] = []
  for (let i = 0; i < Math.max(0, ...blocks.map(block => block.length)); i++) {
    const row: Row = []
    blocks.forEach((block, at) => {
      const part = block[i] ?? []
      if (at < blocks.length - 1) row.push(...part, seg(' '.repeat(LIMIT_BLOCK - cells(part) + 4)))
      else row.push(...part)
    })
    while (row.length && !row[row.length - 1]!.text.trim()) row.pop()
    rows.push(row)
  }
  return rows
}

/** The row under the rule: the last turn, turn count, edits, errors and the turn's cost. */
function turnRow(card: SessionHudCard, inner: number): Row {
  const parts: string[] = []
  if (card.lastTurnMs !== undefined) parts.push(`last turn ${span(card.lastTurnMs)}`)
  if (count(card.turns) > 0) parts.push(plural(count(card.turns), 'turn'))
  parts.push(plural(count(card.edits), 'edit'), plural(count(card.errors), 'error'))
  if (card.lastTurnCost !== undefined && Number.isFinite(card.lastTurnCost) && card.lastTurnCost >= 0) parts.push(`+${money(card.lastTurnCost)}`)
  return cutRow([seg(parts.join(' · '), 'secondary')], inner)
}

/** The card from one snapshot: rows sized to the band's width less the border and padding (four cells). */
export function cardView({ card, now, columns, working = false }: Snapshot): Card {
  const inner = widthOf(columns) - 4
  const wide = inner >= WIDE
  const top = [modelRow(card, now, working, inner, wide), ...(wide ? wideRows(card, now) : limitRows(card, now, inner))]
    .filter((row): row is Row => row !== undefined)
  if (!top.length) return { top: [], bottom: [] }
  return { top, bottom: [turnRow(card, inner)] }
}
