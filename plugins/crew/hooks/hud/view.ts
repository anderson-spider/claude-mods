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
export type Style = 'plain' | 'heading' | 'secondary' | 'success' | 'warning' | 'error' | 'info' | 'accent' | 'title' | 'frame' | 'track'
  | 'pill-running' | 'pill-recent'
/** A run of text in one style; `bold` adds weight (a role's name, a box title). */
export type Segment = { text: string; style: Style; bold?: boolean }
export type Row = Segment[]
/** Rows of styled segments, as `paneRows` flattens the pane. */
export type Rows = { rows: Row[] }
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
/** Everything a section may read: prepared atoms, the clock and the render width, never a host. */
export type Snapshot = { plans: readonly PlanDisplay[]; agents: readonly AgentRecord[]; now: number; columns: number }
type Section = (snapshot: Snapshot) => Row[]

const STATES: ReadonlySet<string> = new Set(['queued', 'implementing', 'verified', 'blocked', 'committed', 'skipped'])
const TONES: Record<Tone, Style> = { done: 'secondary', running: 'warning', blocked: 'error', waiting: 'secondary', ready: 'plain', unknown: 'plain' }
const count = (n: number) => (Number.isSafeInteger(n) && n >= 0 ? n : 0)
const stepState = (state: string) => (STATES.has(state) ? state : '?')

/** One line cut to the width: the tree's rows are not wrapped, a cut one ends in an ellipsis. */
function fit(text: string, columns: number): string {
  const width = widthOf(columns)
  return text.length <= width ? text : `${text.slice(0, width - 1)}…`
}

const widthOf = (columns: number) => Math.max(4, Math.floor(Number.isFinite(columns) ? columns : 60))
const seg = (text: string, style: Style = 'plain', bold = false): Segment => (bold ? { text, style, bold } : { text, style })
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
const cells = (row: Row) => row.reduce((n, part) => n + part.text.length, 0)

/** One row cut to the width, the cut ending in an ellipsis; segments keep their styles. */
function cutRow(row: Row, columns: number): Row {
  const width = widthOf(columns)
  const out: Row = []
  let used = 0
  for (const part of row) {
    if (used + part.text.length <= width) { out.push(part); used += part.text.length; continue }
    const room = width - used
    if (room > 1) out.push({ ...part, text: `${part.text.slice(0, room - 1)}…` })
    else if (out.length) out[out.length - 1] = { ...out[out.length - 1]!, text: `${out[out.length - 1]!.text.slice(0, -1)}…` }
    return out
  }
  return out
}

/** `left` at the start and `right` against the edge; when both do not fit, one row cut to the width. */
function spread(left: Row, right: Row, columns: number): Row {
  const room = widthOf(columns) - cells(left) - cells(right)
  if (!right.length) return cutRow(left, columns)
  if (room < 2) return cutRow([...left, seg('  '), ...right], columns)
  return [...left, seg(' '.repeat(room)), ...right]
}

/** Segments padded with spaces to a column's width; a longer cell is kept whole. */
function pad(row: Row, width: number): Row {
  const room = width - cells(row)
  return room > 0 ? [...row, seg(' '.repeat(room))] : row
}

/** One bordered section of the pane: its title, its tone (the border's colour) and its rows. */
export type Box = { title: Row; tone: Style; rows: Row[] }
/** The pane as the screen draws it: a head row, the boxes and a foot row. */
export type Pane = { head: Row; boxes: Box[]; foot: Row; empty: boolean }

const ROLE_STYLE: Record<string, Style> = { digger: 'success', planner: 'accent', challenger: 'warning' }
const isCrew = (agent: AgentRecord) => agent.type.startsWith('crew:')
/** At this inner width an agent's card and a recent row fit on one line, as the wide design draws them. */
const WIDE = 92

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
  return twin ? [seg(base, style, true), seg('·codex', 'info')] : [seg(name, style, true)]
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

const CLAUDE_SHORT = /^claude-(opus|sonnet|haiku|fable)-([0-9]{1,2}(?:-[0-9]{1,2})*)(?:-[0-9]{8})?$/
/** An allowlisted model as the card names it: `claude-haiku-4-5` is `haiku 4.5`, a twin's id loses its prefix. */
function shortModel(value: string): string {
  const claude = CLAUDE_SHORT.exec(value)
  if (claude) return `${claude[1]} ${claude[2]!.replace(/-/g, '.')}`
  return value.startsWith(CODEX_PREFIX) ? value.slice(CODEX_PREFIX.length) : value
}
/** The model's family, so a requested alias and the id it resolved to compare equal. */
const familyOf = (value: string) => CLAUDE_SHORT.exec(value)?.[1] ?? shortModel(value).replace(/-(low|medium|high)$/, '')

