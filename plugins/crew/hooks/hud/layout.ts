// Cell layout (UI spec 4.1, 4.4, 7): styled segments that fit an exact width, card frames, rails, the pane's width
// budget and the degradation levels by height. Pure; the drawing turns segments into elements.
import type { Tone } from './glyphs'
import { cellWidth, cleanControls, fit, truncate } from './width'

/** A run of text with one style. `tone` names a color class; the drawing maps it to a color. */
export type Seg = { text: string; tone?: Tone; bold?: boolean; dim?: boolean }

export const seg = (text: string, tone?: Tone, style: { bold?: boolean; dim?: boolean } = {}): Seg => ({
  text,
  ...(tone ? { tone } : {}),
  ...style,
})

export const segsWidth = (segs: readonly Seg[]): number => segs.reduce((sum, s) => sum + cellWidth(s.text), 0)
export const segsText = (segs: readonly Seg[]): string => segs.map(s => s.text).join('')

/** Exactly `width` cells: segments kept in order, the one that overflows cut with `…`, the rest dropped, short rows padded. */
export function fitSegs(segs: readonly Seg[], width: number): Seg[] {
  if (width <= 0) return []
  const out: Seg[] = []
  let used = 0
  for (const raw of segs) {
    const s = raw.text === cleanControls(raw.text) ? raw : { ...raw, text: cleanControls(raw.text) }
    const w = cellWidth(s.text)
    if (w === 0) continue
    if (used + w <= width) {
      out.push(s)
      used += w
      continue
    }
    const room = width - used
    if (room > 0) out.push({ ...s, text: truncate(s.text, room) })
    used = width
    break
  }
  const short = width - segsWidth(out)
  if (short > 0) out.push({ text: ' '.repeat(short) })
  return out
}

/** `left` and `right` in `width` cells; the right part stays whole, the left is cut to what remains (one gap kept). */
export function leftRight(left: readonly Seg[], right: readonly Seg[], width: number): Seg[] {
  const rightWidth = segsWidth(right)
  if (rightWidth >= width) return fitSegs(right, width)
  const room = width - rightWidth - (segsWidth(left) > 0 ? 1 : 0)
  const cut = fitSegs(left, Math.max(0, room))
  const gap = width - rightWidth - segsWidth(cut)
  return [...cut, ...(gap > 0 ? [{ text: ' '.repeat(gap) }] : []), ...right]
}

// ------------------------------------------------------------------ pane width

/** The docked pane's width: 56 requested; the host may give 56-66. */
export const PANE_WIDTH = 56
export const PANE_MAX = 66

export type PaneBudget = {
  /** The pane's cells. */
  width: number
  /** Cells inside a card (`│ ` and ` │` take 4). */
  content: number
  /** Cells beyond 56 (0-10) that go to the text columns; fixed columns keep their widths. */
  extra: number
}

export function paneBudget(columns: number): PaneBudget {
  const width = Math.max(0, Math.floor(columns))
  return { width, content: Math.max(0, width - 4), extra: Math.max(0, Math.min(width, PANE_MAX) - PANE_WIDTH) }
}

/** What a docked pane narrower than 56 drops: the job strip, then the effort; plan rows lose the owner; Quota loses its header. */
export type NarrowPlan = { jobStrip: boolean; effort: boolean; planOwner: boolean; quotaHeader: boolean; finishedStrip: boolean }

export function narrowPlan(width: number): NarrowPlan {
  const narrow = width < PANE_WIDTH
  return {
    jobStrip: !narrow,
    // The effort goes after the strip, once the model column itself gets tight.
    effort: width >= 48,
    planOwner: !narrow,
    quotaHeader: !narrow,
    finishedStrip: !narrow,
  }
}

// ------------------------------------------------------------------ frames and rails

/** `╭─ Title ─────╮`, exactly `width` cells; a long title is cut with `…`. */
export function cardTop(title: string, width: number): string {
  if (width < 6) return truncate('╭─╮', width)
  const text = truncate(title, width - 6)
  const dashes = width - 5 - cellWidth(text)
  return `╭─ ${text} ${'─'.repeat(Math.max(1, dashes))}╮`
}

export const cardBottom = (width: number): string => (width < 2 ? '' : `╰${'─'.repeat(width - 2)}╯`)

