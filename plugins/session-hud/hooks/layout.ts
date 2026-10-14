// The card on every surface: lines of text and small drawings, aligned by the surface's flex layout instead of padding
// with spaces. A graphical surface draws its bars as SVG; the terminal as text. Pure: no host access.
import type { SessionHudCard, SessionHudTurn } from '../types'
import type { Palette } from './palette'
import { paceOf, span } from './usage'
import { LABELS, agentCells, cacheCells, contextOf, finite, headCells, seg, shownLimits, tokens, turnCells } from './view'
import type { Row, Segment, Style } from './view'

/** A drawing on a line: an SVG document of a fixed size; the terminal, which has no `Svg`, draws none. */
export type Drawing = { kind: 'svg'; source: string; alt: string; width: number; height: number }
/** What a group holds: text and drawings. */
export type Piece = Segment | Drawing
/** A part of a line kept whole: it wraps to the next row as a unit. A spacer is the room that pushes what follows to the right edge. */
export type Group = Piece[] | 'spacer'
/** The card as lines of groups, top to bottom; empty when there is nothing to show. */
export type CardLines = Group[][]

/** `svg`: a graphical surface; `cells`: the terminal, which has no `Svg` and draws its bars as text. */
export type Draw = 'svg' | 'cells'
export type LayoutSnapshot = { card: SessionHudCard; now: number; working?: boolean; palette: Palette; draw: Draw }

/** The drawing colours: the design's on a dark theme, darker ones that read on a light one. */
const INK: Record<Palette, { track: string; fill: string; bar: string; tick: string }> = {
  mockup: { track: '#34383f', fill: '#4fb383', bar: '#e5c07b', tick: '#e6e6e6' },
  theme: { track: '#d5d8dd', fill: '#2f8f5f', bar: '#b7791f', tick: '#1d1f23' },
}

/** A usage bar is this many pixels wide, whatever the card's width. */
export const BAR_WIDTH = 96
const BAR_HEIGHT = 11

