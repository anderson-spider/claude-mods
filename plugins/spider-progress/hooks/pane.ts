// The /spider-agents pane, laid out like a crew HUD: a header with the run and its counts, then bordered sections (the
// plan as a tree, the running agents with their activity, the recent ones, the session's other agents, a timeline of
// the last 15 minutes and the usage totals) and a footer. Figures the host never reported are left out. Pure: the
// renderer draws each section in a box of its border colour.
import type { SpiderAgent, SpiderMain, SpiderRun, SpiderTask } from '../types'
import { agentsOfRun } from './agents'
import type { SpiderConfig } from './config'
import type { Lang, Strings } from './i18n'
import { counted, fill, t } from './i18n'
import { formatCost, formatDuration, formatTokens, totalsOf } from './metrics'
import { effectiveState, isPlanned } from './state'
import { SPINNER, bar, cells, cut, fit, modelName, p, pad } from './text'
import type { Piece, Style } from './text'

export type PaneView = { run: SpiderRun | null; agents: SpiderAgent[]; main: SpiderMain; config: SpiderConfig; compact: boolean; columns: number; lang: Lang; now: number; frame: number }

/** Theme keys the renderer gives a section's border and title. */
export type Border = 'suggestion' | 'success' | 'subtle' | 'merged' | 'inactive'
export type Section = { key: 'plan' | 'running' | 'recent' | 'others' | 'timeline' | 'totals'; border: Border; title: string; aside: Piece[]; lines: Piece[][] }
export type PaneModel = { header: Piece[]; sections: Section[]; footer: Piece[] }

/** Cells a section's border and padding take from the pane's width. */
export const FRAME = 4
/** The inner width from which an agent's figures fit on its first line. */
const WIDE = 96
/** Finished agents a section lists before it counts the rest. */
const LISTED = 6
/** Agents the timeline draws, the latest started. */
const TIMELINE_ROWS = 8
const TIMELINE_MS = 15 * 60_000
const CONTEXT_BAR = 6
const NAME_MAX = 20
const MODEL_MAX = 30
const TITLE_MIN = 8
const TOTALS_LABEL = 12
const TOTALS_NUMBER = 10

const nameOf = (a: SpiderAgent) => a.tier ?? (a.type?.replace(/^.*:/, '') || 'agent')
const tokensOf = (a: { usage: SpiderAgent['usage'] }) => a.usage.input + a.usage.output + a.usage.cacheRead + a.usage.cacheWrite
const sent = (a: SpiderAgent) => a.usage.input + a.usage.cacheRead + a.usage.cacheWrite
const width = (line: Piece[]) => line.reduce((n, piece) => n + cells(piece.text), 0)
const joined = (parts: Piece[][], sep: Piece): Piece[] => parts.flatMap((part, i) => (i ? [sep, ...part] : part))

function effortOf(a: SpiderAgent): string | undefined {
  if (a.plannedEffort && a.effort && a.plannedEffort !== a.effort) return `${a.plannedEffort} → ${a.effort}`
  return a.effort ?? a.plannedEffort
}

const modelOf = (a: SpiderAgent) => [modelName(a.model), effortOf(a)].filter(Boolean).join(' · ')

function contextOf(c: { contextTokens?: number; contextWindow?: number }): string | undefined {
  if (c.contextTokens === undefined) return undefined
  return c.contextWindow ? `${Math.round((c.contextTokens / c.contextWindow) * 100)}%` : formatTokens(c.contextTokens)
}

function ago(ms: number, s: Strings): string {
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return s.pane.justNow
  return minutes < 60 ? fill(s.pane.minutesAgo, minutes) : fill(s.pane.hoursAgo, Math.floor(minutes / 60))
}

/** The mark before an agent: a spinner while it runs (a fixed dot without animations), then how it ended. */
function markOf(a: SpiderAgent, v: PaneView): Piece {
  if (a.status === 'running') return p(v.config.animations ? SPINNER[v.frame % SPINNER.length]! : '●', 'ok')
  return a.status === 'done' ? p('✓', 'ok') : a.status === 'failed' ? p('✗', 'error') : p('–', 'dim')
}

