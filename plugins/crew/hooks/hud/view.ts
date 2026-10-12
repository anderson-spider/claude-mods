import { SPECIALISTS, NATIVE_SUFFIX } from '../agents'
import { CODEX_MODELS, CODEX_PREFIX } from '../native'

export type PlanProjection = {
  name: string
  groups: readonly {
    heading: string
    done: number
    running: number
    left: number
    runningSteps: readonly { id: string; owner: string }[]
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
}
export type Style = 'plain' | 'heading' | 'secondary' | 'success' | 'warning' | 'error'
export type Segment = { text: string; style: Style }
export type Row = Segment[]
export type Band = { rows: Row[] }
export type PlanDisplay = PlanProjection | { state: 'loading' | 'unknown' }

const roles = new Set(SPECIALISTS.flatMap(s => [`crew:${s.name}`, `crew:${s.name}${NATIVE_SUFFIX}`]))
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
const owner = (value: string): string => value === 'lead' ? 'lead' : role(value)
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

/** Pure, host-independent rows from plan, agent and clock snapshots. */
export function bandRows(plans: readonly PlanDisplay[], agents: readonly AgentRecord[], now: number, columns: number): Band {
  const rows: Row[] = []
  for (const plan of plans) {
    if ('state' in plan) { add(rows, `Plan ${plan.state}`, columns, 'heading'); continue }
    add(rows, `Plan ${label(plan.name)}`, columns, 'heading')
    for (const group of plan.groups) {
      const count = (n: number) => Number.isSafeInteger(n) && n >= 0 ? n : 0
      const heading = `  ${label(group.heading)}  ${count(group.done)} done / ${count(group.running)} running / ${count(group.left)} left${group.unknownStates ? ' ?' : ''}`
      const steps = group.runningSteps.map(step => `${STEP_ID.test(step.id) ? step.id : '?'} ${owner(step.owner)}`)
      const together = `${heading}  |  ${steps.join('  ')}`
      if (steps.length && together.length <= columns && columns >= 100) add(rows, together, columns)
      else {
        add(rows, heading, columns)
        for (const step of steps) add(rows, `    ${step}`, columns, 'warning', 2)
      }
    }
  }
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
  return { rows }
}
