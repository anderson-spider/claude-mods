// The band under the session card while a spider-team run is open: its title, a bar of accepted tasks and a status
// line. Pure; the buttons are added where it is drawn.
import type { SpiderRun } from '../types'
import type { Lang } from './i18n'
import { t } from './i18n'
import { progressOf } from './state'
import { SPINNER, bar, cells, cut, fit, p } from './text'
import type { Piece, Style } from './text'

const PHASE_STYLE: Partial<Record<SpiderRun['phase'], Style>> = { complete: 'ok', failed: 'error', cancelled: 'dim' }

export type BandView = { run: SpiderRun; running: number; columns: number; lang: Lang; frame: number; animations: boolean }

/** Three lines measured to `columns`: `SPIDER TEAM · title`, the bar with its percent, `phase · accepted/total tasks · n agents`. */
export function bandLines(v: BandView): Piece[][] {
  const s = t(v.lang)
  const { accepted, total, percent } = progressOf(v.run)
  const head = `${s.team} · `
  const title = [p(head, 'accent'), p(cut(v.run.title, v.columns - cells(head)), 'title')]
  const label = percent === undefined ? '' : ` ${percent}%`
  const barLine = [...bar(percent, v.columns - cells(label), v.frame), ...(label ? [p(label, 'title')] : [])]
  const spin = v.animations && v.running > 0 ? [p(`${SPINNER[v.frame % SPINNER.length]} `, 'accent')] : []
  const status = [
    ...spin,
    p(s.phase[v.run.phase], PHASE_STYLE[v.run.phase] ?? 'title'),
    p(` · ${accepted}/${total} ${s.tasks} · ${v.running} ${v.running === 1 ? s.agent : s.agents}`, 'dim'),
  ]
  return [title, barLine, fit(status, v.columns)]
}