/** The figures the host reported for an agent, each left out when unknown or hidden by an option. */
function figures(a: SpiderAgent, v: PaneView, s: Strings): Piece[][] {
  const out: Piece[][] = []
  if (v.config.showContext && a.contextTokens !== undefined) {
    out.push(a.contextWindow
      ? [p('ctx ', 'dim'), ...bar(Math.round((a.contextTokens / a.contextWindow) * 100), CONTEXT_BAR, 0), p(` ${contextOf(a)}`)]
      : [p('ctx ', 'dim'), p(contextOf(a)!)])
  }
  if (a.steps) out.push([p(`${a.steps.done}/${a.steps.total} ${s.pane.steps}`, 'dim')])
  if (v.config.showTokens && a.requests) out.push([p(`↑${formatTokens(sent(a))} ↓${formatTokens(a.usage.output)}`, 'dim')])
  if (v.config.showCost && a.costUsd !== undefined) out.push([p(formatCost({ usage: a.usage, costUsd: a.costUsd, costPartial: !!a.costPartial }))])
  return out
}

/** An agent's identity: its mark, name, task and, on a wide pane, model and effort, in columns shared by its section. */
function identity(a: SpiderAgent, v: PaneView, cols: Columns, wide: boolean): Piece[] {
  return [
    markOf(a, v), p(' '), p(pad(cut(nameOf(a), NAME_MAX), cols.name + 2), 'title'), p(pad(a.taskId ?? '', 5), 'warn'),
    ...(wide ? [p(pad(modelOf(a), cols.model + 2), 'dim')] : []),
  ]
}

/** What a running agent is on: its last note, its latest tools (the newest bright), its call count and failed calls. */
function activityLine(a: SpiderAgent, s: Strings): Piece[] | null {
  const tools = a.activity?.tools ?? []
  const parts: Piece[][] = [
    ...(a.steps?.note ? [[p(a.steps.note)]] : []),
    ...tools.map((tool, i) => [p(tool, i === tools.length - 1 ? 'plain' : 'dim')]),
  ]
  if (!parts.length) return null
  const calls = a.activity ? [p(`  ${counted(a.activity.calls, s.pane.callsOne, s.pane.calls)}`, 'dim'), ...(a.activity.errors ? [p(`  ✗ ${a.activity.errors}`, 'error')] : [])] : []
  return [p('   └ ', 'dim'), ...joined(parts, p(' · ', 'dim')), ...calls]
}

/** A running agent: identity and time, its figures on the same line when wide or on the next, then its activity. */
function runningRows(a: SpiderAgent, v: PaneView, s: Strings, inner: number, cols: Columns): Piece[][] {
  const wide = inner >= WIDE
  const time = p(pad(formatDuration(v.now - a.startedAt), 7))
  const figs = joined(figures(a, v, s), p('  '))
  if (v.compact) return [[...identity(a, v, cols, false), time]]
  const head = wide ? [...identity(a, v, cols, true), time, ...figs] : [...identity(a, v, cols, false), p(modelOf(a), 'dim')]
  const rows = [head]
  if (!wide) {
    const right = formatDuration(v.now - a.startedAt)
    const gap = inner - width(head) - cells(right)
    if (gap > 0) head.push(p(' '.repeat(gap)), p(right))
    if (figs.length) rows.push([p('   '), ...figs])
  }
  const activity = activityLine(a, s)
  return activity ? [...rows, activity] : rows
}

/** A finished agent on one line: identity, duration, figures when wide, then when it ended and why it failed. */
function finishedRow(a: SpiderAgent, v: PaneView, s: Strings, inner: number, cols: Columns): Piece[] {
  if (a.status === 'running') return runningRows(a, v, s, inner, cols)[0]!
  const wide = inner >= WIDE && !v.compact
  const ended = a.endedAt ?? v.now
  const tail = [...(a.endReason ? [p(a.endReason, 'error'), p('  ')] : []), p(ago(v.now - ended, s), 'dim')]
  const figs = wide ? figures(a, v, s) : []
  return [...identity(a, v, cols, wide), p(pad(formatDuration(ended - a.startedAt), 7)), ...(figs.length ? [...joined(figs, p('  ')), p('  ')] : []), ...tail]
}

