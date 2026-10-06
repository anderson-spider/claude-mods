import type { Agent, AgentKind } from './herdr'

/** How far `threads_start` got; a record that stops before `agent` has no helper running. */
export type Stage = 'creating' | 'worktree' | 'agent' | 'prompted'
export type Status = 'starting' | 'working' | 'idle' | 'blocked' | 'exited' | 'orphan' | 'branch-left' | 'closed'

/** Where a prompt left things, so that only what came after it counts as its answer. */
export type Marker = { at: number; completionSeq?: number; stateChangeSeq?: number; transcriptLines: number; seenWorking: boolean }

export type Thread = {
  id: string
  /** The session id of the lead chat that started it. */
  owner: string
  title: string
  agent: AgentKind
  requestedModel?: string
  stage: Stage
  status: Status
  workspaceId?: string
  paneId?: string
  agentName: string
  path?: string
  branch: string
  base: string
  sessionId?: string
  createdAt: number
  marker?: Marker
  idleSince?: number
  blockedNoticed?: boolean
  /** How many ticks a finished helper's answer has been looked for in vain. */
  awaitingAnswer?: number
  undelivered?: boolean
  /** Set while `threads_close` works on it, so the polling leaves it alone. */
  closing?: boolean
  /** What was found in a worktree that `threads_close` left in place. */
  kept?: { commits: number; dirty: boolean }
}

export type Pending = { threadId: string; kind: 'finished' | 'blocked' | 'exited' | 'orphan'; text: string; tries: number }
export type Registry = { threads: Thread[]; pending: Pending[]; listFailures: number }

export const emptyRegistry = (): Registry => ({ threads: [], pending: [], listFailures: 0 })

/** The statuses of a helper that still has an agent. */
export const LIVE: readonly Status[] = ['starting', 'working', 'idle', 'blocked']

export const liveOf = (r: Registry, owner: string): Thread[] => r.threads.filter(t => t.owner === owner && LIVE.includes(t.status))

/** Why no helper may start now, when the owner already has `max` live ones. */
export const capError = (r: Registry, owner: string, max: number): string | undefined => {
  const live = liveOf(r, owner)

  return live.length < max ? undefined : `Live helpers: ${live.map(t => t.id).join(', ')} (limit ${max}). Close one with threads_close first.`
}

/**
 * Brings the owner's records in line with Herdr's agents: a live record whose agent is gone is `exited`, or
 * `orphan` when it never got as far as starting one. `agents` undefined (a failed list) changes nothing.
 */
export const reconcile = (input: Registry, owner: string, agents: Agent[] | undefined): Registry => {
  // A session that is starting has no close in flight: a flag left by one that ended mid-close would hide the helper from the polling for good.
  const isMidClose = input.threads.some(t => t.owner === owner && t.closing === true)
  const r = isMidClose ? { ...input, threads: input.threads.map(t => (t.owner === owner && t.closing === true ? { ...t, closing: undefined } : t)) } : input

  if (agents === undefined) {
    return r
  }

  const names = new Set(agents.map(a => a.name))

  return {
    ...r,
    threads: r.threads.map(t => {
      if (t.owner !== owner || !LIVE.includes(t.status) || names.has(t.agentName)) {
        return t
      }

      return { ...t, status: t.stage === 'creating' || t.stage === 'worktree' ? 'orphan' : 'exited' }
    }),
  }
}

const DIGITS = '0123456789abcdefghijklmnopqrstuvwxyz'

/** Six base36 characters, none of the `taken` ids. */
export const newId = (taken: ReadonlySet<string>, random: () => number = Math.random): string => {
  for (;;) {
    const id = Array.from({ length: 6 }, () => DIGITS[Math.floor(random() * 36)] ?? '0').join('')

    if (!taken.has(id)) {
      return id
    }
  }
}

export type Event = { threadId: string; kind: 'finished' | 'blocked' | 'exited' }

/** How long a helper must stay idle before that alone, with an answer on disk, counts as finished. */
export const SETTLE_MS = 20_000

/**
 * What one `agent list` snapshot says about a helper. `finished` needs a signal that the prompt it was
 * given has been worked: `working` seen since, a completion counter that moved, or a settled idle with an
 * answer already on disk, so the idle of a helper that has not started yet is never announced.
 */
export const advance = (t: Thread, agent: Agent | undefined, now: number, answerReady: boolean): { thread: Thread; events: Event[] } => {
  const marker = t.marker

  if (marker === undefined || !LIVE.includes(t.status)) {
    return { thread: t, events: [] }
  }

  if (agent === undefined) {
    return { thread: { ...t, status: 'exited' }, events: [{ threadId: t.id, kind: 'exited' }] }
  }

  if (agent.status === 'blocked') {
    return {
      thread: { ...t, status: 'blocked', blockedNoticed: true },
      events: t.blockedNoticed === true ? [] : [{ threadId: t.id, kind: 'blocked' }],
    }
  }

  if (agent.status === 'working') {
    return { thread: { ...t, status: 'working', blockedNoticed: false, idleSince: undefined, marker: { ...marker, seenWorking: true } }, events: [] }
  }

  if (agent.status !== 'idle' && agent.status !== 'done') {
    return { thread: t, events: [] }
  }

  if (t.status === 'idle') {
    return { thread: { ...t, blockedNoticed: false }, events: [] }
  }

  const idleSince = t.idleSince ?? now
  const moved = agent.completionSeq !== undefined && marker.completionSeq !== undefined && agent.completionSeq > marker.completionSeq
  const isFinished = marker.seenWorking || moved || (now - idleSince >= SETTLE_MS && answerReady)

  if (isFinished) {
    return { thread: { ...t, status: 'idle', idleSince: undefined, blockedNoticed: false }, events: [{ threadId: t.id, kind: 'finished' }] }
  }

  return { thread: { ...t, status: t.status === 'blocked' ? 'working' : t.status, idleSince, blockedNoticed: false }, events: [] }
}
