// The one-line band above the prompt while a spider-team run is open, like a crew HUD's: a mark, the plan's counts,
// the tasks in progress and the agents running with the latest tool. Pure; the buttons are added where it is drawn.
import type { SpiderRun } from '../types'
import type { Lang } from './i18n'
import { counted, t } from './i18n'
import { effectiveState, isPlanned } from './state'
import { SPINNER, cells, fit, p } from './text'
import type { Piece } from './text'

export type BandView = { run: SpiderRun; running: number; agents: number; lastTool?: string; columns: number; lang: Lang; frame: number; animations: boolean }

const SEPARATOR = p(' │ ', 'dim')

/** How the run stands at a glance: a spinner while agents run, then how it ended, else a resting dot. */
function markOf(v: BandView): Piece {
  if (v.run.phase === 'complete') return p('✓', 'ok')
  if (v.run.phase === 'failed') return p('✗', 'error')
  if (v.run.phase === 'cancelled') return p('–', 'dim')
  if (v.running > 0) return p(v.animations ? SPINNER[v.frame % SPINNER.length]! : '●', 'ok')
  return p('●', 'dim')
}

/**
 * One line measured to `columns`, leaving room for the `×N ✕` buttons drawn beside it:
 * `● spider · 2 accepted / 1 running / 3 left │ T3 main  T4 worker │ 2 agents · Grep`. A narrow band drops the latest
 * tool first, then the tasks in progress, and cuts the counts last.
 */
export function bandLine(v: BandView): Piece[] {
  const s = t(v.lang)
  const states = v.run.tasks.filter(isPlanned).map(task => ({ task, state: effectiveState(v.run, task) }))
  const count = (...of: string[]) => states.filter(({ state }) => of.includes(state)).length
  const failed = count('failed')
  const counts = [
    p(`${counted(count('completed'), s.counts.acceptedOne, s.counts.accepted)} / `, 'dim'), p(`${count('running', 'reviewing')} ${s.counts.running}`, 'warn'),
    p(` / ${counted(count('pending', 'blocked'), s.counts.leftOne, s.counts.left)}`, 'dim'), ...(failed ? [p(` / ${counted(failed, s.counts.failedOne, s.counts.failed)}`, 'error')] : []),
  ]
  const active = states.filter(({ state }) => state === 'running' || state === 'reviewing').map(({ task }) => `${task.id} ${task.owner}`)
  const agents = [p(`${v.running} ${v.running === 1 ? s.agent : s.agents}`), ...(v.lastTool && v.running ? [p(` · ${v.lastTool}`, 'dim')] : [])]
  const head = [markOf(v), p(' '), p(s.team, 'accent'), p(' · ', 'dim')]
  const room = v.columns - cells(`×${v.agents} ✕`) - 1
  const size = (line: Piece[]) => line.reduce((n, piece) => n + cells(piece.text), 0)
  const full = [...head, ...counts, ...(active.length ? [SEPARATOR, p(active.join('  '), 'warn')] : []), SEPARATOR, ...agents]
  if (size(full) <= room) return full
  const noTool = [...head, ...counts, ...(active.length ? [SEPARATOR, p(active.join('  '), 'warn')] : []), SEPARATOR, agents[0]!]
  if (size(noTool) <= room) return noTool
  const short = [...head, ...counts, SEPARATOR, agents[0]!]
  return size(short) <= room ? short : fit([...head, ...counts], Math.max(1, room))
}