/** The name and model columns, as wide as the longest of the agents drawn. */
type Columns = { name: number; model: number }
const columnsOf = (agents: SpiderAgent[]): Columns => ({
  name: Math.max(6, ...agents.map(a => Math.min(NAME_MAX, cells(nameOf(a))))),
  model: Math.max(10, ...agents.map(a => Math.min(MODEL_MAX, cells(modelOf(a))))),
})
const latestEnded = (agents: SpiderAgent[]) => [...agents].sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))

function listed(agents: SpiderAgent[], s: Strings, row: (a: SpiderAgent) => Piece[]): Piece[][] {
  const extra = agents.length - LISTED
  return [...agents.slice(0, LISTED).map(row), ...(extra > 0 ? [[p(`  ${fill(s.pane.more, extra)}`, 'dim')]] : [])]
}

/** The plan's counts: accepted, running or in review, left, and failed when any did. */
function planCounts(run: SpiderRun, s: Strings): Piece[] {
  const states = run.tasks.filter(isPlanned).map(task => effectiveState(run, task))
  const count = (...of: string[]) => states.filter(state => of.includes(state)).length
  const failed = count('failed')
  return [
    p(`${counted(count('completed'), s.counts.acceptedOne, s.counts.accepted)} / `, 'dim'), p(`${count('running', 'reviewing')} ${s.counts.running}`, 'warn'),
    p(` / ${counted(count('pending', 'blocked'), s.counts.leftOne, s.counts.left)}`, 'dim'), ...(failed ? [p(` / ${counted(failed, s.counts.failedOne, s.counts.failed)}`, 'error')] : []),
  ]
}

const TASK_MARK: Record<SpiderTask['state'] | 'blocked', Piece> = {
  completed: p('✓', 'ok'), running: p('◎', 'warn'), reviewing: p('◎', 'warn'), pending: p('○', 'dim'), blocked: p('○', 'dim'), failed: p('✗', 'error'), cancelled: p('–', 'dim'),
}
const TASK_STYLE: Partial<Record<SpiderTask['state'] | 'blocked', Style>> = { completed: 'ok', running: 'warn', reviewing: 'warn', blocked: 'warn', failed: 'error' }

/**
 * The plan as a tree: a task hangs under the last task it comes after. Each line: its mark, id and title, owner and
 * state, the agent on it with its steps, or the tasks it waits for; then its error or, once accepted, its evidence.
 */
function planLines(run: SpiderRun, v: PaneView, s: Strings, inner: number): Piece[][] {
  const tasks = run.tasks.filter(isPlanned)
  const ids = new Set(tasks.map(task => task.id))
  const parentOf = (task: SpiderTask) => [...task.after].reverse().find(id => ids.has(id) && id !== task.id)
  const children = (id: string | undefined) => tasks.filter(task => parentOf(task) === id)
  const lines: Piece[][] = []
  const seen = new Set<string>()
  const walk = (task: SpiderTask, lead: string, branch: string, last: boolean) => {
    if (seen.has(task.id)) return
    seen.add(task.id)
    const state = effectiveState(run, task)
    const agent = v.agents.find(a => a.agentId === task.agentIds.at(-1))
    const waits = state === 'blocked' ? task.after.filter(id => run.tasks.find(t => t.id === id)?.state !== 'completed') : []
    const steps = agent?.steps && state === 'running' ? ` (${agent.steps.done}/${agent.steps.total})` : ''
    const meta = [
      p(`  ${task.owner} · `, 'dim'), p(s.task[state], TASK_STYLE[state] ?? 'dim'), p(steps, 'dim'),
      ...(agent && state === 'running' ? [p(`  ← ${nameOf(agent)}`, 'dim')] : []),
      ...(waits.length ? [p(`  ${s.pane.waits} ${waits.join(', ')}`, 'dim')] : []),
    ].filter(piece => piece.text)
    const head = [p(lead + branch, 'dim'), TASK_MARK[state], p(' ')]
    const room = Math.max(TITLE_MIN, inner - width(head) - width(meta))
    lines.push([...head, p(cut(`${task.id} ${task.title}`, room), state === 'completed' ? 'plain' : 'title'), ...meta])
    const under = lead + (branch ? (last ? '   ' : '│  ') : '')
    const detail = task.state === 'completed' ? task.evidence : task.errors.at(-1)
    const kids = children(task.id)
    if (detail && !v.compact) lines.push([p(`${under}${kids.length ? '│ ' : '  '} `, 'dim'), p(detail, task.state === 'completed' ? 'dim' : 'error')])
    kids.forEach((kid, i) => walk(kid, under, i === kids.length - 1 ? '└─ ' : '├─ ', i === kids.length - 1))
  }
  for (const root of children(undefined)) walk(root, '', '', true)
  for (const task of tasks) walk(task, '', '', true)
  return lines
}

