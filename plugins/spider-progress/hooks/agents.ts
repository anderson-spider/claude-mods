// Every subagent the host reports, keyed by its `agentId`: what it was spawned as, the usage of each of its requests,
// the steps it reported itself and how it ended. Pure: the clock is injected.
import type { SpiderAgent } from '../types'
import { addUsage, costOf, usageOf, ZERO } from './metrics'
import { TIERS, taskIdOf, tierOf } from './tiers'

const NOTE_MAX = 200
const STEP_MAX = 1000

/** A spawned agent joins the list as running; a second spawn event for the same id changes nothing. */
export function spawned(list: SpiderAgent[], a: { agentId: string; type?: string; model?: string; prompt: string; now: number }, limit: number): SpiderAgent[] {
  if (list.some(agent => agent.agentId === a.agentId)) return list
  const tier = tierOf(a.type)
  const taskId = taskIdOf(a.prompt)
  const agent: SpiderAgent = {
    agentId: a.agentId,
    ...(a.type ? { type: a.type } : {}),
    ...(tier ? { tier, plannedEffort: TIERS[tier].effort } : {}),
    ...(taskId ? { taskId } : {}),
    ...(a.model ? { model: a.model } : {}),
    status: 'running',
    startedAt: a.now,
    lastUpdate: a.now,
    usage: ZERO,
    requests: 0,
  }
  return capped([...list, agent], limit)
}

/** A resumed agent (SendMessage, a teammate's wake) runs again under its id, with its usage and steps kept. */
export function resumed(list: SpiderAgent[], agentId: string, now: number): SpiderAgent[] {
  const agent = list.find(a => a.agentId === agentId && a.status !== 'running')
  if (!agent) return list
  const { endedAt: _ended, ...rest } = agent
  return replace(list, agent, { ...rest, status: 'running', lastUpdate: now })
}

/**
 * One request's usage, from a step or from the turn's end: the model that answered, its tokens and their cost. The
 * turn's end sums every request of the turn, so it says nothing of the context and leaves it unknown.
 */
function used(agent: SpiderAgent, model: string | undefined, raw: unknown, now: number, oneRequest = true): SpiderAgent {
  const u = usageOf(raw)
  const answered = typeof (raw as { model?: unknown } | null)?.model === 'string' ? (raw as { model: string }).model : model
  const next: SpiderAgent = { ...agent, lastUpdate: now, ...(answered ? { model: answered } : {}) }
  if (!u) return next
  const cost = costOf(answered, u)
  const tokens = Object.values(u).some(n => n > 0)
  return {
    ...next,
    usage: addUsage(agent.usage, u),
    requests: agent.requests + 1,
    ...(oneRequest ? { contextTokens: u.input + u.cacheRead + u.cacheWrite } : {}),
    ...(cost !== undefined ? { costUsd: (agent.costUsd ?? 0) + cost } : {}),
    ...(cost === undefined && tokens ? { costPartial: true as const } : {}),
  }
}

const replace = (list: SpiderAgent[], agent: SpiderAgent, next: SpiderAgent) => list.map(a => (a === agent ? next : a))

/** A running agent's request: its model, effort and usage; an agent the list does not hold is not added by a step. */
export function agentStepped(list: SpiderAgent[], agentId: string, step: { model?: string; effort?: string; usage: unknown }, now: number): SpiderAgent[] {
  const agent = list.find(a => a.agentId === agentId && a.status === 'running')
  if (!agent) return list
  const next = used(agent, step.model, step.usage, now)
  return replace(list, agent, step.effort ? { ...next, effort: step.effort } : next)
}

/** The steps an agent reports itself, as absolute counts: a repeat changes nothing, and only a running agent reports. */
export function stepReported(list: SpiderAgent[], agentId: string | undefined, input: Record<string, unknown>, now: number): { list: SpiderAgent[]; text: string } {
  if (!agentId) return { list, text: 'refused: only a subagent reports steps; Main reports with progress' }
  const agent = list.find(a => a.agentId === agentId)
  if (!agent) return { list, text: `ignored: no agent ${agentId}` }
  if (agent.status !== 'running') return { list, text: `ignored: ${agentId} already ended` }
  const { done, total } = input
  if (!Number.isInteger(done) || !Number.isInteger(total) || (done as number) < 0 || (done as number) > (total as number) || (total as number) > STEP_MAX) {
    return { list, text: `refused: done and total must be whole numbers with 0 ≤ done ≤ total ≤ ${STEP_MAX}` }
  }
  const note = typeof input.note === 'string' && input.note.trim() ? input.note.trim().slice(0, NOTE_MAX) : undefined
  const steps = { done: done as number, total: total as number, ...(note ? { note } : {}) }
  const text = `ok: ${steps.done}/${steps.total}`
  if (JSON.stringify(steps) === JSON.stringify(agent.steps)) return { list, text }
  return { list: replace(list, agent, { ...agent, steps, lastUpdate: now }), text }
}

/** A running agent's turn ended: `answer` is done, an abort is cancelled, anything else failed; usage no step reported is taken from the end. */
export function agentEnded(list: SpiderAgent[], agentId: string, reason: string, now: number, usage?: unknown): SpiderAgent[] {
  const agent = list.find(a => a.agentId === agentId && a.status === 'running')
  if (!agent) return list
  const status = reason === 'answer' ? 'done' : reason === 'aborted' ? 'cancelled' : 'failed'
  const base = agent.requests === 0 && usage !== undefined ? used(agent, agent.model, usage, now, false) : agent
  return replace(list, agent, { ...base, status, endedAt: now, lastUpdate: now })
}

/** At most `limit` agents: the oldest finished go first, and a running agent is never dropped. */
export function capped(list: SpiderAgent[], limit: number): SpiderAgent[] {
  let extra = list.length - limit
  if (extra <= 0) return list
  return list.filter(a => (extra > 0 && a.status !== 'running' ? (extra--, false) : true))
}
