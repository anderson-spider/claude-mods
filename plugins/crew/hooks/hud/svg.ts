// The desktop's "Last 15 minutes" as one SVG lane chart (UI spec 5): a grid at -15, -10, -5 minutes and now, solid bars
// for running jobs, outlined bars for finished ones, a red X where a job failed. Raw colors (SVG names no theme key).
import { plural } from './format'
import { SVG_PALETTE } from './palette'
import { typeInfo, type Role } from './roles'
import { LANE_CELLS, laneStats, type Lane, type LaneCell } from './timeline'
import { cleanControls } from './width'

/** Pixels of one cell column and one row on the desktop (UI spec 2: 8 px columns, 19 px rows). */
export const CELL_PX = 8
export const ROW_PX = 19

/** Text for the SVG: controls become spaces (XML 1.0 forbids C0 controls), then the five specials are escaped. */
const escapeXml = (text: string): string =>
  cleanControls(text).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[ch] as string)

const minutesWords = (ms: number): string => {
  const minutes = Math.round(ms / 60_000)
  if (ms > 0 && minutes === 0) return 'under a minute'
  return plural(minutes, 'minute')
}

/** `Last 15 minutes: lead busy 11 minutes; developer 2 jobs, 9 minutes; …`. */
export function timelineAlt(lanes: readonly Lane[]): string {
  const parts = lanes.map(lane =>
    lane.jobs === null ? `${lane.name} busy ${minutesWords(lane.busyMs)}` : `${lane.name} ${plural(lane.jobs, 'job')}, ${minutesWords(lane.busyMs)}`,
  )
  return `Last 15 minutes: ${parts.join('; ')}`
}

type Run = { from: number; to: number; cell: LaneCell }

/** Consecutive cells of one state. */
function runsOf(cells: readonly LaneCell[]): Run[] {
  const runs: Run[] = []
  cells.forEach((cell, i) => {
    const last = runs[runs.length - 1]
    if (last && last.cell === cell) last.to = i + 1
    else runs.push({ from: i, to: i + 1, cell })
  })
  return runs
}

export type SvgChart = { source: string; alt: string; width: number; height: number }

/** The chart, `columns` cells wide: label 12 cells, bars, stats 8 cells; one row per lane and one for the axis. */
export function timelineSvg(lanes: readonly Lane[], columns: number): SvgChart {
  const width = Math.max(columns, 40) * CELL_PX
  const height = (lanes.length + 1) * ROW_PX
  const left = 13 * CELL_PX
  const right = 9 * CELL_PX
  const span = Math.max(LANE_CELLS, width - left - right)
  const x = (cell: number) => left + (cell / LANE_CELLS) * span
  const label = '#8F96A6'
  const grid = '#3B4354'
  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="monospace" font-size="11">`,
  ]
  for (const at of [0, 10, 20, 30]) parts.push(`<line x1="${x(at)}" y1="0" x2="${x(at)}" y2="${height - ROW_PX}" stroke="${grid}" stroke-width="1"/>`)
  lanes.forEach((lane, i) => {
    const role: Role = lane.isLead ? 'lead' : typeInfo(lane.key).role
    const color = SVG_PALETTE.role[role]
    const top = i * ROW_PX
    parts.push(`<text x="0" y="${top + 13}" fill="${color}">${escapeXml(lane.name)}</text>`)
    for (const run of runsOf(lane.cells)) {
      const x1 = x(run.from)
      const w = x(run.to) - x1
      if (run.cell === 'running') parts.push(`<rect x="${x1}" y="${top + 4}" width="${w}" height="11" rx="2" fill="${color}"/>`)
      else if (run.cell === 'busy')
        parts.push(`<rect x="${x1 + 0.5}" y="${top + 4.5}" width="${Math.max(0, w - 1)}" height="10" rx="2" fill="none" stroke="${color}"/>`)
      else if (run.cell === 'failed') {
        for (let c = run.from; c < run.to; c++) {
          const cx = x(c + 0.5)
          parts.push(
            `<path d="M${cx - 4} ${top + 5}L${cx + 4} ${top + 14}M${cx + 4} ${top + 5}L${cx - 4} ${top + 14}" stroke="${SVG_PALETTE.bad}" stroke-width="2"/>`,
          )
        }
      }
    }
    parts.push(`<text x="${width}" y="${top + 13}" text-anchor="end" fill="${label}">${escapeXml(laneStats(lane).trim())}</text>`)
  })
  const axis = lanes.length * ROW_PX + 13
  for (const [at, text] of [[0, '-15m'], [10, '-10m'], [20, '-5m'], [30, 'now']] as const) {
    parts.push(`<text x="${x(at)}" y="${axis}" text-anchor="${at === 30 ? 'end' : 'start'}" fill="${label}">${text}</text>`)
  }
  parts.push('</svg>')
  return { source: parts.join(''), alt: timelineAlt(lanes), width, height }
}
