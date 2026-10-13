import { CREW_TYPES, SPECIALISTS } from '../agents'
import { CODEX_MODELS, CODEX_PREFIX } from '../native'
import { treeRows } from './graph'
import type { Tone } from './graph'

export type PlanProjection = {
  name: string
  groups: readonly {
    heading: string
    done: number
    running: number
    left: number
    steps: readonly { id: string; owner: string; after: readonly string[]; state: string }[]
    unknownStates: boolean
  }[]
}
export type AgentRecord = {
  id: string
  type: string
  model: string | undefined
  observedModel?: string
  effort?: string
  startedAt?: number
  seenAt?: number
  status: 'running' | 'ended'
  steps?: number
  inTokens?: number
  outTokens?: number
  tools?: readonly { name: string; failed: boolean }[]
  toolCount?: number
  failures?: number
  planStep?: string
  endedAt?: number
  stop?: 'max_tokens'
}
export type Style = 'plain' | 'heading' | 'secondary' | 'success' | 'warning' | 'error'
export type Segment = { text: string; style: Style }
export type Row = Segment[]
export type Band = { rows: Row[] }
export type PlanDisplay = PlanProjection | { state: 'loading' | 'unknown' }

const roles: ReadonlySet<string> = new Set(CREW_TYPES)
const models: ReadonlySet<string> = new Set(SPECIALISTS.map(s => s.model))
const codex: ReadonlySet<string> = new Set(Object.values(CODEX_MODELS))
const CLAUDE_ID = /^claude-(opus|sonnet|haiku|fable)-[0-9]+(-[0-9]+)*(-[0-9]{8})?$/
const STEP_ID = /^[A-Z][A-Z0-9]*[a-z]?$/

/** A projection is already redacted by plan.ts; reject any unsafe label even when another caller supplied it. */
function label(value: string): string {
  if (typeof value !== 'string' || !value || value.length > 120 || /[^\x20-\x7e]/.test(value) ||
    /[/\\<>@]|\b(?:https?|file):|\b(?:token|secret|password|api[_-]?key)\b/i.test(value) ||
    value.includes('[redacted]') || value.includes('<path>')) return '?'
  return value.trim() || '?'
}
const role = (value: string): string => roles.has(value) ? value : '?'
const owner = (value: string): string => value === 'main' ? 'main' : role(value)
function model(value: string | undefined): string {
  if (value === undefined) return 'unknown'
  if (!value || value.length > 100) return '?'
  if (models.has(value) || CLAUDE_ID.test(value)) return value
  const id = value.startsWith(CODEX_PREFIX) ? value.slice(CODEX_PREFIX.length) : value
  const bare = id.replace(/-(low|medium|high)$/, '')
  return codex.has(bare) ? value : '?'
}
function duration(from: number | undefined, now: number): string {
  if (from === undefined || !Number.isFinite(from) || !Number.isFinite(now)) return 'unknown'
  const seconds = Math.floor(Math.max(0, now - from) / 1000)
  const tail = `${Math.floor(seconds / 60) % 60}:${String(seconds % 60).padStart(2, '0')}`
  return seconds < 3600 ? tail : `${Math.floor(seconds / 3600)}:${tail.padStart(5, '0')}`
}
/** Wrap by measured ASCII cells; an overlong token is broken rather than truncated. */
function add(rows: Row[], text: string, columns: number, style: Style = 'plain', indent = 0): void {
  const width = Math.max(4, Math.floor(Number.isFinite(columns) ? columns : 60))
  let line = ''
  let first = true
  const leading = Math.min(text.length - text.trimStart().length, width - 2)
  const flush = () => { if (line) rows.push([{ text: line.trimEnd(), style }]); line = ''; first = false }
  for (const word of text.trimStart().split(/(\s+)/).filter(Boolean)) {
    if (!line && !word.trim()) continue
    let remaining = word
    while (remaining) {
      if (!line) line = ' '.repeat(first ? leading : Math.min(indent, width - 2))
      const space = width - line.length
      if (remaining.length <= space) { line += remaining; remaining = ''; continue }
      if (remaining.trim() && line.trim() && remaining.length <= width - Math.min(indent, width - 2)) { flush(); continue }
      line += remaining.slice(0, space)
      remaining = remaining.slice(space)
      flush()
    }
  }
  flush()
}

/** Everything a section may read: prepared atoms, the clock and the render width, never a host. */
export type Snapshot = { plans: readonly PlanDisplay[]; agents: readonly AgentRecord[]; now: number; columns: number }
type Section = (snapshot: Snapshot) => Row[]

const STATES: ReadonlySet<string> = new Set(['queued', 'implementing', 'verified', 'blocked', 'committed', 'skipped'])
const TONES: Record<Tone, Style> = { done: 'secondary', running: 'warning', blocked: 'error', waiting: 'secondary', ready: 'plain', unknown: 'plain' }
const count = (n: number) => (Number.isSafeInteger(n) && n >= 0 ? n : 0)
const stepId = (id: string) => (typeof id === 'string' && STEP_ID.test(id) ? id : '?')
const stepState = (state: string) => (STATES.has(state) ? state : '?')

/** One line cut to the width: the tree's rows are not wrapped, a cut one ends in an ellipsis. */
function fit(text: string, columns: number): string {
  const width = Math.max(4, Math.floor(Number.isFinite(columns) ? columns : 60))
  return text.length <= width ? text : `${text.slice(0, width - 1)}…`
}

