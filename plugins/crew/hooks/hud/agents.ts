import type { CrewAgent } from '../../types'
import { noteTool, planStepOf, tokensOf, trimEnded } from './activity'

/** The agent observation's host access: the clock, the agent list, the displayed records and the debug log. */
export type AgentIo = {
  now(): Promise<number>
  list(): Promise<{ id: string; type: string; status: string }[]>
  update(change: (list: CrewAgent[]) => CrewAgent[]): Promise<void>
  log(text: string): void
}

/** What an answered step reports that the HUD keeps: the model and the usage, and why it stopped. */
export type AnsweredStep = {
  usage?: {
    model: string
    input_tokens?: number
    output_tokens?: number
    cache_read_input_tokens?: number
    cache_creation_input_tokens?: number
  } | null
  stopReason?: string | null
}

/** What a step sent that the HUD shows: its model, and the host's effort when it names one. */
export type SentStep = { model: string; effort?: unknown }

/** A step's identity for its answer: the job generation and the step's token. */
export type NotedStep = { generation: number; token: number }

type Observation = 'spawn' | 'step' | 'answer'
type Early = { model: string; effort?: string; observedModel?: string; generation: number }
type Job = { pending: Partial<Record<Observation, () => Promise<void>>>; lifecycle: number; running: boolean }

export type AgentTracker = {
  /** Advances on `reset`; a write that began in an earlier lifecycle is dropped. */
  lifecycle(): number
  /** Before the spawn's `next`: the returned function records the spawn once the host has assigned its ID. */
  spawning(io: AgentIo): (spawn: { id: string; type: string; model: string; description?: string }) => void
  /** A step the HUD will show; a failure is logged and never alters the step. Returns the job identity. */
  stepped(io: AgentIo, id: string | undefined, sent: SentStep, loginEffort: string | undefined): NotedStep | undefined
  /** The model an answered step reports, for the job `stepped` returned; never throws. */
  answered(io: AgentIo, id: string | undefined, noted: NotedStep | undefined, answer: AnsweredStep): void
  /** A tool call the agent made, after its result: the name is kept from a fixed set, never the input. Never throws. */
  tooled(io: AgentIo, id: string | undefined, tool: unknown, failed: boolean): void
  /** The agent's turn is over: drops its queued observations and marks it ended. */
  completed(io: AgentIo, id: string): void
  /** The host's list is the truth about who is running or over; fills in agents the hooks did not see. */
  reconcile(io: AgentIo): Promise<void>
  /** A session ended: later writes of the old lifecycle are dropped and the per-job state is cleared. */
  reset(): void
}

/** Observation failures must never affect host results or router decisions. */
async function guarded(io: AgentIo, action: () => Promise<void>): Promise<void> {
  try { await action() } catch {
    try { io.log('crew HUD: observation failed') } catch { /* Reporting cannot change the observed result. */ }
  }
}

