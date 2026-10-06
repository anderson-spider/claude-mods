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

/** The registry with the helper's owner changed; `undefined` when there is no such helper. */
export const adopt = (r: Registry, id: string, owner: string): Registry | undefined =>
  r.threads.some(t => t.id === id) ? { ...r, threads: r.threads.map(t => (t.id === id ? { ...t, owner } : t)) } : undefined

/**
 * Brings the owner's records in line with Herdr's agents: a live record whose agent is gone is `exited`, or
 * `orphan` when it never got as far as starting one. `agents` undefined (a failed list) changes nothing.
 */
export const reconcile = (r: Registry, owner: string, agents: Agent[] | undefined): Registry => {
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
