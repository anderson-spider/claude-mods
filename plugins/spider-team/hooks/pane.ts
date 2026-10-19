// The /spider-agents pane as cards: a header with the run and how many agents run, then a card for the session (Main's
// model, context and cost), the plan as a tree, the agents running, finished and planned, and the last 15 minutes by
// role, and a footer. Each card has a tone (a theme colour), a title with a count, an aside and its lines; the
// renderers draw the borders and the rails between cards. Figures the host never reported are left out. Pure.
import type { SpiderAgent, SpiderMain, SpiderRun, SpiderTask, SpiderTier } from '../types'
import type { SpiderConfig } from './config'
import type { Lang, Strings } from './i18n'
import { counted, fill, t } from './i18n'
import { formatCost, formatDuration, formatTokens, totalsOf } from './metrics'
import { agentsOfRun } from './agents'
import { effectiveState, isPlanned } from './state'
import { TIERS } from './tiers'
import { SPINNER, cells, cut, fit, modelName, p, pad, toned } from './text'
import type { Piece, Style, Tone } from './text'

export type PaneView = {
  run: SpiderRun | null; agents: SpiderAgent[]; main: SpiderMain; config: SpiderConfig; columns: number; lang: Lang; now: number; frame: number
  /** The rows the pane has; when the cards need more, the timeline goes first, then the finished and the planned agents. */
  rows?: number
}

export type CardKey = 'session' | 'plan' | 'running' | 'finished' | 'planned' | 'timeline'
export type Card = { key: CardKey; tone: Tone; title: string; count?: string; aside: Piece[]; lines: Piece[][] }
/** `motion`: agents run and animations are on, so the rail into the running card moves with `frame`. */
export type PaneModel = { header: Piece[]; cards: Card[]; footer: Piece[]; motion: boolean; frame: number }

/** Cells a card's border and padding take from the pane's width. */
export const FRAME = 4
/** Finished agents a card lists before it counts the rest. */
const LISTED = 6
export const TIMELINE_MS = 15 * 60_000
const BUCKETS = 15
const LANE_LABEL = 12
const NAME_MAX = 12
const MODEL_COLUMN = 12
const ATTEMPTS_SHOWN = 4
const TITLE_MIN = 8
/** Below this inner width a card keeps one figure per label and drops the session's total. */
const WIDE = 70

const CARD_TONE: Record<CardKey, Tone> = { session: 'claude', plan: 'suggestion', running: 'success', finished: 'inactive', planned: 'warning', timeline: 'merged' }
const ROLE_TONE: Record<SpiderTier | 'main', Tone> = { main: 'claude', planner: 'merged', worker: 'suggestion', researcher: 'warning', reviewer: 'planMode' }
const ROLES: (SpiderTier | 'main')[] = ['main', 'planner', 'worker', 'researcher', 'reviewer']

const nameOf = (a: SpiderAgent) => a.tier ?? (a.type?.replace(/^.*:/, '') || 'agent')
const toneOf = (role: string): Tone => ROLE_TONE[role as SpiderTier] ?? 'inactive'
const sent = (u: SpiderAgent['usage']) => u.input + u.cacheRead + u.cacheWrite
const width = (line: Piece[]) => line.reduce((n, piece) => n + cells(piece.text), 0)
const joined = (parts: Piece[][], sep: Piece): Piece[] => parts.flatMap((part, i) => (i ? [sep, ...part] : part))
const percent = (c: { contextTokens?: number; contextWindow?: number }) => (c.contextTokens !== undefined && c.contextWindow ? Math.round((c.contextTokens / c.contextWindow) * 100) : undefined)

/** `left`, then `right` pushed to the end of `inner` cells when both fit; else `left` alone. */
function spread(left: Piece[], right: Piece[], inner: number): Piece[] {
  const gap = inner - width(left) - width(right)
  return gap > 0 ? [...left, p(' '.repeat(gap)), ...right] : left
}

