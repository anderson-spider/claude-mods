// A spider-team run and its tasks: what Main's `progress` calls set, checked against a transition table, and the two
// facts host events may add (a worker started on a task, a worker ended). Pure: the clock and the run id are injected.
import type { SpiderOwner, SpiderPhase, SpiderRun, SpiderTask, SpiderTaskState } from '../types'
import { cut } from './text'

export const LIMITS = { title: 120, tasks: 100, after: 20, text: 500, id: 20 } as const
/** The first try plus two returns from review; then Main escalates or fails the task. */
export const MAX_ATTEMPTS = 3
const MAX_ERRORS = 5

const OWNERS: readonly SpiderOwner[] = ['main', 'planner', 'worker', 'researcher', 'reviewer']
const STATES: readonly SpiderTaskState[] = ['pending', 'running', 'reviewing', 'completed', 'failed', 'cancelled']
const WORKING: readonly SpiderPhase[] = ['understand', 'plan', 'investigate', 'execute', 'review', 'verify']
const ENDING: readonly SpiderPhase[] = ['complete', 'cancelled', 'failed']
const TERMINAL: ReadonlySet<SpiderTaskState> = new Set(['completed', 'failed', 'cancelled'])

/** Main's moves; a same-state update is always a no-op, and a terminal state moves nowhere. */
const MOVES: Partial<Record<SpiderTaskState, readonly SpiderTaskState[]>> = {
  pending: ['running', 'completed', 'failed', 'cancelled'],
  running: ['reviewing', 'completed', 'failed', 'cancelled'],
  reviewing: ['completed', 'failed', 'cancelled', 'running'],
}

const TASK_ID = /^T\d{1,3}$/
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const text = (v: unknown, max: number): string | undefined => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined)

class Refusal extends Error {}
const refuse = (reason: string): never => { throw new Refusal(reason) }

export const isOver = (run: SpiderRun): boolean => run.finishedAt !== undefined || ENDING.includes(run.phase)

/** A task's state as drawn: a pending task waits blocked until every task it comes after is completed. */
export function effectiveState(run: SpiderRun, task: SpiderTask): SpiderTaskState | 'blocked' {
  if (task.state !== 'pending') return task.state
  return task.after.every(id => run.tasks.find(t => t.id === id)?.state === 'completed') ? 'pending' : 'blocked'
}

/** A task in the plan: a cancelled one leaves it, unless the run's cancellation is what cancelled it. */
export const isPlanned = (task: SpiderTask): boolean => task.state !== 'cancelled' || task.cancelledWithRun === true

/** Tasks Main accepted against the tasks still planned; no percent without tasks. */
export function progressOf(run: SpiderRun): { accepted: number; total: number; percent?: number } {
  const planned = run.tasks.filter(isPlanned)
  const accepted = planned.filter(t => t.state === 'completed').length
  return planned.length ? { accepted, total: planned.length, percent: Math.round((accepted / planned.length) * 100) } : { accepted, total: 0 }
}

type Planned = Pick<SpiderTask, 'id' | 'title' | 'owner' | 'after' | 'criteria'>

/** The task list as Main sent it, bounded; one malformed task refuses the whole list. */
function plannedOf(raw: unknown): Planned[] {
  if (!Array.isArray(raw)) refuse('tasks must be a list')
  const list = (raw as unknown[]).slice(0, LIMITS.tasks).map(item => {
    const id = record(item) && typeof item.id === 'string' && TASK_ID.test(item.id) ? item.id : undefined
    const title = record(item) ? text(item.title, LIMITS.title) : undefined
    const owner = record(item) && OWNERS.includes(item.owner as SpiderOwner) ? (item.owner as SpiderOwner) : undefined
    if (!record(item) || !id || !title || !owner) return refuse(`each task needs an id like T1, a title and an owner (${OWNERS.slice(0, -1).join(', ')} or ${OWNERS.at(-1)})`)
    const criteria = text(item.criteria, LIMITS.text)
    return { id, title, owner, after: Array.isArray(item.after) ? item.after : [], ...(criteria ? { criteria } : {}) }
  })
  const ids = new Set(list.map(t => t.id))
  if (ids.size !== list.length) refuse('task ids must be unique')
  const tasks = list.map(t => ({ ...t, after: [...new Set((t.after as unknown[]).filter((d): d is string => typeof d === 'string' && ids.has(d) && d !== t.id))].slice(0, LIMITS.after) }))
  const cycle = cycleOf(tasks)
  if (cycle) refuse(`the dependencies form a cycle (${cycle.join(' → ')})`)
  return tasks
}

