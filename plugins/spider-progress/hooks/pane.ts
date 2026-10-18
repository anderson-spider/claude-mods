// The /spider-agents pane: the run's header and bar, a row per agent, the run's tasks and the usage totals of Main, the
// subagents and the session. Values the host never reported read N/A. Pure.
import type { SpiderAgent, SpiderMain, SpiderRun, SpiderTask } from '../types'
import { agentsOfRun } from './agents'
import type { SpiderConfig } from './config'
import type { Lang, Strings } from './i18n'
import { t } from './i18n'
import { formatCost, formatDuration, formatTokens, totalsOf } from './metrics'
import { effectiveState, isPlanned, progressOf } from './state'
import { SPINNER, bar, fit, modelName, p, pad } from './text'
import type { Piece, Style } from './text'

export type PaneView = { run: SpiderRun | null; agents: SpiderAgent[]; main: SpiderMain; config: SpiderConfig; compact: boolean; columns: number; lang: Lang; now: number; frame: number }

const ICONS: Record<string, string> = { fable: '✦', opus: '◆', sonnet: '◇', haiku: '△', Explore: '⌕' }
const STATUS_STYLE: Record<SpiderAgent['status'], Style> = { running: 'accent', done: 'ok', failed: 'error', cancelled: 'dim' }
const TASK_STYLE: Partial<Record<SpiderTask['state'] | 'blocked', Style>> = { completed: 'ok', blocked: 'warn', failed: 'error' }

const nameOf = (a: SpiderAgent) => (a.tier ? `spider-${a.tier}` : a.type?.replace(/^.*:/, '') || 'agent')
const iconOf = (a: SpiderAgent) => ICONS[a.tier ?? a.type ?? ''] ?? '○'
const tokensOf = (a: { usage: SpiderAgent['usage'] }) => a.usage.input + a.usage.output + a.usage.cacheRead + a.usage.cacheWrite

function effortOf(a: SpiderAgent, na: string): string {
  if (a.plannedEffort && a.effort && a.plannedEffort !== a.effort) return `${a.plannedEffort} → ${a.effort}`
  return a.effort ?? a.plannedEffort ?? na
}

function contextOf(c: { contextTokens?: number; contextWindow?: number }, na: string): string {
  if (c.contextTokens === undefined) return na
  return c.contextWindow ? `${Math.round((c.contextTokens / c.contextWindow) * 100)}%` : formatTokens(c.contextTokens)
}

type Column = { key: keyof Strings['column']; width: number; head: (s: Strings) => string; cell: (a: SpiderAgent, v: PaneView, s: Strings) => Piece; shown?: (c: SpiderConfig) => boolean }

const COLUMNS: Column[] = [
  { width: 15, key: 'agent', head: s => s.column.agent, cell: a => p(`${iconOf(a)} ${nameOf(a)}`, 'title') },
  { width: 10, key: 'model', head: s => s.column.model, cell: (a, _v, s) => p(modelName(a.model) ?? s.na) },
  { width: 15, key: 'effort', head: s => s.column.effort, cell: (a, _v, s) => p(effortOf(a, s.na)) },
  {
    width: 11, key: 'status', head: s => s.column.status,
    cell: (a, v, s) => p(`${a.status === 'running' ? `${v.config.animations ? SPINNER[v.frame % SPINNER.length] : '●'} ` : ''}${s.status[a.status]}`, STATUS_STYLE[a.status]),
  },
  { width: 9, key: 'steps', head: s => s.column.steps, cell: (a, _v, s) => p(a.steps ? `${a.steps.done}/${a.steps.total}${a.steps.total ? ` ${Math.round((a.steps.done / a.steps.total) * 100)}%` : ''}` : s.na) },
  { width: 7, key: 'tokens', head: s => s.column.tokens, cell: (a, _v, s) => p(a.requests ? formatTokens(tokensOf(a)) : s.na), shown: c => c.showTokens },
  { width: 8, key: 'context', head: s => s.column.context, cell: (a, _v, s) => p(contextOf(a, s.na)), shown: c => c.showContext },
  { width: 8, key: 'cost', head: s => s.column.cost, cell: a => p(formatCost({ usage: a.usage, ...(a.costUsd !== undefined ? { costUsd: a.costUsd } : {}), costPartial: !!a.costPartial })), shown: c => c.showCost },
  { width: 8, key: 'time', head: s => s.column.time, cell: (a, v) => p(formatDuration((a.endedAt ?? v.now) - a.startedAt)) },
]