/** A gauge `cells` wide lit to `pct` in `tone`, the rest empty: blocks the SVG draws as cells. */
export function gauge(pct: number, cellsWide: number, tone: Tone): Piece[] {
  const on = Math.round((Math.max(0, Math.min(100, pct)) / 100) * cellsWide)
  return [{ text: '▰'.repeat(on), style: 'bar' as Style, tone }, p('▱'.repeat(cellsWide - on), 'barEmpty')].filter(piece => piece.text)
}

function effortOf(a: SpiderAgent): string | undefined {
  if (a.plannedEffort && a.effort && a.plannedEffort !== a.effort) return `${a.plannedEffort} → ${a.effort}`
  return a.effort ?? a.plannedEffort
}

function ago(ms: number, s: Strings): string {
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return s.pane.justNow
  return minutes < 60 ? fill(s.pane.minutesAgo, minutes) : fill(s.pane.hoursAgo, Math.floor(minutes / 60))
}

/** The session card: Main's model and whether it works, its context and tokens, then the costs and the run's time. */
function sessionLines(v: PaneView, s: Strings, inner: number): Piece[][] {
  const { main, config } = v
  const head = [toned(modelName(main.model) ?? s.na, 'claude', true), ...(main.effort ? [p(` · ${main.effort}`, 'dim')] : [])]
  const state = main.busySince !== undefined ? p(`● ${s.pane.working}`, 'ok') : p(`○ ${s.pane.idle}`, 'dim')
  const lines = [spread(head, [state], inner)]
  const tokens = config.showTokens && main.usage.output + sent(main.usage) > 0 ? [p(`${formatTokens(sent(main.usage))}↑ ${formatTokens(main.usage.output)}↓`, 'dim')] : []
  const pct = percent(main)
  if (config.showContext && main.contextTokens !== undefined) {
    const room = Math.max(6, Math.min(40, inner - 14 - width(tokens)))
    const context = pct === undefined ? [p('ctx ', 'dim'), p(formatTokens(main.contextTokens), 'title')] : [p('ctx ', 'dim'), ...gauge(pct, room, 'claude'), p(` ${pct}%`, 'title')]
    lines.push([...context, ...(tokens.length ? [p('   '), ...tokens] : [])])
  } else if (tokens.length) lines.push(tokens)
  const all = totalsOf(main, v.agents)
  const wide = inner >= WIDE
  const figures: Piece[][] = []
  if (config.showCost) {
    figures.push([p(`${s.pane.cost} `, 'dim'), p(formatCost(all.main, s.na), 'title')])
    figures.push([p(`${wide ? s.pane.subagents : s.pane.sub} `, 'dim'), p(formatCost(all.agents, s.na), 'title')])
    if (wide) figures.push([p(`${s.pane.session} `, 'dim'), p(formatCost(all.session, s.na), 'title')])
  }
  if (v.run) figures.push([p(`${s.pane.time} `, 'dim'), p(formatDuration((v.run.finishedAt ?? v.now) - v.run.startedAt), 'title')])
  if (figures.length) lines.push(joined(figures, p('   ')))
  return lines
}

const TASK_MARK: Record<SpiderTask['state'] | 'blocked', Piece> = {
  completed: p('✓', 'ok'), running: p('◎', 'warn'), reviewing: p('◎', 'warn'), pending: p('○', 'dim'), blocked: p('○', 'dim'), failed: p('✗', 'error'), cancelled: p('–', 'dim'),
}
const TASK_STYLE: Partial<Record<SpiderTask['state'] | 'blocked', Style>> = { completed: 'ok', running: 'warn', reviewing: 'warn', blocked: 'warn', failed: 'error' }

