// Run state, the step journal and the agents on a flow, ported from JevFlow's state.py and
// agents.py (SPEC 2, 10.1, 10.2). Pure: the caller reads and writes state.json and passes `now`.
// Every function returns a new state and never mutates its input.
//
// Ported without: the file I/O (load, atomic save) and the sub-step `subtasks` map. A claim's
// `as` is one of Pantheon's roles.

import { ROLES } from './types'
import type { AgentEntry, Flow, FlowState, HistoryEntry, Role } from './types'
import { eligible, ids } from './flow'

export const STATE_SCHEMA = 1
export const HISTORY_CAP = 500
export const MAX_AGENTS = 24
/**
 * The phase statuses JevFlow's state.py accepts. ./types also declares 'failed', which JevFlow
 * never sets, so state validation rejects it as state.py does.
 */
export const PHASE_STATUSES = ['pending', 'active', 'done'] as const
export type SettablePhaseStatus = (typeof PHASE_STATUSES)[number]

const COUNTERS = [
  'blocks_this_session', 'restarts', 'jev_calls', 'consecutive_blocks', 'stuck_streak', 'escalations', 'same_reason_count',
] as const
const NULLABLE = ['last_block_reason', 'last_error', 'needs_human', 'last_failure', 'review_streak'] as const

/** The state file is structurally invalid (JevFlow's StateError). */
export class StateError extends Error {}
const bad = (message: string): StateError => new StateError(message)

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const quote = (s: string): string => `'${s}'`
/** A Python-style rendering of a JSON value, for messages that quote the bad value. */
const show = (v: unknown): string => {
  if (typeof v === 'string') return quote(v)
  if (v === undefined || v === null) return 'None'
  if (typeof v === 'boolean') return v ? 'True' : 'False'
  return String(JSON.stringify(v))
}
const isPhaseStatus = (v: unknown): v is SettablePhaseStatus =>
  typeof v === 'string' && (PHASE_STATUSES as readonly string[]).includes(v)

/** A deep copy of plain JSON data. Object.fromEntries defines own keys, so a "__proto__" key stays data. */
function clonePlain(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(clonePlain)
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clonePlain(v)]))
  return value
}

type Entry = { event: string; phase?: string | null; [key: string]: unknown }

/** Append a journal entry (state.py `_append`): numbered by `seq`, stamped to the millisecond, the newest HISTORY_CAP kept. */
function appendEntry(state: FlowState, entry: Entry, now: number): FlowState {
  const seq = (state.seq ?? 0) + 1
  const history: HistoryEntry[] = [...state.history, { ts: Math.round(now * 1000) / 1000, seq, ...entry } as HistoryEntry]
  const capped = history.length > HISTORY_CAP ? history.slice(history.length - HISTORY_CAP) : history
  return { ...state, seq, history: capped, updated_at: now }
}

/** The state of a flow that has just started: its first eligible phase active, the rest pending. */
export function newState(flow: Flow, now: number): FlowState {
  const first = eligible(flow, {})[0]
  if (first === undefined) throw new Error('flow has no eligible first phase')
  const phaseStatus: Record<string, 'pending' | 'active'> = {}
  for (const id of ids(flow)) phaseStatus[id] = 'pending'
  phaseStatus[first] = 'active'
  return {
    state_schema: STATE_SCHEMA,
    flow_version: flow.flow_version,
    current_phase: first,
    phase_status: phaseStatus,
    blocks_this_session: 0,
    restarts: 0,
    jev_calls: 0,
    loop_iterations: {},
    phase_attempts: { [first]: 1 },
    consecutive_blocks: 0,
    stuck_streak: 0,
    escalations: 0,
    same_reason_count: 0,
    needs_human: null,
    last_failure: null,
    review_streak: null,
    last_block_reason: null,
    last_error: null,
    started_at: now,
    updated_at: now,
    history: [],
    done: false,
    agents: {},
  }
}

