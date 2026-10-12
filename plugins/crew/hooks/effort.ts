// The effort Jev chose for each routed subagent. `turn.step` carries an agent id, and the first step of a subagent can
// be sent before the spawn that started it has resolved with that id, so a decision is first pending under the call's
// type and description and is matched by `$.agent.list()` when an unknown id steps. Pure: the list is injected.
//
// An agent's effort never changes once a step has gone out (bar the exception below): the first step of an id
// decides it. An id that stepped before its effort was known (not listed yet, or calls alike with different efforts
// or apply policies) keeps what the host sent. A mid-run top-level effort change invalidates the cached message blocks; this rule avoids it except in the cases
// AGENTS.md lists.
//
// One exception, by design: a step with nothing pending is not recorded (a workflow's agent steps on every request).
// So an already-running agent of the same type and description with no entry of its own (spawned with an explicit
// model, or before /reload-plugins) that steps again after a matching entry is added can take that entry on its next
// step. Avoiding it would cost a `$.agent.list()` read per routable spawn.
//
// Every routable call has an entry, with the default effort when Jev changed nothing or failed: two calls alike then
// cannot swap efforts, because the ambiguity rule leaves both on their defaults. An entry that changes nothing is only
// counted by that rule: it is never applied to a step. Ids no list names (a workflow's
// agents, the engine's forks) never enter `stepped` or `byAgent`.

import type { Effort } from './agents'

export type Listed = { id: string; type: string; description: string; parentId?: string }
type Pending = { token: number; type: string; description: string; effort: Effort; parent?: string; apply: boolean; matchedBy?: string }

/** What `bind` found: `applied` and `matched` use the entry's effort; other outcomes keep an existing or unknown effort. */
export type BindOutcome = 'applied' | 'matched' | 'stepped' | 'known' | 'gone'

/** Entries kept for the session; the oldest go first. A resumed subagent keeps its effort while its entry stays. */
const CAP = 64
/** Ids that have stepped and were listed; one per subagent for the session, so it is bounded the same way. */
const STEPPED_CAP = 256
/** Ids that stepped unlisted while an entry is pending: dropped with the last entry, so the cap is rarely reached. */
const UNLISTED_CAP = 1024

export function createEffortBook() {
  let counter = 0
  let pending: Pending[] = []
  const byAgent = new Map<string, Effort>()
  const stepped = new Set<string>()
  /** Ids that stepped while no list named them; kept only while an entry is pending, because the spawn may name them. */
  const unlisted = new Set<string>()

  const remember = (id: string, effort: Effort) => {
    byAgent.delete(id)
    byAgent.set(id, effort)
    while (byAgent.size > CAP) byAgent.delete(byAgent.keys().next().value as string)
  }
  const markStepped = (id: string) => {
    stepped.delete(id)
    stepped.add(id)
    while (stepped.size > STEPPED_CAP) stepped.delete(stepped.values().next().value as string)
  }

  const settle = () => {
    if (pending.length === 0) unlisted.clear()
  }

  return {
    /**
     * Before the spawn continues: what the subagent will be started with (its default effort when Jev changed
     * nothing). `parent` is the spawning loop's agent id, when the host gives it. `apply` is false for an entry that
     * changes nothing: it only makes calls alike ambiguous. Returns the entry's token.
     */
    add(type: string, description: string, effort: Effort, parent?: string, apply = true): number {
      const token = ++counter
      pending.push({ token, type, description, effort, apply, ...(parent === undefined ? {} : { parent }) })
      if (pending.length > CAP) pending = pending.slice(-CAP)
      return token
    },
    /**
     * The spawn resolved with the agent's id. When a step matched the entry earlier by type and description, it may
     * have been another agent's (an unrouted call alike, a resumed one): that agent keeps what it already runs on,
     * and this id gets the effort unless it has stepped already. Says whether the effort took effect.
     */
    bind(token: number, agentId: string): BindOutcome {
      const entry = pending.find(p => p.token === token)
      pending = pending.filter(p => p.token !== token)
      const sawStep = unlisted.has(agentId)
      settle()
      if (!entry) return 'gone'
      if (!entry.apply) {
        // Nothing to apply; the id stays on what it runs on, and no later entry may take it.
        markStepped(agentId)
        return 'known'
      }
      if (entry.matchedBy === agentId) return 'matched'
      if (byAgent.get(agentId) === entry.effort) {
        // Another entry's step already put this id on the same effort (calls alike that crossed): it runs on it.
        markStepped(agentId)
        return 'matched'
      }
      if (stepped.has(agentId) || sawStep) {
        // A real subagent now (the spawn named it): its first step decided, and it stays decided.
        markStepped(agentId)
        return 'stepped'
      }
      if (byAgent.has(agentId)) return 'known'
      remember(agentId, entry.effort)
      return 'applied'
    },
    /** The fixed configuration already bound to an id, not observed execution or the host's default. */
    bound(agentId: string): Effort | undefined {
      return byAgent.get(agentId)
    },
    /** The spawn failed or was refused. */
    drop(token: number): void {
      pending = pending.filter(p => p.token !== token)
      settle()
    },
    /**
     * The effort for a stepping agent, or undefined for its default. The first step of an id decides: later steps
     * answer the same. Reads the list at most once per id, and only while an entry is pending.
     */
    async lookup(agentId: string, list: () => Promise<readonly Listed[]>): Promise<Effort | undefined> {
      const known = byAgent.get(agentId)
      if (known !== undefined) {
        remember(agentId, known)
        return known
      }
      if (stepped.has(agentId)) {
        markStepped(agentId)
        return undefined
      }
      if (unlisted.has(agentId)) return undefined
      // Nothing pending, so nothing is recorded: a workflow's agent steps here on every request.
      if (pending.length === 0) return undefined
      // From here an entry is pending and this id's first step goes out on its default: it stays there.
      const skip = () => {
        unlisted.add(agentId)
        while (unlisted.size > UNLISTED_CAP) unlisted.delete(unlisted.values().next().value as string)
        return undefined
      }
      if (!pending.some(p => p.matchedBy === undefined)) return skip()
      let agent: Listed | undefined
      try {
        agent = (await list()).find(a => a.id === agentId)
      } catch {
        agent = undefined
      }
      // The wait let other calls run: read the state again before deciding, so a bind or a step of this id that
      // happened meanwhile is honored and this first step agrees with the bind's outcome.
      const bound = byAgent.get(agentId)
      if (bound !== undefined) {
        remember(agentId, bound)
        return bound
      }
      if (stepped.has(agentId)) {
        markStepped(agentId)
        return undefined
      }
      if (unlisted.has(agentId)) return undefined
      // Entries that settled meanwhile: with none left nothing is recorded, as at the start.
      if (pending.length === 0) return undefined
      if (!agent) return skip()
      const open = pending.filter(p => p.matchedBy === undefined)
      markStepped(agentId)
      const same = open.filter(
        p =>
          p.type === agent.type &&
          p.description === agent.description &&
          (p.parent === undefined || agent.parentId === undefined || p.parent === agent.parentId),
      )
      const first = same[0]
      // Equal efforts with different apply policies are also ambiguous: never swap a fallback with a default entry.
      if (!first || same.some(p => p.effort !== first.effort || p.apply !== first.apply)) return undefined
      first.matchedBy = agentId
      // A default entry only blocked the ambiguity: the step keeps what the host sends.
      if (!first.apply) return undefined
      remember(agentId, first.effort)
      return first.effort
    },
  }
}

export type EffortBook = ReturnType<typeof createEffortBook>