/** The plan's progress: accepted of the planned tasks, a gauge, and the failed ones when any. */
function planProgress(run: SpiderRun): { count: string; aside: Piece[] } {
  const states = run.tasks.filter(isPlanned).map(task => effectiveState(run, task))
  const accepted = states.filter(state => state === 'completed').length
  const failed = states.filter(state => state === 'failed').length
  const pct = states.length ? Math.round((accepted / states.length) * 100) : 0
  return { count: `${accepted}/${states.length}`, aside: [...(failed ? [p(`✗ ${failed}  `, 'error')] : []), ...gauge(pct, 6, 'success'), p(` ${pct}%`, 'dim')] }
}

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
    if (detail) lines.push([p(`${under}${kids.length ? '│ ' : '  '} `, 'dim'), p(detail, task.state === 'completed' ? 'dim' : 'error')])
    kids.forEach((kid, i) => walk(kid, under, i === kids.length - 1 ? '└─ ' : '├─ ', i === kids.length - 1))
  }
  for (const root of children(undefined)) walk(root, '', '', true)
  for (const task of tasks) walk(task, '', '', true)
  return lines
}

/** One block per attempt at the agent's task up to this agent: done green, failed red, running in the role's tone. */
function attempts(a: SpiderAgent, v: PaneView): Piece[] {
  const task = v.run?.tasks.find(task => task.id === a.taskId && task.agentIds.includes(a.agentId))
  const chain = task ? task.agentIds.slice(0, task.agentIds.indexOf(a.agentId) + 1) : [a.agentId]
  const block = (agent: SpiderAgent | undefined): Piece =>
    agent?.status === 'running' ? { text: '▮', style: 'bar', tone: toneOf(nameOf(agent)) }
      : agent?.status === 'done' ? { text: '▮', style: 'bar', tone: 'success' }
        : agent?.status === 'failed' ? { text: '▮', style: 'bar', tone: 'error' } : p('▮', 'barEmpty')
  return chain.slice(-ATTEMPTS_SHOWN).map(id => block(id === a.agentId ? a : v.agents.find(agent => agent.agentId === id)))
}

/** The mark before an agent: a spinner while it runs (a dot without animations) in its role's tone, then how it ended. */
function markOf(a: SpiderAgent, v: PaneView): Piece {
  if (a.status === 'running') return toned(v.config.animations ? SPINNER[v.frame % SPINNER.length]! : '●', toneOf(nameOf(a)))
  return a.status === 'done' ? p('●', 'ok') : a.status === 'failed' ? p('●', 'error') : p('–', 'dim')
}

/** An agent's row: mark, name in its role's tone, model, attempt blocks and time, then what it is on or how it ended. */
function agentRow(a: SpiderAgent, v: PaneView, s: Strings, inner: number): Piece[] {
  const end = a.endedAt ?? v.now
  const blocks = attempts(a, v)
  const task = v.run?.tasks.find(task => task.id === a.taskId)
  const head = [
    markOf(a, v), p(' '), toned(pad(cut(nameOf(a), NAME_MAX), NAME_MAX + 1), toneOf(nameOf(a)), true), p(pad(modelName(a.model) ?? '', MODEL_COLUMN), 'dim'),
    ...blocks, p(' '.repeat(ATTEMPTS_SHOWN + 1 - blocks.length)), p(pad(formatDuration(end - a.startedAt), 7), 'dim'),
  ]
  const what = a.status === 'running'
    ? [p([a.taskId, a.steps?.note ?? task?.title].filter(Boolean).join(' '))]
    : [...(a.endReason ? [p(a.endReason, 'error'), p(' · ', 'dim')] : []), p(ago(v.now - end, s), 'dim')]
  return fit([...head, ...what], inner)
}

