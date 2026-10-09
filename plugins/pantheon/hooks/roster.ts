import { ROLES } from './defaults'
import type { Engine, Job, Native, PantheonConfig, SessionInfo } from './types'

export const ROLE_ORDER = ['orchestrator', 'explorer', 'librarian', 'executor', 'oracle', 'designer', 'git', 'council'] as const
export type SlotName = (typeof ROLE_ORDER)[number]
export type { Engine } from './types'
export type RoundView = { startedAt: number; endedAt?: number; status: string }
export type Instance = {
  id: string
  engine: Engine
  seat?: string
  task: string
  model?: string
  status: string
  isActive: boolean
  startedAt: number
  endedAt?: number
  rounds: RoundView[]
  activity?: string
  tokens: { input?: number; cached?: number; out: number; ctx?: number; steps?: number }
  resumeId?: string
  /** Codex only: the id of the latest job of this line, the one `onCancel` stops. */
  jobId?: string
}
export type Slot = {
  name: SlotName; engine: Engine | 'mixed'; state: 'active' | 'idle' | 'off'
  model?: string
  /** Active instances first, then the ended ones, newest end first. The panel lists the active ones under Running and one summary row per role or seat under Idle. */
  instances: Instance[]
  lastEndedAt?: number; offReason?: string
  seatsOff?: string[]
  /** Council only: every configured seat name, sorted. */
  seats?: string[]
  /** The same instances with all rounds, oldest start first: the timeline's source. */
  history?: Instance[]
}
export type Roster = {
  slots: Slot[]; others: Instance[]; delegating: SlotName[]
  counts: { active: number; idle: number; off: number }
}

const roundView = (round: RoundView): RoundView => ({
  startedAt: round.startedAt, status: round.status,
  ...(round.endedAt !== undefined ? { endedAt: round.endedAt } : {}),
})

function codexInstance(rounds: Job[]): Instance {
  const latest = rounds[rounds.length - 1]
  const isActive = latest.status === 'running' || latest.status === 'background'
  return {
    id: rounds[0].id, engine: 'codex', task: latest.description ?? '', model: latest.model,
    ...roundView(latest), isActive, rounds: rounds.map(roundView), activity: latest.lastActivity,
    ...(latest.agent.startsWith('councillor:') ? { seat: latest.agent.slice('councillor:'.length) } : {}),
    tokens: latest.tokens
      ? { input: latest.tokens.input, cached: latest.tokens.cached, out: latest.tokens.output }
      : { out: 0 },
    jobId: latest.id,
    ...(latest.sessionId && !isActive ? { resumeId: latest.id } : {}),
  }
}

function nativeInstance(native: Native): Instance | undefined {
  const latest = native.rounds[native.rounds.length - 1]
  if (!latest) return undefined
  return {
    id: native.id, engine: 'claude', task: native.task, model: native.model,
    ...roundView(latest), isActive: latest.status === 'running',
    rounds: native.rounds.map(roundView), activity: native.lastTool,
    ...(native.role.startsWith('councillor-') ? { seat: native.role.slice('councillor-'.length) } : {}),
    tokens: { ctx: native.ctx, out: native.out, steps: native.steps },
  }
}

function jobSlot(agent: string): SlotName | undefined {
  const role = ROLES.find(role => role === agent)
  if (role) return role
  if (agent.startsWith('councillor:')) return 'council'
  return undefined
}

function nativeSlot(role: string): SlotName | undefined {
  const name = ROLES.find(name => name === role)
  if (name) return name
  if (role.startsWith('councillor-')) return 'council'
  return undefined
}

const endedTime = (instance: Instance): number => instance.endedAt ?? instance.startedAt

export function buildRoster(input: {
  jobs: Job[]; natives: Native[]; session: SessionInfo; config: PantheonConfig
}): Roster {
  const { jobs, natives, session, config } = input
  const byRole = new Map<SlotName, Instance[]>(ROLE_ORDER.map(name => [name, []]))
  const lines = new Map<string, Job[]>()
  for (const job of jobs) {
    // Keep jobs without a session distinct, even if a session ID equals a job ID.
    const key = job.sessionId ? `session:${job.sessionId}` : `job:${job.id}`
    const line = lines.get(key) ?? []
    line.push(job)
    lines.set(key, line)
  }
  for (const line of lines.values()) {
    const rounds = [...line].sort((a, b) => a.startedAt - b.startedAt)
    const instance = codexInstance(rounds)
    const latest = rounds[rounds.length - 1]
    const name = jobSlot(latest.agent)
    if (name) byRole.get(name)!.push(instance)
  }

  const others: Instance[] = []
  for (const native of natives) {
    const instance = nativeInstance(native)
    if (!instance) continue
    const name = nativeSlot(native.role)
    if (name) byRole.get(name)!.push(instance)
    else others.push(instance)
  }

  const seats = Object.keys(config.council.seats).sort()
  const seatsOff = seats.filter(name => {
    return config.disabledAgents.includes('council') ||
      config.disabledAgents.includes(`councillor:${name}`) ||
      config.disabledAgents.includes(`councillor-${name}`)
  })
  const councilEngines = new Set(seats.map(name => config.council.seats[name].engine))
  const councilModels = new Set(seats.filter(name => !seatsOff.includes(name))
    .map(name => config.council.seats[name].model))
  const slots = ROLE_ORDER.map((name): Slot => {
    if (name === 'orchestrator') return {
      name, engine: 'claude', state: session.isRunning ? 'active' : 'idle',
      model: session.model, instances: [],
    }
    const all = byRole.get(name)!
    const active = all.filter(instance => instance.isActive)
    const ended = all.filter(instance => !instance.isActive).sort((a, b) => endedTime(b) - endedTime(a))
    const off = name === 'council'
      ? config.disabledAgents.includes('council') || seatsOff.length === seats.length
      : config.disabledAgents.includes(name)
    const configuredEngine = name === 'council'
      ? councilEngines.size === 1 ? [...councilEngines][0] : 'mixed'
      : config.agents[name].engine
    const instances = [...active, ...ended]
    // The engine reads the active instances and the latest ended one: an older run on another engine never makes it mixed.
    const engine = [...active, ...ended.slice(0, 1)].some(instance => instance.engine !== configuredEngine) ? 'mixed' : configuredEngine
    const configuredModel = name === 'council'
      ? councilModels.size === 1 ? [...councilModels][0] : undefined
      : config.agents[name].model
    return {
      name, engine, state: off ? 'off' : active.length ? 'active' : 'idle',
      model: active.length ? active[0].model : configuredModel,
      instances,
      history: [...all].sort((a, b) => (a.rounds[0]?.startedAt ?? a.startedAt) - (b.rounds[0]?.startedAt ?? b.startedAt)),
      ...(ended[0]?.endedAt !== undefined ? { lastEndedAt: ended[0].endedAt } : {}),
      ...(off ? { offReason: 'disabledAgents' } : {}),
      ...(name === 'council' && !off && seatsOff.length ? { seatsOff } : {}),
      ...(name === 'council' ? { seats } : {}),
    }
  })
  const counts = { active: 0, idle: 0, off: 0 }
  for (const slot of slots) counts[slot.state]++
  return {
    slots, others,
    delegating: slots.filter(slot => slot.name !== 'orchestrator' && slot.state === 'active').map(slot => slot.name),
    counts,
  }
}

export function ago(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1_000))
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m`
  return `${Math.floor(seconds / 3_600)}h`
}
