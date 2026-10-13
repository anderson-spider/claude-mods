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
export type Style = 'plain' | 'heading' | 'secondary' | 'success' | 'warning' | 'error' | 'info' | 'accent'
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

const seg = (text: string, style: Style = 'plain'): Segment => ({ text, style })
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/** One row cut to the width, the cut ending in an ellipsis; segments keep their styles. */
function cutRow(row: Row, columns: number): Row {
  const width = Math.max(4, Math.floor(Number.isFinite(columns) ? columns : 60))
  const out: Row = []
  let used = 0
  for (const part of row) {
    if (used + part.text.length <= width) { out.push(part); used += part.text.length; continue }
    const room = width - used
    if (room > 1) out.push({ text: `${part.text.slice(0, room - 1)}…`, style: part.style })
    else if (out.length) out[out.length - 1] = { ...out[out.length - 1]!, text: `${out[out.length - 1]!.text.slice(0, -1)}…` }
    return out
  }
  return out
}

/** One bordered section of the pane: its title, its tone (the border's colour) and its rows. */
export type Box = { title: Row; tone: Style; rows: Row[] }
/** The pane as the screen draws it: a head row, the boxes and a foot row. */
export type Pane = { head: Row; boxes: Box[]; foot: Row; empty: boolean }

const ROLE_STYLE: Record<string, Style> = { digger: 'success', planner: 'accent', challenger: 'warning' }
const isCrew = (agent: AgentRecord) => agent.type.startsWith('crew:')

/** The role's short name and whether it is the twin on Codex: `crew:planner-codex` is `planner`, twin. */
function roleName(type: string): { name: string; base: string; twin: boolean } {
  const known = role(type)
  if (known === '?') return { name: '?', base: '?', twin: false }
  const name = known.slice('crew:'.length)
  const twin = name.endsWith('-codex')
  return { name, base: twin ? name.slice(0, -'-codex'.length) : name, twin }
}
const roleRow = (type: string): Segment[] => {
  const { name, base, twin } = roleName(type)
  const style = ROLE_STYLE[base] ?? 'plain'
  return twin ? [seg(base, style), seg('·codex', 'info')] : [seg(name, style)]
}

function tokens(n: number | undefined): string {
  if (n === undefined || !Number.isSafeInteger(n) || n < 0) return '-'
  if (n < 1000) return String(n)
  return n < 1_000_000 ? `${(n / 1000).toFixed(1)}k` : `${(n / 1_000_000).toFixed(1)}M`
}
const ago = (from: number | undefined, now: number): string => {
  if (from === undefined || !Number.isFinite(from) || !Number.isFinite(now)) return ''
  const minutes = Math.floor(Math.max(0, now - from) / 60_000)
  return minutes < 1 ? 'just now' : `${minutes} min ago`
}
const toolNames = new Set(['Read', 'Grep', 'Glob', 'Bash', 'Edit', 'Write', 'NotebookEdit', 'WebSearch', 'WebFetch', 'Agent', 'SubagentHandback',
  'TodoWrite', 'Skill', 'LSP', 'Monitor', 'SendMessage', 'mcp'])
const toolLabel = (name: string) => (toolNames.has(name) ? name : '?')

/** The model as observed, else as requested; a differing request stays visible. */
function modelCells(agent: AgentRecord): Segment[] {
  const requested = model(agent.model)
  const observed = agent.observedModel !== undefined ? model(agent.observedModel) : undefined
  const effort = ['low', 'medium', 'high'].includes(agent.effort ?? '') ? ` · ${agent.effort}` : ''
  const cells = [seg(`${observed ?? requested}${effort}`, 'secondary')]
  if (observed !== undefined && observed !== requested) cells.push(seg(`  requested ${requested}`, 'secondary'))
  return cells
}

function statsText(agent: AgentRecord): string | undefined {
  const parts: string[] = []
  if (agent.inTokens !== undefined) parts.push(`ctx ${tokens(agent.inTokens)}`)
  if (agent.outTokens !== undefined) parts.push(`out ${tokens(agent.outTokens)}`)
  if (agent.steps !== undefined && Number.isSafeInteger(agent.steps)) parts.push(plural(agent.steps, 'step'))
  return parts.length ? parts.join('  ') : undefined
}

function toolRow(agent: AgentRecord): Row {
  const tools = (agent.tools ?? []).slice(-3)
  if (!tools.length) {
    const none = roleName(agent.type).twin && agent.steps === undefined ? 'no tool events or tokens reported' : 'no calls yet'
    return [seg('  └ ', 'secondary'), seg(none, 'secondary')]
  }
  const row: Row = [seg('  └ ', 'secondary')]
  tools.forEach((note, index) => {
    if (index) row.push(seg(' · ', 'secondary'))
    row.push(seg(toolLabel(note.name), note.failed ? 'error' : index === tools.length - 1 ? 'plain' : 'secondary'))
  })
  const calls = agent.toolCount !== undefined && Number.isSafeInteger(agent.toolCount) ? agent.toolCount : tools.length
  row.push(seg(`  ${plural(calls, 'call')}`, 'secondary'))
  const failed = count(agent.failures ?? 0)
  if (failed) row.push(seg(`  ✗ ${failed}`, 'error'))
  return row
}