/** A path that comes back to its start, if the `after` edges have one. */
function cycleOf(tasks: Planned[]): string[] | undefined {
  const after = new Map(tasks.map(t => [t.id, t.after]))
  const done = new Set<string>()
  const visit = (id: string, path: string[]): string[] | undefined => {
    const seen = path.indexOf(id)
    if (seen >= 0) return [...path.slice(seen), id]
    if (done.has(id)) return undefined
    for (const dep of after.get(id) ?? []) {
      const found = visit(dep, [...path, id])
      if (found) return found
    }
    done.add(id)
    return undefined
  }
  for (const t of tasks) {
    const found = visit(t.id, [])
    if (found) return found
  }
  return undefined
}

/** A new task's progress; a call builds its own arrays, so no two tasks share them. */
const fresh = () => ({ state: 'pending' as const, attempts: 1, errors: [] as string[], agentIds: [] as string[] })

/**
 * A replan: kept ids keep their progress and take the new plan, new and re-added cancelled ids start pending, dropped
 * ids are cancelled. Dropped tasks are kept for the pane only while the list stays within the task limit.
 */
function replanned(run: SpiderRun, planned: Planned[]): SpiderTask[] {
  const old = new Map(run.tasks.map(t => [t.id, t]))
  const kept = planned.map((p): SpiderTask => {
    const was = old.get(p.id)
    if (!was || was.state === 'cancelled') return { ...fresh(), ...p }
    const { criteria: _gone, ...carried } = was
    return { ...carried, ...p }
  })
  const dropped = run.tasks.filter(t => !planned.some(p => p.id === t.id)).map(t => (t.state === 'cancelled' ? t : { ...t, state: 'cancelled' as const }))
  return [...kept, ...dropped].slice(0, LIMITS.tasks)
}

function moved(run: SpiderRun, raw: unknown): SpiderRun {
  if (!record(raw)) return refuse('task must be { id, state }')
  const state = raw.state
  if (state === 'blocked') refuse('blocked is derived, not set')
  if (!STATES.includes(state as SpiderTaskState)) refuse(`state must be one of ${STATES.join(', ')}`)
  const at = run.tasks.findIndex(t => t.id === raw.id)
  if (at < 0) refuse(`no task ${cut(String(raw.id), LIMITS.id)}`)
  const task = run.tasks[at]!
  const to = state as SpiderTaskState
  const evidence = text(raw.evidence, LIMITS.text)
  const error = text(raw.error, LIMITS.text)
  let next: SpiderTask = { ...task }
  if (to !== task.state) {
    if (!MOVES[task.state]?.includes(to)) refuse(`${task.id} is ${task.state}`)
    if (task.state === 'reviewing' && to === 'running') {
      if (task.attempts >= MAX_ATTEMPTS) refuse(`${task.id} reached ${MAX_ATTEMPTS} attempts; escalate or fail it`)
      next.attempts = task.attempts + 1
    }
    next.state = to
  }
  if (evidence) next.evidence = evidence
  if (error) next = withError(next, error)
  if (to === task.state && !evidence && !error) return run
  return { ...run, tasks: run.tasks.map((t, i) => (i === at ? next : t)) }
}

const withError = (task: SpiderTask, error: string): SpiderTask => ({ ...task, errors: [...task.errors, error].slice(-MAX_ERRORS) })

