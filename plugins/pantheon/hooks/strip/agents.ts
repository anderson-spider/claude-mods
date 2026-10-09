import { ROLE_COLOR, OK, BAD, cellWidth, truncCells } from '../theme'
import { DIM, TEXT, dot, run, width } from './runs'
import type { Run } from './runs'
import type { Job, Native } from '../../types'

// The running agents, folded into the box's last row: a pulse, the role in its color and a clock
// for each of up to three, "+N" for the rest. Pure: colors come from theme.ts, the clock from the
// `now` the caller reads.

export type AgentView = {
  id: string
  /** A pantheon role ("explorer", "council", ...) or the subagent type of a native that is not one ("Explore"). */
  role: string
  task: string
  startedAt: number
  status: 'running' | 'failed'
  /** When it failed: the clock stops there. */
  endedAt?: number
}

/** A failed agent stays in the summary this long, only while another is running. */
export const FAIL_GRACE_MS = 20_000
const NEUTRAL = '#8F96A6'
export const MAX_SHOWN = 3
/** Fewest cells of a task worth showing in the folded row. */
export const MIN_TASK = 8
export const PULSE = '●'

const roleColor = (role: string): string => (ROLE_COLOR as Record<string, string>)[role] ?? NEUTRAL

/** m:ss, or HhMM from an hour on (as the panel's clocks). */
export function fmtClock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(s / 60)
  return m < 60 ? `${m}:${String(s % 60).padStart(2, '0')}` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`
}

const isRole = (name: string): boolean => Object.hasOwn(ROLE_COLOR, name) && name !== 'orchestrator'

/** The label of a native: its pantheon role (councillor seats read "council"), else its subagent type. */
function nativeLabel(n: Native): string {
  if (n.role.startsWith('councillor-')) return 'council'
  if (isRole(n.role)) return n.role
  return n.type || 'agent'
}

/**
 * The agents to show, straight from the jobs and natives (not the slot-based roster, which folds
 * instances by role): every running one by start, then ones that failed within the grace window.
 * Nothing at all unless something is running.
 */
export function agentsFromState(jobs: Job[], natives: Native[], now: number): AgentView[] {
  const running: AgentView[] = []
  const failed: AgentView[] = []
  const add = (v: AgentView, isRunning: boolean, isFailed: boolean) => {
    if (isRunning) running.push(v)
    else if (isFailed && now - (v.endedAt ?? v.startedAt) <= FAIL_GRACE_MS) failed.push({ ...v, status: 'failed' })
  }
  // A resumed Codex line shares a session id: only its latest job counts.
  const lines = new Map<string, Job>()
  for (const job of jobs) {
    const key = job.sessionId ? `session:${job.sessionId}` : `job:${job.id}`
    const seen = lines.get(key)
    if (!seen || job.startedAt >= seen.startedAt) lines.set(key, job)
  }
  for (const job of lines.values()) {
    const role = job.agent.startsWith('councillor:') ? 'council' : job.agent
    const task = job.description || (job.agent.startsWith('councillor:') ? `seat ${job.agent.slice('councillor:'.length)}` : role)
    add({ id: job.id, role, task, startedAt: job.startedAt, status: 'running', endedAt: job.endedAt },
      job.status === 'running' || job.status === 'background', job.status === 'error')
  }
  for (const n of natives) {
    const latest = n.rounds[n.rounds.length - 1]
    if (!latest) continue
    const label = nativeLabel(n)
    add({ id: n.id, role: label, task: n.task || label, startedAt: latest.startedAt, status: 'running', endedAt: latest.endedAt },
      latest.status === 'running', latest.status === 'failed')
  }
  if (running.length === 0) return []
  running.sort((a, b) => a.startedAt - b.startedAt)
  failed.sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))
  return [...running, ...failed]
}

/** A key that changes when the visible set does (to redraw on start and end). */
export function agentsKey(agents: AgentView[]): string {
  return agents.map(a => `${a.id}:${a.status}`).join(',')
}

const pulseOf = (a: AgentView): Run => run(PULSE, a.status === 'failed' ? BAD : OK)
const clockOf = (a: AgentView, now: number): string => fmtClock((a.endedAt ?? now) - a.startedAt)

/** The folded agents row (without the box's padding), fitted to `room` cells; empty when nothing runs. */
export function agentsRow(agents: AgentView[], room: number, now: number): Run[] {
  if (agents.length === 0) return []
  const shown = agents.slice(0, MAX_SHOWN)
  const more = agents.length - shown.length
  const lead = [run('agents ', DIM)]
  const build = (budgets: number[]): Run[] => {
    const body: Run[] = []
    shown.forEach((a, i) => {
      if (i) body.push(dot())
      body.push(pulseOf(a), run(' '), run(a.role, roleColor(a.role), { bold: true }))
      if (budgets[i] > 0) body.push(run(' ' + truncCells(a.task, budgets[i]), TEXT))
      body.push(run(' ' + clockOf(a, now), TEXT, { bold: true }))
    })
    if (more) body.push(run(` +${more}`, DIM))
    return [...lead, ...body]
  }
  // The free width is shared between the tasks: a short task takes what it needs and leaves the
  // rest to the longer ones. Below MIN_TASK cells each, a task is not worth showing.
  const none = shown.map(() => 0)
  const free = room - width(build(none)) - shown.length
  if (free / shown.length >= MIN_TASK) {
    const budgets = none.slice()
    let left = free
    let remaining = shown.length
    for (const i of shown.map((_, k) => k).sort((x, y) => cellWidth(shown[x].task) - cellWidth(shown[y].task))) {
      budgets[i] = Math.min(cellWidth(shown[i].task), Math.floor(left / remaining))
      left -= budgets[i]
      remaining--
    }
    const row = build(budgets)
    if (width(row) <= room) return row
  }
  const bare = build(none)
  if (width(bare) <= room) return bare
  // The narrowest form: how many run and the oldest clock.
  const oldest = fmtClock(Math.max(...agents.map(a => (a.endedAt ?? now) - a.startedAt)))
  const count = agents.filter(a => a.status === 'running').length || agents.length
  return [...lead, run(`${count} running`, OK, { bold: true }), dot(), run(`oldest ${oldest}`, TEXT)]
}