const COMPACT: ReadonlySet<Column['key']> = new Set(['agent', 'status', 'steps', 'time'])

const padded = (piece: Piece, width: number): Piece => ({ ...piece, text: pad(piece.text, width) })

function header(v: PaneView, s: Strings): Piece[][] {
  if (!v.run) return [[p(s.pane.noRun, 'dim')]]
  const { accepted, total, percent } = progressOf(v.run)
  const tail = ` ${percent === undefined ? '' : `${percent}% · `}${accepted}/${total}`
  return [
    [p(v.run.title, 'title'), p(` · ${s.phase[v.run.phase]}`, 'dim')],
    [...bar(percent, Math.max(10, Math.min(40, v.columns - tail.length)), v.config.animations ? v.frame : 0), p(tail, 'title')],
  ]
}

/** A row per agent: the run's first, then the session's others under their label; without a run, every agent. */
function agentRows(v: PaneView, s: Strings, columns: Column[]): Piece[][] {
  if (!v.agents.length) return [[p(s.pane.noAgents, 'dim')]]
  const row = (a: SpiderAgent) => columns.map(c => padded(c.cell(a, v, s), c.width + 1))
  if (!v.run) return v.agents.map(row)
  const ours = agentsOfRun(v.run, v.agents)
  const others = v.agents.filter(a => !ours.includes(a))
  return [...ours.map(row), ...(others.length ? [[p(s.pane.others, 'dim')], ...others.map(row)] : [])]
}

/** Every planned task: its state (blocked in warning, failed in error), its worker's steps, then its last error or, once accepted, its evidence. */
function taskRows(v: PaneView, s: Strings): Piece[][] {
  const shown = (v.run?.tasks ?? []).filter(isPlanned)
  if (!shown.length) return []
  return [[p(s.pane.tasks, 'dim')], ...shown.map(task => {
    const state = effectiveState(v.run!, task)
    const agent = v.agents.find(a => a.agentId === task.agentIds.at(-1))
    const steps = agent?.steps && state === 'running' ? ` (${agent.steps.done}/${agent.steps.total})` : ''
    const detail = task.state === 'completed' ? task.evidence : task.errors.at(-1)
    return [
      p(`${task.id} ${task.title}`, 'title'), p(` · ${task.owner} · `, 'dim'), p(s.task[state], TASK_STYLE[state] ?? 'dim'), p(steps, 'dim'),
      ...(detail ? [p(` · ${detail}`, TASK_STYLE[state] ?? 'dim')] : []),
    ].filter(piece => piece.text)
  })]
}

function totals(v: PaneView, s: Strings): Piece[][] {
  const { config } = v
  if (!config.showTokens && !config.showCost && !config.showContext) return []
  const all = totalsOf(v.main, v.agents)
  const row = (label: string, total: typeof all.main, context?: string) => [
    p(pad(label, 12), 'title'),
    ...(config.showTokens ? [p(pad(formatTokens(tokensOf(total)), 10))] : []),
    ...(config.showCost ? [p(pad(formatCost(total), 10))] : []),
    ...(config.showContext && context ? [p(context)] : []),
  ]
  return [[p(s.pane.totals, 'dim')], row(s.pane.main, all.main, contextOf(v.main, s.na)), row(s.pane.subagents, all.agents), row(s.pane.session, all.session)]
}

/** The pane's lines, each cut to `columns`: expanded, a table and the totals; compact, one short line per agent. */
export function paneLines(v: PaneView): Piece[][] {
  const s = t(v.lang)
  const shown = COLUMNS.filter(c => !c.shown || c.shown(v.config))
  const columns = v.compact ? shown.filter(c => COMPACT.has(c.key)) : shown
  const table = [columns.map(c => p(pad(c.head(s), c.width + 1), 'dim')), ...agentRows(v, s, columns)]
  const blank: Piece[] = []
  const lines = v.compact ? [...header(v, s), blank, ...table] : [...header(v, s), blank, ...table, blank, ...taskRows(v, s), blank, ...totals(v, s)]
  return lines.map(line => fit(line, v.columns))
}