/**
 * Validate a loaded state and reconcile it with the flow (SPEC 10.3). Phases the flow no longer
 * has are dropped, new ones start pending, and a changed flow_version or current phase is brought
 * up to date; each of those is journaled as a `flow_changed` entry. Structural corruption throws
 * StateError. The input is not mutated; `now` stamps the defaults and the journal entry.
 */
export function validateState(raw: unknown, flow: Flow, now: number): FlowState {
  if (!isRecord(raw)) throw bad('state must be a JSON object')
  const copy = clonePlain(raw) as Record<string, unknown>
  if (typeof copy.current_phase !== 'string') throw bad('state.current_phase missing or wrong type')
  if (!isRecord(copy.phase_status)) throw bad('state.phase_status missing or wrong type')
  if (!Array.isArray(copy.history)) throw bad('state.history missing or wrong type')
  if (typeof copy.done !== 'boolean') throw bad('state.done missing or wrong type')

  for (const k of COUNTERS) {
    if (copy[k] === undefined) copy[k] = 0
    const v = copy[k]
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) throw bad(`state.${k} must be a non-negative integer`)
  }
  for (const k of ['loop_iterations', 'phase_attempts'] as const) {
    if (copy[k] === undefined) copy[k] = {}
    if (!isRecord(copy[k])) throw bad(`state.${k} must be an object`)
  }
  for (const k of NULLABLE) if (copy[k] === undefined) copy[k] = null
  if (copy.started_at === undefined) copy.started_at = now
  if (copy.updated_at === undefined) copy.updated_at = copy.started_at
  if (copy.state_schema === undefined) copy.state_schema = STATE_SCHEMA
  // Agents are informational; a malformed map is replaced, as touchAgent would replace it.
  if (!isRecord(copy.agents)) copy.agents = {}

  for (const [pid, st] of Object.entries(copy.phase_status)) {
    if (!isPhaseStatus(st)) throw bad(`state.phase_status[${quote(pid)}] = ${show(st)} is invalid`)
  }

  const state = copy as unknown as FlowState
  const phaseIds = ids(flow)
  const known = new Set(phaseIds)
  const changes: string[] = []
  for (const pid of Object.keys(state.phase_status)) {
    if (!known.has(pid)) {
      delete state.phase_status[pid]
      delete state.loop_iterations[pid]
      delete state.phase_attempts[pid]
      changes.push(`removed ${pid}`)
    }
  }
  for (const pid of phaseIds) {
    if (!Object.hasOwn(state.phase_status, pid)) {
      state.phase_status[pid] = 'pending'
      changes.push(`added ${pid}`)
    }
  }
  if (state.flow_version !== flow.flow_version) {
    changes.push(`flow_version ${show(state.flow_version)} -> ${show(flow.flow_version)}`)
    state.flow_version = flow.flow_version
  }
  if (!known.has(state.current_phase)) {
    state.current_phase = eligible(flow, state.phase_status)[0] ?? phaseIds.at(-1) ?? state.current_phase
    changes.push(`current_phase reset to ${state.current_phase}`)
  }
  if (changes.length === 0) return state
  return appendEntry(state, { event: 'flow_changed', detail: changes.join('; ') }, now)
}

/**
 * Journal one step (state.py `record`, without the save): the event, the phase (the current one
 * unless given) and any other fields. History keeps the newest HISTORY_CAP entries.
 */
export function record(state: FlowState, event: string, fields: { phase?: string | null; [key: string]: unknown }, now: number): FlowState {
  return appendEntry(state, { event, ...fields, phase: fields.phase || state.current_phase }, now)
}

/** Set one phase's status. Throws for an unknown phase or a status state.py does not accept. */
export function setPhaseStatus(state: FlowState, phaseId: string, status: SettablePhaseStatus): FlowState {
  if (!isPhaseStatus(status)) throw new Error(`bad phase status ${show(status)}`)
  if (!Object.hasOwn(state.phase_status, phaseId)) throw new Error(`unknown phase ${quote(phaseId)}`)
  return { ...state, phase_status: { ...state.phase_status, [phaseId]: status } }
}