function planBoxes({ plans, agents, columns }: Snapshot): Box[] {
  const boxes: Box[] = []
  const working = new Map<string, string[]>()
  for (const agent of agents) {
    if (agent.status !== 'running' || !isCrew(agent) || agent.planStep === undefined || !STEP_ID.test(agent.planStep)) continue
    working.set(agent.planStep, [...(working.get(agent.planStep) ?? []), roleName(agent.type).name])
  }
  for (const plan of plans) {
    if ('state' in plan) { boxes.push({ title: [seg(`Plan ${plan.state}`, 'heading')], tone: 'info', rows: [] }); continue }
    const rows: Row[] = []
    // Every step by id, so a dependency on another deliverable reads its state.
    const states = new Map<string, string>()
    for (const group of plan.groups) for (const step of group.steps) if (STEP_ID.test(step.id)) states.set(step.id, stepState(step.state))
    for (const group of plan.groups) {
      rows.push(cutRow([seg(label(group.heading)),
        seg(`  ${count(group.done)} done / ${count(group.running)} running / ${count(group.left)} left${group.unknownStates ? ' ?' : ''}`, 'secondary')], columns - 4))
      const steps = group.steps.filter(step => STEP_ID.test(step.id)).map(step => ({
        id: step.id,
        owner: owner(step.owner),
        after: step.after.filter(id => STEP_ID.test(id)),
        state: stepState(step.state),
      }))
      for (const treeRow of treeRows(steps, states)) {
        const id = /^[^ ]+ ([A-Z][A-Z0-9]*[a-z]?) /.exec(treeRow.body)?.[1]
        const who = id !== undefined ? working.get(id) : undefined
        const row: Row = [seg(`  ${treeRow.rail}`, 'secondary'), seg(treeRow.body, TONES[treeRow.tone])]
        if (who?.length) row.push(seg(`  ← ${who.join(', ')}`, 'secondary'))
        rows.push(cutRow(row, columns - 4))
      }
    }
    boxes.push({ title: [seg('Plan', 'heading'), seg(`  ${label(plan.name)}`, 'secondary')], tone: 'info', rows })
  }
  return boxes
}

function agentsBox({ agents, now, columns }: Snapshot): Box | undefined {
  const inner = columns - 4
  const compact = inner < 76
  const active = agents.filter(a => a.status === 'running' && isCrew(a))
    .sort((a, b) => (a.startedAt ?? a.seenAt ?? Infinity) - (b.startedAt ?? b.seenAt ?? Infinity) || a.id.localeCompare(b.id))
  if (!active.length) return undefined
  const rows: Row[] = []
  // The dot beats once a second: it turns hollow on odd seconds, so a stalled clock shows as a still dot.
  const lit = Number.isFinite(now) && Math.floor(now / 1000) % 2 === 0
  for (const agent of active) {
    const step = agent.planStep !== undefined && STEP_ID.test(agent.planStep) ? agent.planStep : undefined
    const stamp = agent.startedAt !== undefined ? duration(agent.startedAt, now) : `seen ${duration(agent.seenAt, now)}`
    const stats = statsText(agent)
    const line: Row = [seg(lit ? '● ' : '○ ', 'success'), ...roleRow(agent.type)]
    if (step) line.push(seg(`  ${step}`, 'warning'))
    line.push(seg('  '), ...modelCells(agent), seg(`  ${stamp}`))
    if (stats && !compact) line.push(seg(`  ${stats}`, 'secondary'))
    rows.push(cutRow(line, inner))
    if (stats && compact) rows.push(cutRow([seg(`  ${stats}`, 'secondary')], inner))
    rows.push(cutRow(toolRow(agent), inner))
  }
  return { title: [seg(`Agents · running ${active.length}`, 'heading')], tone: 'success', rows }
}