/** What a running agent is on: its effort and steps, its latest tools, its calls and failed calls, then its figures. */
function activityLine(a: SpiderAgent, v: PaneView, s: Strings, inner: number): Piece[] | null {
  const tools = a.activity?.tools ?? []
  const parts: Piece[][] = [
    ...(effortOf(a) ? [[p(effortOf(a)!, 'dim')]] : []),
    ...(a.steps ? [[p(`${a.steps.done}/${a.steps.total} ${s.pane.steps}`, 'dim')]] : []),
    ...tools.map((tool, i) => [p(tool, i === tools.length - 1 ? 'plain' : 'dim')]),
  ]
  const calls = a.activity ? [p(`  ${counted(a.activity.calls, s.pane.callsOne, s.pane.calls)}`, 'dim'), ...(a.activity.errors ? [p(`  ✗ ${a.activity.errors}`, 'error')] : [])] : []
  const figures: Piece[][] = []
  if (v.config.showContext && a.contextTokens !== undefined) figures.push([p('ctx ', 'dim'), p(percent(a) !== undefined ? `${percent(a)}%` : formatTokens(a.contextTokens))])
  if (v.config.showTokens && a.requests) figures.push([p(`${formatTokens(sent(a.usage))}↑ ${formatTokens(a.usage.output)}↓`, 'dim')])
  if (v.config.showCost && a.costUsd !== undefined) figures.push([p(formatCost({ usage: a.usage, costUsd: a.costUsd, costPartial: !!a.costPartial }))])
  if (!parts.length && !figures.length) return null
  const line = [p('  └ ', 'dim'), ...joined(parts, p(' · ', 'dim')), ...calls, ...(figures.length ? [p('  '), ...joined(figures, p('  '))] : [])]
  return fit(line, inner)
}

/** A task a role will run that no agent has taken yet: its role, the role's model, an empty block and the task. */
function plannedRow(task: SpiderTask, inner: number): Piece[] {
  const role = task.owner as SpiderTier
  return fit([
    p('●', 'barEmpty'), p(' '), toned(pad(role, NAME_MAX + 1), toneOf(role), true), p(pad(modelName(TIERS[role].model) ?? '', MODEL_COLUMN), 'dim'),
    p('▯', 'barEmpty'), p(' '.repeat(ATTEMPTS_SHOWN)), p(pad('—', 7), 'dim'), p(`${task.id} ${task.title}`, 'dim'),
  ], inner)
}

function listed(agents: SpiderAgent[], s: Strings, row: (a: SpiderAgent) => Piece[]): Piece[][] {
  const extra = agents.length - LISTED
  return [...agents.slice(0, LISTED).map(row), ...(extra > 0 ? [[p(`  ${fill(s.pane.more, extra)}`, 'dim')]] : [])]
}

/** A lane per role across the last 15 minutes in one-minute buckets, lit where the role worked: Main, then the roles. */
function timelineLines(v: PaneView, s: Strings, inner: number): Piece[][] {
  const from = v.now - TIMELINE_MS
  const cw = Math.floor((inner - LANE_LABEL) / BUCKETS)
  if (cw < 1) return []
  const spans = new Map<string, [number, number][]>()
  const add = (lane: string, span: [number, number]) => { if (span[1] >= from) spans.set(lane, [...(spans.get(lane) ?? []), span]) }
  for (const turn of v.main.turns ?? []) add('main', turn)
  if (v.main.busySince !== undefined) add('main', [v.main.busySince, v.now])
  for (const a of v.agents) add(nameOf(a), [a.startedAt, a.endedAt ?? v.now])
  if (!spans.size) return []
  const lanes = [...ROLES.filter(role => spans.has(role)), ...[...spans.keys()].filter(lane => !ROLES.includes(lane as SpiderTier)).sort()]
  const rows = lanes.map(lane => {
    const lit = Array.from({ length: BUCKETS }, (_, i) => {
      const [start, end] = [from + i * 60_000, from + (i + 1) * 60_000]
      return spans.get(lane)!.some(([a, b]) => a < end && b > start)
    })
    const runs: Piece[] = []
    for (const on of lit) {
      const piece: Piece = on ? { text: '━'.repeat(cw), style: 'bar', tone: toneOf(lane) } : p('·'.repeat(cw), 'barEmpty')
      const last = runs.at(-1)
      if (last && last.style === piece.style) last.text += piece.text
      else runs.push(piece)
    }
    return [toned(pad(cut(lane, LANE_LABEL - 1), LANE_LABEL), toneOf(lane)), ...runs]
  })
  const span = cw * BUCKETS
  return [...rows, [p(' '.repeat(LANE_LABEL)), p(`−15m${' '.repeat(Math.max(1, span - 4 - cells(s.pane.now)))}${s.pane.now}`, 'dim')]]
}