/** `│ content │`, exactly `width` cells. */
export const cardRow = (content: string, width: number): string => `│ ${fit(content, Math.max(0, width - 4))} │`

/** The same as styled segments: borders then the fitted content. */
export function cardRowSegs(content: readonly Seg[], width: number): Seg[] {
  return [{ text: '│ ' }, ...fitSegs(content, Math.max(0, width - 4)), { text: ' │' }]
}

/** Packets repeat every 24 cells. */
export const RAIL_PERIOD = 24

/**
 * The cells between two cards: `─`, or with a `phase` (a tick counter) a packet `●` with a trail `•••` behind it,
 * moving right one cell per tick, a new packet every 24 cells.
 */
export function railCells(length: number, phase: number | null): string {
  if (length <= 0) return ''
  const cells = Array.from({ length }, () => '─')
  if (phase !== null) {
    const offset = ((phase % RAIL_PERIOD) + RAIL_PERIOD) % RAIL_PERIOD
    for (let head = offset; head < length + 3; head += RAIL_PERIOD) {
      if (head < length) cells[head] = '●'
      for (let t = 1; t <= 3; t++) if (head - t >= 0 && head - t < length) cells[head - t] = '•'
    }
  }
  return cells.join('')
}

/** The rail row: two spaces, the rail, two spaces; exactly `width` cells. */
export const railRow = (width: number, phase: number | null): string => `  ${railCells(Math.max(0, width - 4), phase)}  `

/** A row of exactly `width` cells from fixed columns: each cell is cut or padded to its width. */
export function columns(cols: readonly { text: string; width: number; align?: 'left' | 'right' }[]): string {
  return cols.map(c => fit(c.text, c.width, c.align ?? 'left')).join('')
}

// ------------------------------------------------------------------ degradation

export type QuotaForm = 'card' | 'no-header' | 'favored-when-hot' | 'line'
export type PlanForm = 'full' | 'short' | 'line'

/** What the docked pane draws at a level (UI spec 7); each level keeps what the one before kept, minus what it names. */
export type LevelPlan = {
  level: number
  legend: boolean
  /** Rows of the Log card's body: 10, 3 or none. */
  logRows: number
  timeline: boolean
  /** `card`: its own card; `inline`: one row `done: tester·cx ▰ · research ▰✗ · +1` at the bottom of the running card. */
  finished: 'card' | 'inline'
  quota: QuotaForm
  rails: boolean
  /** Running agents' third row (last tool, ctx). */
  activityRow: boolean
  /** Rows a running agent takes: 3, 2 or 1. */
  agentRows: 1 | 2 | 3
  /** Review rows shown: 3 or 1. */
  reviewRows: 1 | 3
  plan: PlanForm
  /** Session card: 4 rows, or 1. */
  sessionRows: 1 | 4
  /** Cut from the bottom to fit; Session and the first running row are never cut. */
  cutFromBottom: boolean
}

export const MAX_LEVEL = 7

export function levelPlan(level: number): LevelPlan {
  const l = Math.min(MAX_LEVEL, Math.max(0, Math.floor(level)))
  return {
    level: l,
    legend: l < 1,
    logRows: l < 1 ? 10 : l < 2 ? 3 : 0,
    timeline: l < 3,
    finished: l < 4 ? 'card' : 'inline',
    quota: l < 4 ? 'card' : l < 5 ? 'no-header' : l < 6 ? 'favored-when-hot' : 'line',
    rails: l < 5,
    activityRow: l < 5,
    agentRows: l < 5 ? 3 : l < 6 ? 2 : 1,
    reviewRows: l < 5 ? 3 : 1,
    plan: l < 5 ? 'full' : l < 6 ? 'short' : 'line',
    sessionRows: l < 6 ? 4 : 1,
    cutFromBottom: l >= MAX_LEVEL,
  }
}

/** The fullest level (lowest number) whose drawing fits `rows`; `heightOf` measures the drawing at a level. Level 7 when none fits. */
export function pickLevel(rows: number, heightOf: (plan: LevelPlan) => number): number {
  for (let level = 0; level < MAX_LEVEL; level++) {
    if (heightOf(levelPlan(level)) <= rows) return level
  }
  return MAX_LEVEL
}
