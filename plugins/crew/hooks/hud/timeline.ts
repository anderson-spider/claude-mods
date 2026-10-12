// The "Last 15 minutes" lanes (UI spec 4.4): one lane for the lead, then one per agent type active in the window, in
// role-table order, twins in their own lane. Two cells per minute, so 30 cells span the window.
import { ADVISOR, displayName, laneRank } from './roles'
import { pad, spread } from './width'
import { jobOf } from './state'
import type { AgentCard, Consult, Session } from './types'

export const WINDOW_MS = 15 * 60_000
export const LANE_CELLS = 30
const CELL_MS = WINDOW_MS / LANE_CELLS

/** `idle` `·`, `busy` `━`, `running` bold `━`, `failed` `✗`. */
export type LaneCell = 'idle' | 'busy' | 'running' | 'failed'

export const LANE_GLYPH: Readonly<Record<LaneCell, string>> = { idle: '·', busy: '━', running: '━', failed: '✗' }

export type Lane = {
  /** The lane's agent type (`crew:developer`), or `lead`. */
  key: string
  /** `lead`, `developer`, `developer·cx`, ... */
  name: string
  isLead: boolean
  cells: LaneCell[]
  /** Jobs that touch the window; null for the lead. */
  jobs: number | null
  /** Busy time in the window in whole minutes (`'<1m'` text when under half a minute). */
  busyMs: number
}

/** Busy time of one round; `job` names the job it belongs to, so `×N` counts jobs, not rounds. */
type Span = { from: number; to: number; running: boolean; failed: boolean; job: string }

function cellsOf(spans: readonly Span[], now: number): LaneCell[] {
  const start = now - WINDOW_MS
  const cells: LaneCell[] = Array.from({ length: LANE_CELLS }, () => 'idle')
  const rank: Record<LaneCell, number> = { idle: 0, busy: 1, running: 2, failed: 3 }
  const mark = (i: number, state: LaneCell) => {
    if (i < 0 || i >= LANE_CELLS) return
    if (rank[state] > rank[cells[i] as LaneCell]) cells[i] = state
  }
  for (const span of spans) {
    const from = Math.max(span.from, start)
    const to = Math.min(span.to, now)
    if (to < from) continue
    const first = Math.min(LANE_CELLS - 1, Math.floor((from - start) / CELL_MS))
    // An end on a cell boundary does not paint the next cell; a zero-length span paints its own.
    const last = to > from ? Math.min(LANE_CELLS - 1, Math.ceil((to - start) / CELL_MS) - 1) : first
    for (let i = first; i <= last; i++) mark(i, span.running ? 'running' : 'busy')
    // A failed job shows its failure in the cell it ended in.
    if (span.failed) mark(last, 'failed')
  }
  return cells
}

/** The union of the spans clipped to the window, in ms. */
function busyMs(spans: readonly Span[], now: number): number {
  const start = now - WINDOW_MS
  const clipped = spans
    .map(s => [Math.max(s.from, start), Math.min(s.to, now)] as const)
    .filter(([from, to]) => to > from)
    .sort((a, b) => a[0] - b[0])
  let total = 0
  let edge = -Infinity
  for (const [from, to] of clipped) {
    const f = Math.max(from, edge)
    if (to > f) total += to - f
    edge = Math.max(edge, to)
  }
  return total
}

const touches = (span: Span, now: number): boolean => span.to >= now - WINDOW_MS && span.from <= now

/**
 * The lanes for the window ending at `now`: the lead first (always), then every type that has a job touching the
 * window. The lead's spans are its turns (and the one in progress); an agent's are its rounds; a consult counts for the
 * architect's lane (the server advisor tool too).
 */
export function timelineLanes(
  agents: readonly AgentCard[],
  consults: readonly Consult[],
  session: Session,
  now: number,
): Lane[] {
  const lanes: Lane[] = []
  const leadSpans: Span[] = session.turns.map((t, i) => ({ from: t.startedAt, to: t.endedAt, running: false, failed: false, job: `turn:${i}` }))
  if (session.turn) leadSpans.push({ from: session.turn.startedAt, to: now, running: true, failed: false, job: 'turn:now' })
  lanes.push({
    key: 'lead',
    name: 'lead',
    isLead: true,
    cells: cellsOf(leadSpans, now),
    jobs: null,
    busyMs: busyMs(leadSpans, now),
  })

  const byType = new Map<string, Span[]>()
  const add = (type: string, span: Span) => {
    const list = byType.get(type) ?? []
    list.push(span)
    byType.set(type, list)
  }
  for (const card of agents) {
    for (const round of card.rounds) {
      add(card.type, {
        from: round.startedAt,
        to: round.endedAt ?? now,
        running: round.status === 'running',
        failed: round.status === 'failed',
        job: `${card.id}#${jobOf(round)}`,
      })
    }
  }
  for (const consult of consults) {
    // `displayName` of the consult's lane: the advisor shares the architect's lane.
    const type = consult.who === ADVISOR ? 'crew:architect' : consult.who.endsWith('·cx') ? 'crew:architect-codex' : 'crew:architect'
    add(type, { from: consult.at, to: consult.endAt ?? now, running: consult.endAt === null, failed: false, job: `consult:${consult.id}` })
  }

  const types = [...byType.keys()]
    .filter(type => (byType.get(type) as Span[]).some(span => touches(span, now)))
    .sort((a, b) => laneRank(a) - laneRank(b) || a.localeCompare(b))
  for (const type of types) {
    const spans = (byType.get(type) as Span[]).filter(span => touches(span, now))
    lanes.push({
      key: type,
      name: displayName(type),
      isLead: false,
      cells: cellsOf(spans, now),
      jobs: new Set(spans.map(span => span.job)).size,
      busyMs: busyMs(spans, now),
    })
  }
  return lanes
}

/** Busy time as the stats column shows it: `11m`, `<1m`, `0m`. */
export function busyText(ms: number): string {
  if (ms <= 0) return '0m'
  const minutes = Math.round(ms / 60_000)
  return minutes === 0 ? '<1m' : `${minutes}m`
}

/** The 8-cell stats column: `×2    9m` (jobs, busy minutes); the lead shows busy minutes alone, right-aligned. */
export function laneStats(lane: Lane, width = 8): string {
  const busy = busyText(lane.busyMs)
  return lane.jobs === null ? pad(busy, width, 'right') : spread(`×${lane.jobs}`, busy, width)
}

/** The lane as a string of cells (`━`, `·`, `✗`). */
export const laneText = (lane: Lane): string => lane.cells.map(c => LANE_GLYPH[c]).join('')

/** The axis under the bars: `-15m` at the left, `-10m` and `-5m` at a third and two thirds, `now` at the right edge. */
export function timelineAxis(width = LANE_CELLS): string {
  const slots: [number, string][] = [
    [0, '-15m'],
    [Math.round(width / 3), '-10m'],
    [Math.round((width * 2) / 3), '-5m'],
  ]
  const chars = Array.from({ length: width }, () => ' ')
  const put = (at: number, text: string) => {
    for (let i = 0; i < text.length && at + i < width; i++) chars[at + i] = text[i] as string
  }
  for (const [at, text] of slots) put(at, text)
  put(width - 3, 'now')
  return chars.join('')
}

/** Whether the section shows: only after the first agent or consult. */
export const hasTimeline = (agents: readonly AgentCard[], consults: readonly Consult[]): boolean =>
  agents.length + consults.length > 0