/** The model as observed, else as requested; a request of another family stays visible. */
function modelCells(agent: AgentRecord): Segment[] {
  const requested = model(agent.model)
  const observed = agent.observedModel !== undefined ? model(agent.observedModel) : undefined
  const effort = ['low', 'medium', 'high'].includes(agent.effort ?? '') ? ` · ${agent.effort}` : ''
  const cells = [seg(`${shortModel(observed ?? requested)}${effort}`, 'secondary')]
  if (observed !== undefined && !['?', 'unknown'].includes(requested) && familyOf(observed) !== familyOf(requested)) {
    cells.push(seg(`  requested ${shortModel(requested)}`, 'secondary'))
  }
  return cells
}

/** The window the context bar is drawn against: Claude models answer within 200k tokens; a twin's is not known. */
function windowOf(agent: AgentRecord): number | undefined {
  const id = model(agent.observedModel ?? agent.model)
  return models.has(id) || CLAUDE_ID.test(id) ? 200_000 : undefined
}

const BAR = 8
/** `ctx ▰▰▱▱▱▱▱▱ 24%` from the last step's input, or `ctx —` when there is no step or no known window. */
function contextCells(agent: AgentRecord): Row {
  const window = windowOf(agent)
  const used = agent.inTokens
  if (window === undefined || used === undefined || !Number.isSafeInteger(used) || used < 0) return [seg('ctx —', 'secondary')]
  const percent = Math.min(100, Math.round((used / window) * 100))
  const lit = Math.min(BAR, Math.round((percent / 100) * BAR))
  return [seg('ctx ', 'secondary'), seg('▰'.repeat(lit), 'success'), seg('▱'.repeat(BAR - lit), 'track'), seg(` ${percent}%`)]
}
const stepsText = (agent: AgentRecord) =>
  agent.steps !== undefined && Number.isSafeInteger(agent.steps) && agent.steps >= 0 ? plural(agent.steps, 'step') : 'steps —'
const tokensText = (agent: AgentRecord) =>
  agent.inTokens === undefined && agent.outTokens === undefined ? '' : `↑ ${tokens(agent.inTokens)}  ↓ ${tokens(agent.outTokens)}`
/** A twin on the helper runs in Codex's sandbox: no tool event and no usage ever reach the hooks. */
const onHelper = (agent: AgentRecord) => roleName(agent.type).twin && agent.steps === undefined