/** The pane's plan section: per deliverable its counts, then its steps as a tree (see `graph.ts`). */
function planRows({ plans, columns }: Snapshot): Row[] {
  const rows: Row[] = []
  for (const plan of plans) {
    if ('state' in plan) { add(rows, `Plan ${plan.state}`, columns, 'heading'); continue }
    add(rows, `Plan ${label(plan.name)}`, columns, 'heading')
    // Every step by id, so a dependency on another deliverable reads its state.
    const states = new Map<string, string>()
    for (const group of plan.groups) for (const step of group.steps) if (STEP_ID.test(step.id)) states.set(step.id, stepState(step.state))
    for (const group of plan.groups) {
      const heading = `  ${label(group.heading)}  ${count(group.done)} done / ${count(group.running)} running / ${count(group.left)} left${group.unknownStates ? ' ?' : ''}`
      add(rows, heading, columns)
      const steps = group.steps.filter(step => STEP_ID.test(step.id)).map(step => ({
        id: step.id,
        owner: owner(step.owner),
        after: step.after.filter(id => STEP_ID.test(id)),
        state: stepState(step.state),
      }))
      for (const row of treeRows(steps, states)) {
        const rail = `    ${row.rail}`
        const text = fit(`${rail}${row.body}`, columns)
        const railPart = text.slice(0, rail.length)
        const bodyPart = text.slice(rail.length)
        rows.push(bodyPart ? [{ text: railPart, style: 'secondary' }, { text: bodyPart, style: TONES[row.tone] }] : [{ text: railPart, style: 'secondary' }])
      }
    }
  }
  return rows
}

function agentRows({ agents, now, columns }: Snapshot): Row[] {
  const rows: Row[] = []
  const active = agents.filter(a => a.status === 'running' && a.type.startsWith('crew:'))
    .sort((a, b) => (a.startedAt ?? a.seenAt ?? Infinity) - (b.startedAt ?? b.seenAt ?? Infinity) || a.id.localeCompare(b.id))
  if (active.length) add(rows, 'Agents', columns, 'heading')
  for (const agent of active) {
    const requested = model(agent.model)
    const observed = model(agent.observedModel)
    const stamp = agent.startedAt !== undefined ? duration(agent.startedAt, now) : `seen ${duration(agent.seenAt, now)}`
    const text = `  ${role(agent.type)}  requested ${requested}${agent.observedModel !== undefined ? `  observed ${observed}` : ''}  effort ${['low', 'medium', 'high'].includes(agent.effort ?? '') ? agent.effort : 'unknown'}  ${stamp}`
    add(rows, text, columns, 'plain', 2)
  }
  return rows
}

/** One entry per pane section, top to bottom. A new pane section is one here and its own test. */
const SECTIONS: readonly Section[] = [planRows, agentRows]

/**
 * The pane's rows from one snapshot: plans as trees, then the running agents. `maxRows` is the viewport; what does
 * not fit is replaced by one line that says how many rows were left out.
 */
export function paneRows(snapshot: Snapshot, maxRows = Infinity): Band {
  const rows = SECTIONS.flatMap(section => section(snapshot))
  if (!(maxRows >= 2) || rows.length <= maxRows) return { rows }
  const kept = rows.slice(0, Math.floor(maxRows) - 1)
  return { rows: [...kept, [{ text: fit(`  … ${rows.length - kept.length} more rows`, snapshot.columns), style: 'secondary' }]] }
}

/**
 * The band above the prompt: one line (wrapped to the width) with the plans' totals, the running steps and the
 * running agents, so something is on screen where the pane has no room. Nothing idle is shown.
 */
export function bandRows(snapshot: Snapshot): Band {
  const { plans, agents, columns } = snapshot
  const projections = plans.filter((plan): plan is PlanProjection => !('state' in plan))
  const states = plans.flatMap(plan => ('state' in plan ? [plan.state] : []))
  const running = projections.flatMap(plan => plan.groups.flatMap(group =>
    group.steps.filter(step => stepState(step.state) === 'implementing').map(step => `${stepId(step.id)} ${owner(step.owner)}`)))
  const crew = agents.filter(a => a.status === 'running' && a.type.startsWith('crew:')).length
  const sum = (pick: (group: PlanProjection['groups'][number]) => number) =>
    projections.reduce((total, plan) => total + plan.groups.reduce((n, group) => n + count(pick(group)), 0), 0)
  const parts: string[] = []
  if (projections.length > 0) {
    const open = projections.some(plan => plan.groups.some(group => group.unknownStates))
    parts.push(`${sum(group => group.done)} done / ${sum(group => group.running)} running / ${sum(group => group.left)} left${open ? ' ?' : ''}`)
  }
  for (const state of ['loading', 'unknown']) if (states.includes(state as 'loading')) parts.push(`plan ${state}`)
  if (running.length > 0) parts.push(running.join('  '))
  if (crew > 0) parts.push(`${crew} agent${crew === 1 ? '' : 's'}`)
  if (parts.length === 0) return { rows: [] }
  const rows: Row[] = []
  add(rows, `crew  ${parts.join('  |  ')}`, columns, 'plain', 2)
  return { rows }
}
