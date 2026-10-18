// The band under the session card while a spider-team run is open: its title, a bar of accepted tasks and a status
// line. Pure; the buttons are added where it is drawn.
import type { SpiderRun } from '../types'
import type { Lang } from './i18n'
import { t } from './i18n'
import { progressOf } from './state'
import { SPINNER, bar, cells, cut, fit, p } from './text'
import type { Piece, Style } from './text'

const PHASE_STYLE: Partial<Record<SpiderRun['phase'], Style>> = { complete: 'ok', failed: 'error', cancelled: 'dim' }

export type BandView = { run: SpiderRun; running: number; agents: number; columns: number; lang: Lang; frame: number; animations: boolean }

/**
 * Three lines measured to `columns`: `SPIDER TEAM · title`, the bar with its percent, `phase · accepted/total tasks ·
 * n agents`. The status line leaves room for the `×N ✕` buttons drawn beside it, and a narrow band cuts the phase first.
 */
export function bandLines(v: BandView): Piece[][] {
  const s = t(v.lang)
  const { accepted, total, percent } = progressOf(v.run)
  const head = `${s.team} · `
  const title = [p(head, 'accent'), p(cut(v.run.title, v.columns - cells(head)), 'title')]
  const label = percent === undefined ? '' : ` ${percent}%`
  const barLine = [...bar(percent, v.columns - cells(label), v.animations ? v.frame : 0), ...(label ? [p(label, 'title')] : [])]
  const spin = v.animations && v.running > 0 ? [p(`${SPINNER[v.frame % SPINNER.length]} `, 'accent')] : []
  const counts = ` · ${accepted}/${total} ${s.tasks} · ${v.running} ${v.running === 1 ? s.agent : s.agents}`
  const width = v.columns - cells(`×${v.agents} ✕`)
  const phase = cut(s.phase[v.run.phase], Math.max(1, width - cells(counts) - (spin.length ? 2 : 0)))
  return [title, barLine, fit([...spin, p(phase, PHASE_STYLE[v.run.phase] ?? 'title'), p(counts, 'dim')], width)]
}