function closed(run: SpiderRun, phase: SpiderPhase, now: number): SpiderRun {
  const tasks = phase === 'cancelled' ? run.tasks.map(t => (TERMINAL.has(t.state) ? t : { ...t, state: 'cancelled' as const, cancelledWithRun: true as const })) : run.tasks
  return { ...run, phase, finishedAt: now, tasks }
}

/**
 * One `progress` call from Main, applied whole or not at all: a title starts a run when none is open or when it differs
 * from the open run's (the old run is left behind), `tasks` replans, `task` moves one task, `phase` moves the run,
 * `finished` or `cancelled` closes it. A call for a closed run that starts none is ignored. The text is the tool's result.
 */
export function applyProgress(run: SpiderRun | null, input: Record<string, unknown>, ctx: { now: number; newRunId: () => string }): { run: SpiderRun | null; text: string } {
  try {
    const title = text(input.title, LIMITS.title)
    const begin = (name: string): SpiderRun => ({ runId: ctx.newRunId(), title: name, phase: 'plan', startedAt: ctx.now, tasks: [] })
    let next: SpiderRun
    if (run === null) next = title ? begin(title) : refuse('no run; start one with a title')
    else if (title && (title !== run.title || (isOver(run) && input.tasks !== undefined))) next = begin(title)
    else if (isOver(run)) {
      const { accepted, total } = progressOf(run)
      return { run, text: `ok: the run is over · ${accepted}/${total} tasks accepted · ${run.phase}` }
    } else next = run
    if (input.tasks !== undefined) {
      const tasks = replanned(next, plannedOf(input.tasks))
      if (JSON.stringify(tasks) !== JSON.stringify(next.tasks)) next = { ...next, tasks }
    }
    if (input.task !== undefined) next = moved(next, input.task)
    if (input.phase !== undefined) {
      const phase = input.phase as SpiderPhase
      if (WORKING.includes(phase)) { if (phase !== next.phase) next = { ...next, phase } }
      else if (ENDING.includes(phase)) next = closed(next, phase, ctx.now)
      else refuse(`phase must be one of ${[...WORKING, ...ENDING].join(', ')}`)
    }
    if (input.cancelled === true && !isOver(next)) next = closed(next, 'cancelled', ctx.now)
    if (input.finished === true && !isOver(next)) next = closed(next, 'complete', ctx.now)
    const { accepted, total } = progressOf(next)
    const kept = Array.isArray(input.tasks) && input.tasks.length > LIMITS.tasks ? ` · only the first ${LIMITS.tasks} tasks were kept` : ''
    return { run: next, text: `ok: ${accepted}/${total} tasks accepted · ${next.phase}${kept}` }
  } catch (error) {
    if (error instanceof Refusal) return { run, text: `refused: ${error.message}` }
    throw error
  }
}

/** A worker started on `taskId`: a pending task runs, and the agent is remembered on it; an unknown task changes nothing. */
export function bindWorker(run: SpiderRun, taskId: string, agentId: string): SpiderRun {
  const task = run.tasks.find(t => t.id === taskId)
  if (!task) return run
  const next: SpiderTask = { ...task, state: task.state === 'pending' ? 'running' : task.state, agentIds: task.agentIds.includes(agentId) ? task.agentIds : [...task.agentIds, agentId] }
  return { ...run, tasks: run.tasks.map(t => (t === task ? next : t)) }
}

/**
 * A worker on `taskId` ended: an answer sends a running task to review; a failure is recorded and waits for Main. A
 * task that does not list the worker, such as a later run's task with the same id, is left alone.
 */
export function workerEnded(run: SpiderRun, taskId: string, agentId: string, ok: boolean, error?: string): SpiderRun {
  const task = run.tasks.find(t => t.id === taskId)
  if (!task || !task.agentIds.includes(agentId)) return run
  const next = ok ? (task.state === 'running' ? { ...task, state: 'reviewing' as const } : task) : withError(task, text(error, LIMITS.text) ?? 'the worker ended without an answer')
  return next === task ? run : { ...run, tasks: run.tasks.map(t => (t === task ? next : t)) }
}
