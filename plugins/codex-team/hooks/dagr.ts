// A small plan projection: first observations, one attempt, and reported plan receipts. Pure.
import type { Listed } from './herdr'
import type { Plan } from './plan'

export type Times = Record<string, string>
type Attempt = {
  id: string; n: number; cause: { type: 'initial' }; actor: string; started_at: string
  state: 'working' | 'done'; ended_at?: string
  locator?: { pane: string }
  liveness?: { prompt_acknowledged: false }
  outcome?: { result: 'done'; evidence: 'reported'; receipt: string }
}
type Task = {
  id: string; title: string; kind: string; owner: string; project: string; deps: string[]
  state: 'queued' | 'working' | 'done' | 'blocked' | 'canceled'; note?: string; unblock?: string; attempts: Attempt[]
}

export const kindOf = (owner: string): string => owner.startsWith('dev-') ? 'impl'
  : owner === 'architect' || owner.startsWith('architect-') ? 'review'
    : owner === 'analyst' || owner.startsWith('analyst-') ? 'docs' : 'ship'

/** The times file records first observation, not measured execution durations. */
export function buildDagr(plan: Plan, previous: Times, input: { now: string; agents: readonly Listed[]; pane?: string }) {
  const times: Times = { ...previous }
  const keyOf = (step: string, state: string): string => JSON.stringify([plan.id, step, state])
  const seen = (step: string, state: string): string => {
    const key = keyOf(step, state)
    return times[key] ?? (times[key] = input.now)
  }
  const tasks: Task[] = []
  const events: { at: string; type: 'attempt_started'; task: string; attempt: string; actor: string }[] = []
  for (const group of plan.deliverables) for (const step of group.steps) {
    const at = seen(step.id, step.state)
    const start = seen(step.id, 'start')
    const task: Task = { id: step.id, title: step.action.replace(/[`*]/g, '').slice(0, 72), kind: kindOf(step.owner), owner: step.owner,
      project: group.id, deps: [...step.after], state: 'queued', attempts: [], ...(step.note ? { note: step.note } : {}) }
    const attempt: Attempt = { id: `${step.id}·a1`, n: 1, cause: { type: 'initial' }, actor: step.owner, started_at: start, state: 'working' }
    if (step.state === 'verified' || step.state === 'committed') {
      attempt.state = 'done'
      attempt.ended_at = at < start ? start : at
      attempt.outcome = { result: 'done', evidence: 'reported', receipt: step.note || step.state }
      task.state = 'done'
      task.attempts = [attempt]
    } else if (step.state === 'implementing') {
      const pane = step.owner === 'main' || step.owner === 'git-master'
        ? input.pane : input.agents.find(agent => agent.name === step.owner)?.pane_id
      if (pane) {
        attempt.locator = { pane }
        // No prompt acknowledgement or output timestamp is supplied by the plan.
        attempt.liveness = { prompt_acknowledged: false }
        task.state = 'working'
        task.attempts = [attempt]
        events.push({ at: start, type: 'attempt_started', task: step.id, attempt: attempt.id, actor: step.owner })
      } else {
        // Without a live locator, executing the step is blocked; no working attempt is observable.
        task.state = 'blocked'
        task.unblock = `Restore a live pane for ${step.owner}`
      }
    } else if (step.state === 'blocked') {
      task.state = 'blocked'
      task.unblock = step.note || step.owner
    } else if (step.state === 'skipped') task.state = 'canceled'
    tasks.push(task)
  }
  const currentTimes = plan.deliverables.flatMap(group => group.steps.map(step => times[keyOf(step.id, 'start')]!))
  const document = {
    dagr: 3,
    run: { id: `run-${plan.id}`, title: plan.id, started_at: currentTimes.sort()[0]!, ...(input.pane ? { orchestrator: { pane: input.pane } } : {}) },
    generated_at: input.now,
    projects: plan.deliverables.map(group => ({ id: group.id, title: group.title })),
    tasks,
    events: events.sort((a, b) => a.at.localeCompare(b.at)),
  }
  return { document, times }
}