function toolRow(agent: AgentRecord): Row {
  const tools = (agent.tools ?? []).slice(-3)
  if (!tools.length) {
    return [seg('  └ ', 'secondary'), seg(onHelper(agent) ? 'runs in the Codex sandbox: no tool events or tokens' : 'no calls yet', 'secondary')]
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

/** `2 done / 1 running / 3 left`, the running count in the running colour. */
const totals = (done: number, running: number, left: number, open: boolean): Row => [
  seg(`${count(done)} done / `, 'secondary'), seg(`${count(running)} running`, count(running) ? 'warning' : 'secondary'),
  seg(` / ${count(left)} left${open ? ' ?' : ''}`, 'secondary')]

/** A settled step's glyph and word are dim and its id and owner plain; any other body takes its tone. */
function bodyCells(body: string, tone: Tone): Row {
  if (tone !== 'done') return [seg(body, TONES[tone])]
  const word = body.indexOf('  ')
  if (word < 2) return [seg(body, 'secondary')]
  return [seg(body.slice(0, 2), 'secondary'), seg(body.slice(2, word)), seg(body.slice(word), 'secondary')]
}

function planBoxes({ plans, agents, columns }: Snapshot): Box[] {
  const inner = columns - 4
  // The head names a lone plan, so its box is titled by its deliverable when it has only one, as the design draws it.
  const lone = plans.filter(plan => !('state' in plan)).length === 1
  const boxes: Box[] = []
  const working = new Map<string, string[]>()
  for (const agent of agents) {
    if (agent.status !== 'running' || !isCrew(agent) || agent.planStep === undefined || !STEP_ID.test(agent.planStep)) continue
    working.set(agent.planStep, [...(working.get(agent.planStep) ?? []), roleName(agent.type).name])
  }
  for (const plan of plans) {
    if ('state' in plan) { boxes.push({ title: [seg('Plan', 'info', true), seg(`  ${plan.state}`, 'secondary')], tone: 'info', rows: [] }); continue }
    const rows: Row[] = []
    // Every step by id, so a dependency on another deliverable reads its state.
    const states = new Map<string, string>()
    for (const group of plan.groups) for (const step of group.steps) if (STEP_ID.test(step.id)) states.set(step.id, stepState(step.state))
    const several = plan.groups.length > 1
    const byHeading = lone && plan.groups.length === 1
    for (const group of plan.groups) {
      if (!byHeading) rows.push(spread([seg(label(group.heading), 'secondary')],
        several ? totals(group.done, group.running, group.left, group.unknownStates) : [], inner))
      const steps = group.steps.filter(step => STEP_ID.test(step.id)).map(step => ({
        id: step.id,
        owner: owner(step.owner),
        after: step.after.filter(id => STEP_ID.test(id)),
        state: stepState(step.state),
      }))
      for (const treeRow of treeRows(steps, states)) {
        const id = /^[^ ]+ ([A-Z][A-Z0-9]*[a-z]?) /.exec(treeRow.body)?.[1]
        const who = id !== undefined ? working.get(id) : undefined
        const row: Row = [seg(`  ${treeRow.rail}`, 'secondary'), ...bodyCells(treeRow.body, treeRow.tone)]
        if (who?.length) row.push(seg(`  ← ${who.join(', ')}`, 'secondary'))
        rows.push(cutRow(row, inner))
      }
    }
    const sum = (pick: (group: PlanProjection['groups'][number]) => number) => plan.groups.reduce((n, group) => n + count(pick(group)), 0)
    const title = spread([seg('Plan', 'info', true), seg(`  ${label(byHeading ? plan.groups[0]!.heading : plan.name)}`, 'secondary')],
      plan.groups.length ? totals(sum(g => g.done), sum(g => g.running), sum(g => g.left), plan.groups.some(g => g.unknownStates)) : [], inner)
    boxes.push({ title, tone: 'info', rows })
  }
  return boxes
}

function agentsBox({ agents, now, columns }: Snapshot): Box {
  const inner = columns - 4
  const wide = inner >= WIDE
  const active = agents.filter(a => a.status === 'running' && isCrew(a))
    .sort((a, b) => (a.startedAt ?? a.seenAt ?? Infinity) - (b.startedAt ?? b.seenAt ?? Infinity) || a.id.localeCompare(b.id))
  const title = [seg(`Agents · running ${active.length}`, 'success', true)]
  if (!active.length) return { title, tone: 'success', rows: [[seg('no agent running', 'secondary')]] }
  const rows: Row[] = []
  // The dot beats once a second: it turns hollow on odd seconds, so a stalled clock shows as a still dot.
  const lit = Number.isFinite(now) && Math.floor(now / 1000) % 2 === 0
  for (const agent of active) {
    const step = agent.planStep !== undefined && STEP_ID.test(agent.planStep) ? agent.planStep : ''
    const stamp = agent.startedAt !== undefined ? duration(agent.startedAt, now) : `seen ${duration(agent.seenAt, now)}`
    const dot = seg(lit ? '● ' : '○ ', 'success')
    const usage = onHelper(agent) ? 'on helper' : tokensText(agent)
    if (wide) {
      const left = [dot, ...pad(roleRow(agent.type), 15), ...pad([seg(step, 'warning')], 5), ...pad(modelCells(agent), 20),
        seg(` ${stamp.padStart(7)}`), seg('  '), ...pad(contextCells(agent), 19), seg(stepsText(agent), 'secondary')]
      rows.push(spread(left, usage ? [seg(usage, 'secondary')] : [], inner))
    } else {
      const left = [dot, ...roleRow(agent.type), ...(step ? [seg(`  ${step}`, 'warning')] : []), seg('  '), ...modelCells(agent)]
      rows.push(spread(left, [seg(stamp)], inner))
      rows.push(spread([seg('  '), ...contextCells(agent), seg('  '), seg(stepsText(agent), 'secondary')], usage ? [seg(usage, 'secondary')] : [], inner))
    }
    rows.push(cutRow(toolRow(agent), inner))
  }
  return { title, tone: 'success', rows }
}

function recentBox({ agents, now, columns }: Snapshot): Box | undefined {
  const inner = columns - 4
  const wide = inner >= WIDE
  const ended = agents.filter(a => a.status === 'ended' && isCrew(a))
    .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0) || a.id.localeCompare(b.id)).slice(0, 5)
  if (!ended.length) return undefined
  const rows = ended.map((agent): Row => {
    const failed = agent.stop === 'max_tokens'
    const step = agent.planStep !== undefined && STEP_ID.test(agent.planStep) ? agent.planStep : ''
    const took = agent.startedAt !== undefined && agent.endedAt !== undefined ? duration(agent.startedAt, agent.endedAt) : ''
    const glyph = seg(failed ? '✗ ' : '● ', failed ? 'error' : 'secondary')
    const usage = tokensText(agent)
    const when = ago(agent.endedAt, now)
    if (!wide) {
      const right = [seg([took, failed ? '' : usage].filter(Boolean).join(' · '), 'secondary')]
      if (failed) right.push(seg(`${took ? ' · ' : ''}max_tokens`, 'error'))
      return spread([glyph, ...roleRow(agent.type), ...(step ? [seg(`  ${step}`, 'warning')] : [])], right, inner)
    }
    const left = [glyph, ...pad(roleRow(agent.type), 15), ...pad([seg(step, 'warning')], 5), ...pad(modelCells(agent), 20),
      seg(` ${took.padStart(7)}`), seg('  '), seg(stepsText(agent), 'secondary')]
    const right: Row = []
    if (failed) right.push(seg('max_tokens', 'error'))
    else if (usage) right.push(seg(usage, 'secondary'))
    if (when) right.push(seg(`   ${when}`, 'secondary'))
    return spread(left, right, inner)
  })
  return { title: [seg(`Recent · ${ended.length}`, 'secondary', true)], tone: 'frame', rows }
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
  const labelWidth = inner >= 60 ? 16 : 12
  const span = Math.max(8, inner - labelWidth)
  const at = (time: number) => Math.min(span, Math.max(0, Math.round(((time - start) / WINDOW_MS) * span)))
  const rows = inWindow.map((agent): Row => {
    const from = at(agent.startedAt ?? agent.seenAt ?? start)
    const running = agent.status === 'running'
    const to = running ? span : Math.max(from + 1, at(agent.endedAt ?? now))
    const style: Style = running ? 'success' : agent.stop === 'max_tokens' ? 'error' : 'secondary'
    const name = roleName(agent.type).base
    const label = `${name}${agent.planStep !== undefined && STEP_ID.test(agent.planStep) ? ` ${agent.planStep}` : ''}`
    return [seg(label.slice(0, labelWidth - 1).padEnd(labelWidth), ROLE_STYLE[name] ?? 'plain'), seg('█'.repeat(Math.min(from, span)), 'track'),
      seg('█'.repeat(Math.max(0, Math.min(to, span) - from)), style), seg('█'.repeat(Math.max(0, span - to)), 'track')]
  })
  // The axis marks sit at a third and two thirds of the bar; `now` ends at its right edge.
  const axis = Array.from({ length: span }, () => ' ')
  const mark = (text: string, from: number) => { for (let i = 0; i < text.length && from + i < span; i++) axis[from + i] = text[i]! }
  mark('−15m', 0)
  mark('−10m', Math.round(span / 3))
  mark('−5m', Math.round((2 * span) / 3))
  mark('now', span - 3)
  rows.push([seg(' '.repeat(labelWidth)), seg(axis.join(''), 'secondary')])
  rows.push(cutRow([seg(' '.repeat(labelWidth)), seg('█', 'success'), seg(' running   ', 'secondary'), seg('█', 'secondary'),
    seg(' ended   ', 'secondary'), seg('█', 'error'), seg(' max_tokens', 'secondary')], inner))
  return { title: [seg('Last 15 minutes', 'accent', true)], tone: 'accent', rows }
}