/** Who a hook event comes from (agents.py reads it off the payload). */
export type AgentInfo = { sessionId?: string; agentId?: string; agentType?: string }

/** The agent key: `agent:<id>` for a subagent, else `session:<id>`, else undefined. Ids are cut to 64 characters. */
export function agentKey(info: AgentInfo): string | undefined {
  if (info.agentId) return 'agent:' + info.agentId.slice(0, 64)
  if (info.sessionId) return 'session:' + info.sessionId.slice(0, 64)
  return undefined
}

const LABEL_CHARS = 40

function defaultLabel(info: AgentInfo): string {
  if (info.agentId) return `${info.agentType || 'subagent'} ${info.agentId.slice(0, 6)}`
  return `claude ${(info.sessionId || '?').slice(0, 6)}`
}

/** Keep at most MAX_AGENTS entries, dropping the least recently seen. */
function capAgents(agents: Record<string, AgentEntry>): Record<string, AgentEntry> {
  const keys = Object.keys(agents)
  const excess = keys.length - MAX_AGENTS
  if (excess <= 0) return agents
  const drop = new Set([...keys].sort((a, b) => (agents[a]?.at ?? 0) - (agents[b]?.at ?? 0)).slice(0, excess))
  return Object.fromEntries(Object.entries(agents).filter(([k]) => !drop.has(k)))
}

/**
 * Record this agent's activity (agents.py `touch`). Its phase follows the flow's current phase
 * unless it holds a claim; a stop ends the claim (a claim lasts until the agent's turn ends).
 */
export function touchAgent(state: FlowState, info: AgentInfo, now: number, event: 'tool' | 'stop' | 'claim'): FlowState {
  const k = agentKey(info)
  if (k === undefined) return state
  const existing = Object.hasOwn(state.agents, k) ? state.agents[k] : undefined
  const a: AgentEntry = existing ? { ...existing } : {
    label: defaultLabel(info), kind: info.agentId ? 'subagent' : 'session', session: (info.sessionId ?? '').slice(0, 64),
    first_at: now, at: now, tools: 0, stops: 0, ...(info.agentType ? { type: info.agentType.slice(0, LABEL_CHARS) } : {}),
  }
  if (!a.claimed) a.phase = state.current_phase
  a.at = now
  if (event === 'tool') a.tools += 1
  else if (event === 'stop') {
    a.stops += 1
    delete a.claimed
  }
  return { ...state, agents: capAgents({ ...state.agents, [k]: a }) }
}

/**
 * Claim a phase for this agent as one of Pantheon's roles (agents.py `claim_from_output`, the role
 * standing in for `--as <name>`). Returns the new state, or the reason as a string when the role or
 * the phase is refused.
 */
export function claim(state: FlowState, info: AgentInfo, phase: string, role: string, now: number): FlowState | string {
  if (!(ROLES as readonly string[]).includes(role)) {
    return `unknown role ${quote(role)}; expected one of ${ROLES.join(', ')}`
  }
  if (!Object.hasOwn(state.phase_status, phase)) return `unknown phase ${quote(phase)}`
  const k = agentKey(info)
  if (k === undefined) return 'no agent to claim for'
  const touched = touchAgent(state, info, now, 'claim')
  const entry: AgentEntry = { ...touched.agents[k]!, phase, claimed: true, role: role as Role, label: role }
  return { ...touched, agents: { ...touched.agents, [k]: entry } }
}

/** The agent labels on each phase, in agent order. Agents without a phase are left out. */
export function byPhase(state: FlowState): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const a of Object.values(state.agents)) {
    if (typeof a !== 'object' || a === null || !a.phase) continue
    const labels = Object.hasOwn(out, a.phase) ? out[a.phase] : undefined
    if (labels === undefined) out[a.phase] = [a.label]
    else labels.push(a.label)
  }
  return out
}