/** The header: a badge, the pane's name, the run's title and phase, and on the right how many agents run. */
function headerOf(v: PaneView, s: Strings, running: number): Piece[] {
  const right = running ? [p(`● ${running} ${s.counts.running}`, 'ok')] : []
  const badge = [p(' SPIDER ', 'badge'), p('  '), p(s.pane.heading, 'title')]
  const phase = v.run ? ` · ${s.phase[v.run.phase]}` : ''
  const room = v.columns - width(badge) - width(right) - cells(phase) - 4
  const run = v.run ? [p(` · ${cut(v.run.title, Math.max(TITLE_MIN, room))}`, 'dim'), p(phase, 'dim')] : [p(` · ${s.pane.noRun}`, 'dim')]
  return fit(spread([...badge, ...run], right, v.columns), v.columns)
}

/** Rows a model takes as the terminal draws it: header, blank, each card and the rail before it, blank, footer. */
export const rowsOf = (cards: Card[]): number => 4 + cards.reduce((n, card, i) => n + card.lines.length + 2 + (i ? 1 : 0), 0)

/** The pane's header, cards and footer, each line fit to the width it is drawn at. */
export function paneModel(v: PaneView): PaneModel {
  const s = t(v.lang)
  const inner = Math.max(1, v.columns - FRAME)
  const running = v.agents.filter(a => a.status === 'running')
  const finished = [...v.agents.filter(a => a.status !== 'running')].sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))
  const planned = v.run ? v.run.tasks.filter(task => task.owner !== 'main' && !task.agentIds.length && ['pending', 'blocked'].includes(effectiveState(v.run!, task))) : []
  const card = (key: CardKey, title: string, lines: Piece[][], count?: string, aside: Piece[] = []): Card =>
    ({ key, tone: CARD_TONE[key], title, ...(count !== undefined ? { count } : {}), aside, lines: lines.map(line => fit(line, inner)) })
  const cards: Card[] = [card('session', s.pane.session, sessionLines(v, s, inner))]
  if (v.run) {
    const progress = planProgress(v.run)
    cards.push(card('plan', s.pane.plan, planLines(v.run, v, s, inner), progress.count, progress.aside))
  }
  if (running.length || !v.agents.length) {
    const lines = running.length ? running.flatMap(a => [agentRow(a, v, s, inner), ...[activityLine(a, v, s, inner)].filter(line => line !== null)]) : [[p(s.pane.noAgents, 'dim')]]
    cards.push(card('running', s.pane.agentsRunning, lines, String(running.length)))
  }
  if (finished.length) cards.push(card('finished', s.pane.agentsFinished, listed(finished, s, a => agentRow(a, v, s, inner)), String(finished.length)))
  if (planned.length) cards.push(card('planned', s.pane.agentsPlanned, planned.map(task => plannedRow(task, inner)), String(planned.length)))
  const timeline = timelineLines(v, s, inner)
  if (timeline.length) cards.push(card('timeline', s.pane.timeline, timeline))
  // Short of rows, the least current cards go first.
  for (const key of ['timeline', 'finished', 'planned'] as const) {
    if (v.rows === undefined || rowsOf(cards) <= v.rows) break
    const at = cards.findIndex(c => c.key === key)
    if (at >= 0) cards.splice(at, 1)
  }
  const count = v.agents.length
  return {
    // A run's header counts its own agents; the session's others still show in the cards.
    header: headerOf(v, s, (v.run ? agentsOfRun(v.run, running) : running).length),
    cards, footer: [p(`${count} ${count === 1 ? s.agent : s.agents}`, 'dim')],
    motion: running.length > 0 && v.config.animations, frame: v.frame,
  }
}

/** The model as plain lines, a card's title, count and aside on one line: what a test or a plain-text surface reads. */
export function paneLines(v: PaneView): Piece[][] {
  const model = paneModel(v)
  const title = (c: Card) => [p(c.title, 'title'), ...(c.count !== undefined ? [p(` ${c.count}`, 'dim')] : []), ...(c.aside.length ? [p('  '), ...c.aside] : [])]
  return [model.header, ...model.cards.flatMap(c => [title(c), ...c.lines]), model.footer]
}