const svg = (width: number, height: number, body: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${body}</svg>`
const px = (n: number) => Math.round(n * 10) / 10

/** A short bar lit to `percent` (capped at 100), with the elapsed-time tick at `tick` (0 to 1) when given. */
export function barSvg(percent: number, fill: string, palette: Palette, tick?: number): string {
  const ink = INK[palette]
  const lit = px((Math.min(100, Math.max(0, percent)) / 100) * BAR_WIDTH)
  const mark = tick === undefined ? '' : `<rect x="${px(Math.min(BAR_WIDTH - 1.5, Math.max(0, tick * BAR_WIDTH)))}" y="0" width="1.5" height="${BAR_HEIGHT}" fill="${ink.tick}"/>`
  return svg(BAR_WIDTH, BAR_HEIGHT, `<rect x="0" y="3" width="${BAR_WIDTH}" height="5" rx="2.5" fill="${ink.track}"/>`
    + (lit > 0 ? `<rect x="0" y="3" width="${lit}" height="5" rx="2.5" fill="${fill}"/>` : '') + mark)
}

/** What was sent at a turn's start (the message, reminders, results delivered between turns): known only from the previous turn, and not after a compaction. */
export const sentOf = (turn: SessionHudTurn, previous: SessionHudTurn | undefined): number | undefined =>
  previous !== undefined && turn.compacted !== true && previous.after <= turn.before ? turn.before - previous.after : undefined

/** A terminal bar is this many cells wide, whatever the card's width. */
export const BAR_CELLS = 12

/** A bar of `BAR_CELLS` cells lit to `percent` (capped at 100) in `fill`, with the elapsed-time tick at `tick` (0 to 1) when given. */
export function barCells(percent: number, fill: Style, tick?: number): Row {
  const lit = Math.round((Math.min(100, Math.max(0, percent)) / 100) * BAR_CELLS)
  const mark = tick === undefined ? -1 : Math.min(BAR_CELLS - 1, Math.max(0, Math.round(tick * BAR_CELLS)))
  const bar: Row = []
  for (let i = 0; i < BAR_CELLS; i++) {
    const part = i === mark ? seg('│', 'tick') : seg('━', i < lit ? fill : 'track')
    const last = bar[bar.length - 1]
    if (last && last.style === part.style) last.text += part.text
    else bar.push(part)
  }
  return bar
}

const valid = (turn: unknown): turn is SessionHudTurn => {
  const t = turn as SessionHudTurn
  return typeof t === 'object' && t !== null && [t.before, t.after, t.output].every(n => finite(n) && n >= 0)
}

/** The last turn in figures: what was sent at its start when known, what it added and its output; `▼` after a compaction. */
export function lastTurnCells(turn: SessionHudTurn, previous?: SessionHudTurn): Row {
  const sent = sentOf(turn, previous)
  const delta = turn.after - turn.before
  const change = delta >= 0 ? seg(`▲ +${tokens(delta)} in turn`, 'success') : seg(`▼ −${tokens(-delta)}`, 'warning')
  return [...(sent !== undefined ? [seg(`+${tokens(sent)} sent`, 'sent'), seg(' · ', 'secondary')] : []), change, seg(` · ${tokens(turn.output)} out`, 'secondary')]
}

/** The cache line: its share, how long ago a request used it, and with a known lifetime what is left of it. */
export function cacheLine(card: SessionHudCard, now: number): Row {
  const share = cacheCells(card)
  if (!share.length) return []
  const row = [...share]
  if (finite(card.cacheUsedAt) && finite(now)) {
    const age = Math.max(0, now - card.cacheUsedAt)
    row.push(seg(` · used ${span(age)} ago`, 'secondary'))
    if (card.cacheTtl !== undefined) {
      const left = (card.cacheTtl === '1h' ? 3_600_000 : 300_000) - age
      row.push(left > 0 ? seg(` · ${card.cacheTtl} TTL, ${span(left)} left`, 'secondary') : seg(` · ${card.cacheTtl} TTL, expired`, 'warning'))
    }
  }
  return row
}

/** One window: its label, bar with the elapsed-time tick, percent, lead, time left and where the pace ends. */
function limitPieces(limit: SessionHudCard['limits'][number], now: number, palette: Palette, draw: Draw): Piece[] {
  const used = Math.max(0, Number.isFinite(limit.percentUsed) ? limit.percentUsed : 0)
  const pace = paceOf(limit, now)
  const label = LABELS[limit.kind]!
  const bar: Piece[] = draw === 'cells' ? barCells(used, 'bar', pace?.elapsed)
    : [{ kind: 'svg', source: barSvg(used, INK[palette].bar, palette, pace?.elapsed), alt: `${label} ${Math.round(used)}% used`, width: BAR_WIDTH, height: BAR_HEIGHT }]
  const pieces: Piece[] = [seg(`${label} `, 'secondary'), ...bar, seg(` ${Math.round(used)}%`, 'strong')]
  if (pace && pace.ahead > 0) pieces.push(seg(` ▲${pace.ahead}`, 'warning'))
  if (pace) {
    const end = pace.fullIn !== undefined ? `100% in ${span(pace.fullIn)}` : `~${pace.atReset}% at reset`
    pieces.push(seg(`  ${span(pace.left)} · `, 'secondary'), seg(end, pace.fullIn !== undefined || pace.atReset > 100 ? 'warning' : 'secondary'))
  }
  return pieces
}

/** The card: head and agents; the context with the last turn in figures; the cache; the windows; the turn. */
export function layoutView({ card, now, working = false, palette, draw }: LayoutSnapshot): CardLines {
  const lines: Group[][] = []
  const head = headCells(card, now, working)
  const agents = agentCells(card)
  if (head.length || agents.length) lines.push([...(head.length ? [head] : []), ...(agents.length ? ['spacer' as const, agents] : [])])

  const context = contextOf(card)
  const turns = (Array.isArray(card.history) ? card.history : []).filter(valid)
  const contextLine: Group[] = []
  if (context) {
    const drawn: Piece[] = draw === 'cells' ? barCells(context.percent, 'success')
      : [{ kind: 'svg', source: barSvg(context.percent, INK[palette].fill, palette), alt: `context ${context.percent}% used`, width: BAR_WIDTH, height: BAR_HEIGHT }]
    const bar: Piece[] = [seg('ctx ', 'secondary'), ...drawn, seg(` ${context.percent}%`, 'strong')]
    if (context.used !== undefined && context.window !== undefined) bar.push(seg(`  ${tokens(context.used)} / ${tokens(context.window)}`, 'secondary'))
    contextLine.push(bar)
  }
  if (turns.length) contextLine.push('spacer', lastTurnCells(turns[turns.length - 1]!, turns[turns.length - 2]))
  if (contextLine.length) lines.push(contextLine)
  const cache = cacheLine(card, now)
  if (cache.length) lines.push([cache])

  const limits = shownLimits(card)
  if (limits.length) lines.push(limits.map(limit => limitPieces(limit, now, palette, draw)))

  if (!lines.length) return []
  lines.push([turnCells(card)])
  return lines
}