/** The pane's parts from one snapshot, top to bottom; the screen draws the boxes, scrolling is the host's. */
export function paneView(given: Snapshot): Pane {
  const snapshot = { ...given, columns: widthOf(given.columns) }
  const crew = snapshot.agents.filter(isCrew)
  const running = crew.filter(a => a.status === 'running').length
  const recent = crew.length - running
  const named = snapshot.plans.filter((plan): plan is PlanProjection => !('state' in plan))
  const head: Row = [seg('Crew', 'title')]
  if (named.length === 1) head.push(seg(`  ${label(named[0]!.name)}`, 'secondary'))
  const pills: Row = []
  if (running) pills.push(seg(` ● ${running} running `, 'pill-running'))
  if (running && recent) pills.push(seg(' '))
  if (recent) pills.push(seg(` ${recent} recent `, 'pill-recent'))
  const empty = snapshot.plans.length === 0 && crew.length === 0
  const boxes = empty ? [] : [...planBoxes(snapshot), agentsBox(snapshot), recentBox(snapshot), timelineBox(snapshot)]
    .filter((box): box is Box => box !== undefined)
  const foot = spread([seg(plural(crew.length, 'agent'), 'secondary')], [seg('↑↓ scroll · esc close', 'secondary')], snapshot.columns)
  return { head: spread(head, pills, snapshot.columns), boxes, foot, empty }
}

/**
 * The pane's rows as plain text rows: head, then each box's title and rows, then the foot. `maxRows` is a viewport;
 * what does not fit is replaced by one line that says how many rows were left out.
 */
export function paneRows(snapshot: Snapshot, maxRows = Infinity): Rows {
  const view = paneView(snapshot)
  const all = [view.head, ...view.boxes.flatMap(box => [box.title, ...box.rows]), view.foot]
  const rows = view.empty ? [] : all
  if (!(maxRows >= 2) || rows.length <= maxRows) return { rows }
  const kept = rows.slice(0, Math.floor(maxRows) - 1)
  return { rows: [...kept, [seg(fit(`  … ${rows.length - kept.length} more rows`, snapshot.columns), 'secondary')]] }
}