/** A bar per agent across the last 15 minutes: running in the success colour, finished dim, failed in error. */
function timelineLines(agents: SpiderAgent[], v: PaneView, s: Strings, inner: number): Piece[][] {
  const from = v.now - TIMELINE_MS
  const shown = agents.filter(a => (a.endedAt ?? v.now) >= from).sort((a, b) => b.startedAt - a.startedAt).slice(0, TIMELINE_ROWS)
  if (!shown.length) return []
  const label = Math.min(16, Math.floor(inner / 3))
  const span = inner - label - 1
  if (span < 10) return []
  const at = (time: number) => Math.round(((Math.max(from, Math.min(v.now, time)) - from) / TIMELINE_MS) * span)
  const style = (a: SpiderAgent): Style => (a.status === 'running' ? 'ok' : a.status === 'failed' ? 'error' : 'dim')
  const rows = shown.map(a => {
    const start = Math.min(at(a.startedAt), span - 1)
    const end = Math.max(start + 1, at(a.endedAt ?? v.now))
    return [
      p(pad(`${nameOf(a)}${a.taskId ? ` ${a.taskId}` : ''}`, label + 1), style(a) === 'error' ? 'error' : 'plain'),
      ...[p('░'.repeat(start), 'barEmpty'), p('━'.repeat(end - start), style(a)), p('░'.repeat(span - end), 'barEmpty')].filter(piece => piece.text),
    ]
  })
  const axis = Array.from({ length: span }, () => ' ')
  const mark = (text: string, col: number) => [...text].forEach((ch, i) => { if (col + i < span) axis[col + i] = ch })
  mark('−15m', 0)
  mark('−10m', Math.round(span / 3) - 2)
  mark('−5m', Math.round((2 * span) / 3) - 2)
  mark(s.pane.now, span - cells(s.pane.now))
  const legend = [p('━', 'ok'), p(` ${s.counts.running}   `, 'dim'), p('━', 'dim'), p(` ${s.pane.finished}   `, 'dim'), p('━', 'error'), p(` ${s.status.failed}`, 'dim')]
  return [...rows, [p(' '.repeat(label + 1)), p(axis.join(''), 'dim')], [p(' '.repeat(label + 1)), ...legend]]
}

function totalsLines(v: PaneView, s: Strings): Piece[][] {
  const { config } = v
  const all = totalsOf(v.main, v.agents)
  const head = [
    p(' '.repeat(TOTALS_LABEL)), ...(config.showTokens ? [p(pad(s.pane.tokens, TOTALS_NUMBER), 'dim')] : []),
    ...(config.showCost ? [p(pad(s.pane.cost, TOTALS_NUMBER), 'dim')] : []), ...(config.showContext ? [p(s.pane.context, 'dim')] : []),
  ]
  const row = (label: string, total: typeof all.main, context?: string) => [
    p(pad(label, TOTALS_LABEL), 'title'),
    ...(config.showTokens ? [p(pad(formatTokens(tokensOf(total)), TOTALS_NUMBER))] : []),
    ...(config.showCost ? [p(pad(formatCost(total, s.na), TOTALS_NUMBER))] : []),
    ...(config.showContext && context ? [p(context)] : []),
  ]
  return [head, row(s.pane.main, all.main, contextOf(v.main)), row(s.pane.subagents, all.agents), row(s.pane.session, all.session)]
}