/** The agent job state: ID identity advances synchronously, independent of slow atom and clock writes. */
export function createAgentTracker(): AgentTracker {
  let lifecycle = 0
  const finished = new Set<string>()
  const generation = new Map<string, number>()
  const stepToken = new Map<string, number>()
  const provisional = new Map<string, Early>()
  const jobs = new Map<string, Job>()
  /** The effective type is captured at the innermost spawn, not inferred from routing. */
  const effective = new Map<string, string>()

  /** One active task and at most three replaceable pending observations per ID. */
  function queue(io: AgentIo, id: string, kind: Observation, action: () => Promise<void>): void {
    let job = jobs.get(id)
    if (!job) {
      job = { pending: {}, lifecycle, running: false }
      jobs.set(id, job)
    }
    job.pending[kind] = action
    if (job.running) return
    job.running = true
    const current = job
    void guarded(io, async () => {
      while (lifecycle === current.lifecycle && jobs.get(id) === current) {
        const kind = (['spawn', 'step', 'answer'] as const).find(name => current.pending[name])
        if (!kind) break
        const task = current.pending[kind]!
        delete current.pending[kind]
        await guarded(io, task)
      }
      if (jobs.get(id) === current) jobs.delete(id)
    })
  }

  async function observeSpawn(io: AgentIo, id: string, type: string, model: string, spawned: number, planStep: string | undefined): Promise<void> {
    if (finished.has(id) || (generation.get(id) ?? 0) !== spawned) return
    const started = lifecycle
    const time = await io.now()
    if (lifecycle !== started) return
    await io.update(list => {
      if (lifecycle !== started || finished.has(id) || (generation.get(id) ?? 0) !== spawned) return list
      const previous = list.find(agent => agent.id === id)
      const early = provisional.get(id)
      const record: CrewAgent = { ...previous, id, type, model: early?.model ?? previous?.model ?? model,
        startedAt: previous?.startedAt ?? time, seenAt: undefined, status: 'running',
        effort: early?.effort ?? previous?.effort, observedModel: early?.observedModel ?? previous?.observedModel,
        ...(planStep !== undefined || previous?.planStep !== undefined ? { planStep: planStep ?? previous?.planStep } : {}) }
      return [...list.filter(agent => agent.id !== id), record]
    })
    provisional.delete(id)
  }

  async function observeStep(io: AgentIo, id: string, model: string, effort: string | undefined, stepped: number): Promise<void> {
    const started = lifecycle
    const time = await io.now()
    if (lifecycle !== started) return
    await io.update(list => {
      if (lifecycle !== started || finished.has(id) || generation.get(id) !== stepped) return list
      const previous = list.find(agent => agent.id === id)
      const type = previous?.type ?? effective.get(id)
      if (!type) return list
      const restart = previous?.status === 'ended'
      // The activity belongs to the job: a restart begins it again, and only the plan step stays.
      const activity: Partial<CrewAgent> = previous === undefined ? {} : restart ? (previous.planStep === undefined ? {} : { planStep: previous.planStep }) : {
        ...(previous.steps === undefined ? {} : { steps: previous.steps }),
        ...(previous.inTokens === undefined ? {} : { inTokens: previous.inTokens }),
        ...(previous.outTokens === undefined ? {} : { outTokens: previous.outTokens }),
        ...(previous.tools === undefined ? {} : { tools: previous.tools }),
        ...(previous.toolCount === undefined ? {} : { toolCount: previous.toolCount }),
        ...(previous.failures === undefined ? {} : { failures: previous.failures }),
        ...(previous.planStep === undefined ? {} : { planStep: previous.planStep }),
        ...(previous.stop === undefined ? {} : { stop: previous.stop }),
      }
      const record: CrewAgent = { ...activity, id, type, model: restart ? model : previous?.model ?? model,
        status: 'running', ...(previous?.seenAt !== undefined && !restart ? { seenAt: previous.seenAt } :
          { startedAt: restart ? time : previous?.startedAt ?? time }),
        ...(restart ? {} : { observedModel: previous?.observedModel }),
        ...(effort ? { effort } : restart ? {} : { effort: previous?.effort }),
      }
      return [...list.filter(agent => agent.id !== id), record]
    })
  }

  async function observeAnswer(io: AgentIo, id: string, answer: AnsweredStep & { usage: NonNullable<AnsweredStep['usage']> },
    answered: number, token: number): Promise<void> {
    const observed = answer.usage.model
    const { inTokens, outTokens } = tokensOf(answer.usage)
    if (generation.get(id) !== answered || stepToken.get(id) !== token || finished.has(id)) return
    const started = lifecycle
    const early = provisional.get(id)
    if (early?.generation === answered) early.observedModel = observed
    await io.update(list => list.map(agent => agent.id === id && agent.status === 'running' &&
      lifecycle === started && !finished.has(id) && generation.get(id) === answered && stepToken.get(id) === token
      ? { ...agent, observedModel: observed, steps: (agent.steps ?? 0) + 1, inTokens, outTokens: (agent.outTokens ?? 0) + outTokens,
        ...(answer.stopReason === 'max_tokens' ? { stop: 'max_tokens' as const } : {}) } : agent))
  }

  return {
    lifecycle: () => lifecycle,

    spawning(io) {
      // The host assigns the ID after next; a job reopened while that call waits must win over this spawn.
      const before = new Map(generation)
      return ({ id, type, model, description }) => {
        if (!type.startsWith('crew:')) return
        const current = generation.get(id) ?? 0
        if (effective.has(id) && current > (before.get(id) ?? 0)) return
        effective.set(id, type)
        const planStep = planStepOf(description)
        if (!finished.has(id)) queue(io, id, 'spawn', () => observeSpawn(io, id, type, model, current, planStep))
      }
    },

    stepped(io, id, sent, loginEffort) {
      if (!id) return undefined
      try {
        const next = (generation.get(id) ?? 0) + (finished.has(id) || !generation.has(id) ? 1 : 0)
        generation.set(id, next)
        const token = (stepToken.get(id) ?? 0) + 1
        stepToken.set(id, token)
        finished.delete(id)
        const requested = loginEffort ?? /^(?:cx\/)?gpt-[\w-]+-(low|medium|high)$/.exec(sent.model)?.[1] ??
          (typeof sent.effort === 'string' ? sent.effort : undefined)
        if (!effective.has(id)) provisional.set(id, { model: sent.model, effort: requested, generation: next })
        queue(io, id, 'step', () => observeStep(io, id, sent.model, requested, next))
        return { generation: next, token }
      } catch {
        try { io.log('crew HUD: observation failed') } catch { /* Reporting cannot change the step. */ }
        return undefined
      }
    },

    answered(io, id, noted, answer) {
      try {
        const usage = answer.usage
        if (!id || !noted || !usage?.model) return
        queue(io, id, 'answer', () => observeAnswer(io, id, { usage, stopReason: answer.stopReason }, noted.generation, noted.token))
      } catch {
        try { io.log('crew HUD: observation failed') } catch { /* Reporting cannot change the step. */ }
      }
    },

    tooled(io, id, tool, failed) {
      try {
        // Only crew agents the tracker knows: another agent's calls cost no write.
        if (!id || !effective.has(id)) return
        const started = lifecycle
        void guarded(io, async () => {
          await io.update(list => lifecycle !== started ? list : list.map(agent => agent.id === id && agent.status === 'running'
            ? { ...agent, tools: noteTool(agent.tools, tool, failed), toolCount: (agent.toolCount ?? 0) + 1,
              failures: (agent.failures ?? 0) + (failed ? 1 : 0) } : agent))
        })
      } catch {
        try { io.log('crew HUD: observation failed') } catch { /* Reporting cannot change the call. */ }
      }
    },

    completed(io, id) {
      finished.add(id)
      provisional.delete(id)
      jobs.delete(id)
      void guarded(io, async () => {
        const time = await io.now()
        await io.update(list => trimEnded(list.map(agent => agent.id === id && finished.has(id)
          ? { ...agent, status: 'ended' as const, endedAt: time } : agent)))
      })
    },

    async reconcile(io) {
      const listed = await io.list()
      const time = await io.now()
      await io.update(records => {
        const result = [...records]
        for (const entry of listed) {
          if (!entry.type.startsWith('crew:')) continue
          const index = result.findIndex(record => record.id === entry.id)
          if (index < 0) {
            if (!finished.has(entry.id) && (entry.status === 'running' || entry.status === 'pending')) {
              effective.set(entry.id, entry.type)
              const early = provisional.get(entry.id)
              result.push({ id: entry.id, type: entry.type, model: early?.model, effort: early?.effort,
                observedModel: early?.observedModel, status: 'running', seenAt: time })
              provisional.delete(entry.id)
            }
          } else if (entry.status === 'completed' || entry.status === 'failed' || entry.status === 'killed' || entry.status === 'idle') {
            if (result[index]!.status !== 'ended') result[index] = { ...result[index]!, status: 'ended', endedAt: time }
            else result[index] = { ...result[index]!, status: 'ended' }
            finished.add(entry.id)
          }
        }
        return trimEnded(result)
      })
    },

    reset() {
      lifecycle++
      jobs.clear()
      provisional.clear()
      effective.clear()
      generation.clear()
      stepToken.clear()
      finished.clear()
    },
  }
}
