// A drawn row as styled spans (UI spec 4.1): every row the HUD draws is a `Line` of exactly its width in cells. A span
// names its color class (`tone`) and, for the two contextual classes, the section or role it takes its color from; a
// span may also be a live region (a ticking clock) whose static text is what a surface without client modules draws.
import { fitSegs, leftRight, segsWidth, type Seg } from './layout'
import type { Role } from './roles'
import { cellWidth } from './width'

/** The cards, by the color their border and title take (UI spec 3.1). */
export type SectionId = 'session' | 'quota' | 'plan' | 'running' | 'review' | 'finished' | 'timeline' | 'log'

/** A clock that ticks on the surface (H3's client module): `width` cells, aligned, from `since` to `endAt` or now. */
export type LiveClock = { kind: 'elapsed'; key: string; since: number; endAt: number | null; now: number; width: number; align: 'left' | 'right' }

export type Span = Seg & {
  /** The role a `role` tone takes its color from (`other` when absent). */
  role?: Role
  /** The section a `section` tone takes its color from (the card's own when absent). */
  section?: SectionId
  inverse?: boolean
  /** The hotkey a plain Button draws before its content (`1: `): what follows it in the row is the Button's. */
  pressPrefix?: boolean
  /** A ticking region; `text` is its static form, exactly `live.width` cells. */
  live?: LiveClock
}

export type Line = Span[]

export const sp = (text: string, tone?: Seg['tone'], extra: Omit<Span, 'text' | 'tone'> = {}): Span => ({
  text,
  ...(tone ? { tone } : {}),
  ...extra,
})

/** A span cut by a fit is no longer as wide as its live region: it stays static text. */
function settleLive(line: Span[]): Line {
  return line.map(s => {
    if (!s.live || cellWidth(s.text) === s.live.width) return s
    const { live: _live, ...rest } = s
    return rest
  })
}

/** Exactly `width` cells (fitSegs spreads each segment, so a span keeps its own fields). */
export const fitLine = (spans: readonly Span[], width: number): Line => settleLive(fitSegs(spans, width) as Span[])

/** `left` and `right` in `width` cells, the right part whole. */
export const spreadLine = (left: readonly Span[], right: readonly Span[], width: number): Line =>
  settleLive(leftRight(left, right, width) as Span[])

export const lineWidth = (line: readonly Span[]): number => segsWidth(line)
export const lineText = (line: readonly Span[]): string => line.map(s => s.text).join('')

/** Marks every span dim (stale readings). */
export const dimmed = (spans: readonly Span[]): Span[] => spans.map(s => ({ ...s, dim: true }))
