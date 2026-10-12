// The pure text of what ticks on the surface without a redraw of the pane (UI spec 8): an agent's or a turn's clock and
// a rail's packets. H3's client modules call these with the props the drawing hands them and their own tick count, so
// the clock and rail text are the same functions the tests measure.
import { fmtDuration } from './format'
import { railCells } from './layout'
import { fit } from './width'

/** Props of the clock region: the drawing's `now` and the column it fills. */
export type ElapsedProps = {
  since: number
  /** The hooks module's time when it drew. */
  now: number
  /** When it stopped, or null while it runs. */
  endAt: number | null
  width: number
  align: 'left' | 'right'
  color?: string
  dimColor?: boolean
  bold?: boolean
}

/** `0:42`, `12:34`, `1h02`: from `since` to `endAt`, or to `at` while running. */
export const elapsedText = (since: number, at: number, endAt: number | null = null): string => fmtDuration((endAt ?? at) - since)

/** The clock's cell, exactly `width` cells, `ticks` seconds after the drawing's `now`. */
export const elapsedCell = (p: Pick<ElapsedProps, 'since' | 'now' | 'endAt' | 'width' | 'align'>, ticks = 0): string =>
  fit(elapsedText(p.since, p.now + Math.max(0, ticks) * 1000, p.endAt), p.width, p.align)

/** Props of the rail region: a packet moves along it while `active`. */
export type RailProps = {
  active: boolean
  width: number
  /** The color of the card below the rail (packets). */
  color?: string
  /** The faint color of the still line. */
  faint?: string
}

/** Milliseconds per cell of packet movement. */
export const RAIL_STEP_MS = 110

/** The rail as runs of lit (`●`, `•`) and still (`─`) cells, `phase` ticks in; a still rail is one run. */
export function railRuns(width: number, phase: number | null): { text: string; isLit: boolean }[] {
  const cells = Array.from(railCells(width, phase))
  const runs: { text: string; isLit: boolean }[] = []
  for (const ch of cells) {
    const isLit = ch !== '─'
    const last = runs[runs.length - 1]
    if (last && last.isLit === isLit) last.text += ch
    else runs.push({ text: ch, isLit })
  }
  return runs
}