/** The header: the run's title and phase, and on the right how many agents run and how many finished. */
function headerOf(v: PaneView, s: Strings, agents: SpiderAgent[]): Piece[] {
  const running = agents.filter(a => a.status === 'running').length
  const right = [
    ...(running ? [p(`● ${running} ${s.counts.running}`, 'ok')] : []),
    ...(running && agents.length > running ? [p(' · ', 'dim')] : []),
    ...(agents.length > running ? [p(counted(agents.length - running, s.counts.recentOne, s.counts.recent), 'dim')] : []),
  ]
  const room = v.columns - width(right) - 2
  const left = v.run ? [p(cut(v.run.title, Math.max(TITLE_MIN, room - cells(s.phase[v.run.phase]) - 3)), 'title'), p(` · ${s.phase[v.run.phase]}`, 'dim')] : [p(s.pane.noRun, 'dim')]
  const gap = v.columns - width(left) - width(right)
  return fit(gap > 0 ? [...left, p(' '.repeat(gap)), ...right] : left, v.columns)
}

/** The pane's header, sections and footer, each line fit to the width it is drawn at. */
export function paneModel(v: PaneView): PaneModel {
  const s = t(v.lang)
  const inner = Math.max(1, v.columns - FRAME)
  const ours = v.run ? agentsOfRun(v.run, v.agents) : v.agents
  const others = v.run ? v.agents.filter(a => !ours.includes(a)) : []
  const cols = columnsOf(v.agents)
  const sections: Section[] = []
  if (v.run) sections.push({ key: 'plan', border: 'suggestion', title: s.pane.plan, aside: planCounts(v.run, s), lines: v.compact ? [] : planLines(v.run, v, s, inner) })
  const running = ours.filter(a => a.status === 'running')
  const finished = latestEnded(ours.filter(a => a.status !== 'running'))
  if (running.length || !ours.length) {
    sections.push({
      key: 'running', border: 'success', title: `${s.pane.running} · ${running.length}`, aside: [],
      lines: running.length ? running.flatMap(a => runningRows(a, v, s, inner, cols)) : [[p(s.pane.noAgents, 'dim')]],
    })
  }
  if (finished.length) sections.push({ key: 'recent', border: 'subtle', title: `${s.pane.recent} · ${finished.length}`, aside: [], lines: listed(finished, s, a => finishedRow(a, v, s, inner, cols)) })
  if (others.length) {
    const order = [...others.filter(a => a.status === 'running'), ...latestEnded(others.filter(a => a.status !== 'running'))]
    sections.push({ key: 'others', border: 'inactive', title: `${s.pane.others} · ${others.length}`, aside: [], lines: listed(order, s, a => finishedRow(a, v, s, inner, cols)) })
  }
  if (!v.compact) {
    const timeline = timelineLines([...ours, ...others], v, s, inner)
    if (timeline.length) sections.push({ key: 'timeline', border: 'merged', title: s.pane.timeline, aside: [], lines: timeline })
    if (v.config.showTokens || v.config.showCost || v.config.showContext) sections.push({ key: 'totals', border: 'subtle', title: s.pane.totals, aside: [], lines: totalsLines(v, s) })
  }
  const fitted = sections.map(section => ({ ...section, aside: fit(section.aside, Math.max(0, inner - cells(section.title) - 2)), lines: section.lines.map(line => fit(line, inner)) }))
  const count = v.agents.length
  return { header: headerOf(v, s, ours), sections: fitted, footer: [p(`${count} ${count === 1 ? s.agent : s.agents}`, 'dim')] }
}

/** The model as plain lines, a section's title and aside on one line: what a test or a plain-text surface reads. */
export function paneLines(v: PaneView): Piece[][] {
  const model = paneModel(v)
  return [model.header, ...model.sections.flatMap(section => [[p(section.title, 'title'), ...(section.aside.length ? [p('  '), ...section.aside] : [])], ...section.lines]), model.footer]
}