function recentBox({ agents, now, columns }: Snapshot): Box | undefined {
  const inner = columns - 4
  const ended = agents.filter(a => a.status === 'ended' && isCrew(a))
    .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0) || a.id.localeCompare(b.id)).slice(0, 5)
  if (!ended.length) return undefined
  const rows = ended.map((agent): Row => {
    const failed = agent.stop === 'max_tokens'
    const step = agent.planStep !== undefined && STEP_ID.test(agent.planStep) ? agent.planStep : undefined
    const took = agent.startedAt !== undefined && agent.endedAt !== undefined ? duration(agent.startedAt, agent.endedAt) : undefined
    const stats = statsText(agent)
    const row: Row = [seg(failed ? '✗ ' : '● ', failed ? 'error' : 'secondary'), ...roleRow(agent.type)]
    if (step) row.push(seg(`  ${step}`, 'warning'))
    row.push(seg('  '), ...modelCells(agent))
    if (took) row.push(seg(`  ${took}`))
    if (stats) row.push(seg(`  ${stats}`, 'secondary'))
    if (failed) row.push(seg('  max_tokens', 'error'))
    const when = ago(agent.endedAt, now)
    if (when) row.push(seg(`  ${when}`, 'secondary'))
    return cutRow(row, inner)
  })
  return { title: [seg(`Recent · ${ended.length}`, 'secondary')], tone: 'secondary', rows }
}

/** The timeline window: every agent that ran in it, one bar each; a running agent's bar reaches the right edge. */
const WINDOW_MS = 15 * 60_000

function timelineBox({ agents, now, columns }: Snapshot): Box | undefined {
  const inner = columns - 4
  const start = now - WINDOW_MS
  const inWindow = agents.filter(a => isCrew(a) && Number.isFinite(now) && (a.startedAt ?? a.seenAt) !== undefined &&
    (a.status === 'running' || (a.endedAt !== undefined && a.endedAt >= start)))
    .sort((a, b) => (a.startedAt ?? a.seenAt ?? 0) - (b.startedAt ?? b.seenAt ?? 0) || a.id.localeCompare(b.id)).slice(-8)
  if (!inWindow.length) return undefined
  const labelWidth = 16
  const cells = Math.max(8, inner - labelWidth - 1)
  const at = (time: number) => Math.min(cells, Math.max(0, Math.round(((time - start) / WINDOW_MS) * cells)))
  const rows = inWindow.map((agent): Row => {
    const from = at(agent.startedAt ?? agent.seenAt ?? start)
    const running = agent.status === 'running'
    const to = running ? cells : Math.max(from + 1, at(agent.endedAt ?? now))
    const style: Style = running ? 'success' : agent.stop === 'max_tokens' ? 'error' : 'secondary'
    const name = roleName(agent.type).base
    const label = `${name}${agent.planStep !== undefined && STEP_ID.test(agent.planStep) ? ` ${agent.planStep}` : ''}`
    return [seg(label.slice(0, labelWidth - 1).padEnd(labelWidth), ROLE_STYLE[name] ?? 'plain'), seg('·'.repeat(Math.min(from, cells)), 'secondary'),
      seg('█'.repeat(Math.max(0, Math.min(to, cells) - from)), style), seg('·'.repeat(Math.max(0, cells - to)), 'secondary')]
  })
  const axis = '-15m'.padEnd(Math.floor(cells / 3)) + '-10m'.padEnd(Math.floor(cells / 3)) + '-5m'
  rows.push([seg(' '.repeat(labelWidth)), seg(`${axis.padEnd(cells - 3)}now`.slice(0, cells), 'secondary')])
  return { title: [seg('Last 15 minutes', 'accent')], tone: 'accent', rows }
}

/** The pane's parts from one snapshot, top to bottom; the screen draws the boxes, scrolling is the host's. */
export function paneView(snapshot: Snapshot): Pane {
  const crew = snapshot.agents.filter(isCrew)
  const running = crew.filter(a => a.status === 'running').length
  const recent = crew.length - running
  const head: Row = [seg('Crew', 'heading')]
  if (running) head.push(seg(`  ● ${running} running`, 'success'))
  if (recent) head.push(seg(`  ${recent} recent`, 'secondary'))
  const boxes = [...planBoxes(snapshot), agentsBox(snapshot), recentBox(snapshot), timelineBox(snapshot)]
    .filter((box): box is Box => box !== undefined)
  return { head: cutRow(head, snapshot.columns), boxes, foot: [seg(plural(crew.length, 'agent'), 'secondary')],
    empty: boxes.length === 0 && crew.length === 0 }
}

/**
 * The pane's rows as plain text rows: head, then each box's title and rows, then the foot. `maxRows` is a viewport;
 * what does not fit is replaced by one line that says how many rows were left out.
 */
export function paneRows(snapshot: Snapshot, maxRows = Infinity): Band {
  const view = paneView(snapshot)
  const all = [view.head, ...view.boxes.flatMap(box => [box.title, ...box.rows]), view.foot]
  const rows = view.empty ? [] : all
  if (!(maxRows >= 2) || rows.length <= maxRows) return { rows }
  const kept = rows.slice(0, Math.floor(maxRows) - 1)
  return { rows: [...kept, [seg(fit(`  … ${rows.length - kept.length} more rows`, snapshot.columns), 'secondary')]] }
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
