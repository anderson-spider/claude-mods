// The card for a surface that lays out by itself (the desktop app, the editor, the phone): lines of text and small
// drawings, aligned by the surface's flex layout instead of padding with spaces. Pure: no host access.
import type { SessionHudCard, SessionHudTurn } from '../types'
import { HISTORY } from './card'
import type { Palette } from './palette'
import { paceOf, span } from './usage'
import { LABELS, agentCells, cacheCells, contextOf, finite, headCells, seg, shownLimits, tokens, turnCells } from './view'
import type { Row, Segment } from './view'

/** A drawing on a line: an SVG document of a fixed size. */
export type Drawing = { kind: 'svg'; source: string; alt: string; width: number; height: number }
/** What a group holds: text and drawings. */
export type Piece = Segment | Drawing
/** A part of a line kept whole: it wraps to the next row as a unit. A spacer is the room that pushes what follows to the right edge. */
export type Group = Piece[] | 'spacer'
/** The card as lines of groups, top to bottom; empty when there is nothing to show. */
export type DesktopCard = Group[][]

export type DesktopSnapshot = { card: SessionHudCard; now: number; working?: boolean; palette: Palette }

/** The drawing colours: the design's on a dark theme, darker ones that read on a light one. */
const INK: Record<Palette, { track: string; fill: string; bar: string; tick: string; kept: string; added: string; cut: string }> = {
  mockup: { track: '#34383f', fill: '#4fb383', bar: '#e5c07b', tick: '#e6e6e6', kept: '#3d424b', added: '#4fb383', cut: '#e5c07b' },
  theme: { track: '#d5d8dd', fill: '#2f8f5f', bar: '#b7791f', tick: '#1d1f23', kept: '#a9afb8', added: '#2f8f5f', cut: '#b7791f' },
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

const SLOT = 7
const PITCH = 10
const CHART_HEIGHT = 22
/** The history chart's width: one slot per kept turn. */
export const CHART_WIDTH = HISTORY * PITCH - (PITCH - SLOT)


/**
 * The last turns as bars, the newest at the right: the grey part is the context the turn began with, the green part what
 * it added, a dashed line a compaction before or during it (as the host reported it). Heights are against `window` when it is known, else against the fullest turn.
 */
export function historySvg(turns: readonly SessionHudTurn[], window: number | undefined, palette: Palette): string {
  const ink = INK[palette]
  const scale = window !== undefined && window > 0 ? window : Math.max(1, ...turns.map(turn => turn.after))
  const height = (n: number) => px(Math.min(CHART_HEIGHT, Math.max(0, (n / scale) * CHART_HEIGHT)))
  const first = HISTORY - Math.min(HISTORY, turns.length)
  const parts = turns.slice(-HISTORY).map((turn, i) => {
    const x = (first + i) * PITCH
    const kept = height(Math.min(turn.before, turn.after))
    const top = height(Math.max(turn.before, turn.after))
    const added = px(top - kept)
    const cut = turn.compacted === true ? `<line x1="${x - 1.5}" y1="0" x2="${x - 1.5}" y2="${CHART_HEIGHT}" stroke="${ink.cut}" stroke-width="1" stroke-dasharray="2 2"/>` : ''
    return cut + `<rect x="${x}" y="${px(CHART_HEIGHT - kept)}" width="${SLOT}" height="${kept}" fill="${ink.kept}"/>`
      + (added > 0 ? `<rect x="${x}" y="${px(CHART_HEIGHT - top)}" width="${SLOT}" height="${added}" fill="${ink.added}"/>` : '')
  })
  return svg(CHART_WIDTH, CHART_HEIGHT, parts.join(''))
}

const valid = (turn: unknown): turn is SessionHudTurn => {
  const t = turn as SessionHudTurn
  return typeof t === 'object' && t !== null && [t.before, t.after, t.output].every(n => finite(n) && n >= 0)
}

/** The last turn in figures: `▲ +61k · 2.1k out`, `▼ −380k` after a compaction. */
export function lastTurnCells(turn: SessionHudTurn): Row {
  const delta = turn.after - turn.before
  const change = delta >= 0 ? seg(`▲ +${tokens(delta)}`, 'success') : seg(`▼ −${tokens(-delta)}`, 'warning')
  return [change, seg(` · ${tokens(turn.output)} out`, 'secondary')]
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
function limitPieces(limit: SessionHudCard['limits'][number], now: number, palette: Palette): Piece[] {
  const used = Math.max(0, Number.isFinite(limit.percentUsed) ? limit.percentUsed : 0)
  const pace = paceOf(limit, now)
  const label = LABELS[limit.kind]!
  const pieces: Piece[] = [seg(`${label} `, 'secondary'),
    { kind: 'svg', source: barSvg(used, INK[palette].bar, palette, pace?.elapsed), alt: `${label} ${Math.round(used)}% used`, width: BAR_WIDTH, height: BAR_HEIGHT },
    seg(` ${Math.round(used)}%`, 'strong')]
  if (pace && pace.ahead > 0) pieces.push(seg(` ▲${pace.ahead}`, 'warning'))
  if (pace) {
    const end = pace.fullIn !== undefined ? `100% in ${span(pace.fullIn)}` : `~${pace.atReset}% at reset`
    pieces.push(seg(`  ${span(pace.left)} · `, 'secondary'), seg(end, pace.fullIn !== undefined || pace.atReset > 100 ? 'warning' : 'secondary'))
  }
  return pieces
}

/** The card for a laid-out surface: head and agents; the context with its history; the cache; the windows; the turn. */
export function desktopView({ card, now, working = false, palette }: DesktopSnapshot): DesktopCard {
  const lines: Group[][] = []
  const head = headCells(card, now, working)
  const agents = agentCells(card)
  if (head.length || agents.length) lines.push([...(head.length ? [head] : []), ...(agents.length ? ['spacer' as const, agents] : [])])

  const context = contextOf(card)
  const turns = (Array.isArray(card.history) ? card.history : []).filter(valid)
  const window = context?.window ?? (finite(card.contextWindow) && card.contextWindow > 0 ? card.contextWindow : undefined)
  const contextLine: Group[] = []
  if (context) {
    const bar: Piece[] = [seg('ctx ', 'secondary'),
      { kind: 'svg', source: barSvg(context.percent, INK[palette].fill, palette), alt: `context ${context.percent}% used`, width: BAR_WIDTH, height: BAR_HEIGHT },
      seg(` ${context.percent}%`, 'strong')]
    if (context.used !== undefined && context.window !== undefined) bar.push(seg(`  ${tokens(context.used)} / ${tokens(context.window)}`, 'secondary'))
    contextLine.push(bar)
  }
  if (turns.length) {
    const shown = Math.min(HISTORY, turns.length)
    contextLine.push('spacer', [
      { kind: 'svg', source: historySvg(turns, window, palette), alt: `context of the last ${shown === 1 ? 'turn' : `${shown} turns`}`, width: CHART_WIDTH, height: CHART_HEIGHT },
      seg('  '), ...lastTurnCells(turns[turns.length - 1]!)])
  }
  if (contextLine.length) lines.push(contextLine)
  const cache = cacheLine(card, now)
  if (cache.length) lines.push([cache])

  const limits = shownLimits(card)
  if (limits.length) lines.push(limits.map(limit => limitPieces(limit, now, palette)))

  if (!lines.length) return []
  lines.push([turnCells(card)])
  return lines
}
