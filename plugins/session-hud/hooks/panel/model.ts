// The session panel as cards: a header with how many agents run, then a card for the main session (model, effort,
// context and tokens, from the card the band draws), the agents running and finished, and the last 15 minutes by agent
// type, and a footer. Each card has a tone (a theme colour), a title with a count, an aside and its lines; the renderers
// draw the borders and the rails between cards. Only figures and names reach it: never a prompt, a task, a tool input,
// a path or money. Figures the host never reported are left out. Pure.
import type { SessionHudCard, SessionHudPanel, SessionHudPanelAgent } from '../../types'
import { contextOf, modelName, tokens, typeName } from '../view'
import { TIMELINE_MS, sent } from './agents'
import { SPINNER, cells, cut, duration, fit, p, pad, toned } from './text'
import type { Piece, Tone } from './text'

export type PaneView = {
  panel: SessionHudPanel; card: SessionHudCard; columns: number; now: number; frame: number
  /** The rows the pane has; when the cards need more, the timeline goes, then the finished agents. */
  rows?: number
}

export type CardKey = 'session' | 'running' | 'finished' | 'timeline'
export type Card = { key: CardKey; tone: Tone; title: string; count?: string; aside: Piece[]; lines: Piece[][] }
/** `motion`: agents run, so the rail into the running card moves with `frame`. */
export type PaneModel = { header: Piece[]; cards: Card[]; footer: Piece[]; motion: boolean; frame: number }

/** Cells a card's border and padding take from the pane's width. */
export const FRAME = 4
/** Finished agents a card lists before it counts the rest. */
const LISTED = 6
/** Lanes the timeline draws: the main session and the agent types that worked most recently. */
export const LANES = 6
const BUCKETS = 15
const LANE_LABEL = 14
const NAME_MAX = 20
const MODEL_COLUMN = 12

const CARD_TONE: Record<CardKey, Tone> = { session: 'claude', running: 'success', finished: 'inactive', timeline: 'merged' }
/** An agent type's tone, picked by its name so it keeps it across cards and redraws. */
const TYPE_TONES: readonly Tone[] = ['suggestion', 'warning', 'planMode', 'merged', 'inactive']
const MAIN = 'main'

/** A tool name, or `?`: only a name reaches the screen. */
const TOOL = /^[A-Za-z0-9][\w.:-]{0,47}$/
/** An ending reason, or `error`: only a word reaches the screen. */
const REASON = /^[a-z][a-z_]{0,31}$/

const nameOf = (a: SessionHudPanelAgent) => typeName(a.type) ?? 'agent'
function toneOf(lane: string): Tone {
  if (lane === MAIN) return 'claude'
  let hash = 0
  for (const ch of lane) hash = (hash * 31 + ch.codePointAt(0)!) >>> 0
  return TYPE_TONES[hash % TYPE_TONES.length]!
}
const width = (line: Piece[]) => line.reduce((n, piece) => n + cells(piece.text), 0)
const joined = (parts: Piece[][], sep: Piece): Piece[] => parts.flatMap((part, i) => (i ? [sep, ...part] : part))
const flow = (u: SessionHudPanelAgent['usage']) => p(`${tokens(sent(u))}↑ ${tokens(u.output)}↓`, 'dim')

/** `left`, then `right` pushed to the end of `inner` cells when both fit; else `left` alone. */
function spread(left: Piece[], right: Piece[], inner: number): Piece[] {
  const gap = inner - width(left) - width(right)
  return gap > 0 ? [...left, p(' '.repeat(gap)), ...right] : left
}

/** A gauge `cellsWide` cells lit to `pct` in `tone`, the rest empty: blocks the SVG draws as cells. */
export function gauge(pct: number, cellsWide: number, tone: Tone): Piece[] {
  const on = Math.round((Math.max(0, Math.min(100, pct)) / 100) * cellsWide)
  return [{ text: '▰'.repeat(on), style: 'bar' as const, tone }, p('▱'.repeat(cellsWide - on), 'barEmpty')].filter(piece => piece.text)
}

function ago(ms: number): string {
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return 'just now'
  return minutes < 60 ? `${minutes} min ago` : `${Math.floor(minutes / 60)} h ago`
}

/** The main session: its model, effort and whether a turn runs, its context gauge and tokens, then its turns, edits and errors. */
function sessionLines(v: PaneView, inner: number): Piece[][] {
  const { card, panel } = v
  const head = [toned(modelName(card.model) ?? '?', 'claude', true), ...(card.effort ? [p(` · ${card.effort}`, 'dim')] : [])]
  const state = card.turnStartedAt !== undefined ? p(`● working ${duration(v.now - card.turnStartedAt)}`, 'ok') : p('○ idle', 'dim')
  const lines = [spread(head, [state], inner)]
  const flows = sent(panel.main.usage) + panel.main.usage.output > 0 ? [flow(panel.main.usage)] : []
  const context = contextOf(card)
  if (context) {
    const room = Math.max(6, Math.min(40, inner - 14 - width(flows)))
    lines.push([p('ctx ', 'dim'), ...gauge(context.percent, room, 'claude'), p(` ${context.percent}%`, 'title'), ...(flows.length ? [p('   '), ...flows] : [])])
  } else if (flows.length) lines.push(flows)
  const figures = [
    [p('turns ', 'dim'), p(String(card.turns), 'title')],
    [p('edits ', 'dim'), p(String(card.edits), 'title')],
    ...(card.errors ? [[p('errors ', 'dim'), p(String(card.errors), 'error')]] : []),
    ...(card.agentTokens !== undefined ? [[p('agents ', 'dim'), p(tokens(card.agentTokens), 'title')]] : []),
  ]
  lines.push(joined(figures, p('   ')))
  return lines
}

/** The mark before an agent: a spinner while it runs in its type's tone, then how it ended. */
function markOf(a: SessionHudPanelAgent, v: PaneView): Piece {
  if (a.status === 'running') return toned(SPINNER[v.frame % SPINNER.length]!, toneOf(nameOf(a)))
  return a.status === 'done' ? p('●', 'ok') : a.status === 'failed' ? p('●', 'error') : p('–', 'dim')
}

/** An agent's row: mark, type in its tone, model and time, then its effort while it runs or how and when it ended. */
function agentRow(a: SessionHudPanelAgent, v: PaneView, inner: number): Piece[] {
  const end = a.endedAt ?? v.now
  const head = [
    markOf(a, v), p(' '), toned(pad(cut(nameOf(a), NAME_MAX), NAME_MAX + 1), toneOf(nameOf(a)), true),
    p(pad(modelName(a.model) ?? '', MODEL_COLUMN), 'dim'), p(pad(duration(end - a.startedAt), 8), 'dim'),
  ]
  const reason = a.endReason ? (REASON.test(a.endReason) ? a.endReason : 'error') : undefined
  const what = a.status === 'running'
    ? (a.effort ? [p(a.effort, 'dim')] : [])
    : [...(reason ? [p(reason, 'error'), p(' · ', 'dim')] : []), p(ago(v.now - end), 'dim')]
  return fit([...head, ...what], inner)
}

/** What a running agent is on: its latest tools, its calls and failed calls, then its context and tokens. */
function activityLine(a: SessionHudPanelAgent, inner: number): Piece[] | null {
  const tools = (a.activity?.tools ?? []).map(tool => (TOOL.test(tool) ? tool : '?'))
  const parts = tools.map((tool, i) => [p(tool, i === tools.length - 1 ? 'plain' : 'dim')])
  const calls = a.activity ? [p(`  ${a.activity.calls} ${a.activity.calls === 1 ? 'call' : 'calls'}`, 'dim'), ...(a.activity.errors ? [p(`  ✗ ${a.activity.errors}`, 'error')] : [])] : []
  const figures: Piece[][] = []
  if (a.contextTokens !== undefined) figures.push([p('ctx ', 'dim'), p(tokens(a.contextTokens))])
  if (a.requests) figures.push([flow(a.usage)])
  if (!parts.length && !figures.length) return null
  return fit([p('  └ ', 'dim'), ...joined(parts, p(' · ', 'dim')), ...calls, ...(figures.length ? [p('  '), ...joined(figures, p('  '))] : [])], inner)
}

function listed(agents: SessionHudPanelAgent[], row: (a: SessionHudPanelAgent) => Piece[]): Piece[][] {
  const extra = agents.length - LISTED
  return [...agents.slice(0, LISTED).map(row), ...(extra > 0 ? [[p(`  +${extra} more`, 'dim')]] : [])]
}

/**
 * A lane for the main session and one per agent type that worked in the last 15 minutes, the most recent first up to
 * `LANES`, in one-minute buckets lit where it worked, and an axis.
 */
function timelineLines(v: PaneView, inner: number): Piece[][] {
  const from = v.now - TIMELINE_MS
  const cw = Math.floor((inner - LANE_LABEL) / BUCKETS)
  if (cw < 1) return []
  const spans = new Map<string, [number, number][]>([[MAIN, []]])
  const add = (lane: string, span: [number, number]) => { if (span[1] >= from) spans.set(lane, [...(spans.get(lane) ?? []), span]) }
  for (const turn of v.panel.main.turns) add(MAIN, turn)
  if (v.card.turnStartedAt !== undefined) add(MAIN, [v.card.turnStartedAt, v.now])
  for (const a of [...v.panel.agents].sort((x, y) => (y.endedAt ?? v.now) - (x.endedAt ?? v.now))) add(nameOf(a), [a.startedAt, a.endedAt ?? v.now])
  const lanes = [...spans.keys()].slice(0, LANES)
  const rows = lanes.map(lane => {
    const runs: Piece[] = []
    for (let i = 0; i < BUCKETS; i++) {
      const [start, end] = [from + i * 60_000, from + (i + 1) * 60_000]
      // A span that just began has no length yet: it lights the bucket it is in, and the last bucket holds `now`.
      const on = spans.get(lane)!.some(([a, b]) => a < end + (i === BUCKETS - 1 ? 1 : 0) && Math.max(b, a + 1) > start)
      const piece: Piece = on ? { text: '━'.repeat(cw), style: 'bar', tone: toneOf(lane) } : p('·'.repeat(cw), 'barEmpty')
      const last = runs.at(-1)
      if (last && last.style === piece.style) last.text += piece.text
      else runs.push(piece)
    }
    return [toned(pad(cut(lane, LANE_LABEL - 1), LANE_LABEL), toneOf(lane)), ...runs]
  })
  const span = cw * BUCKETS
  return [...rows, [p(' '.repeat(LANE_LABEL)), p(`−15m${' '.repeat(Math.max(1, span - 7))}now`, 'dim')]]
}

/** Rows a model takes as the terminal draws it: header, blank, each card and the rail before it, blank, footer. */
export const rowsOf = (cards: Card[]): number => 4 + cards.reduce((n, card, i) => n + card.lines.length + 2 + (i ? 1 : 0), 0)

/** The panel's header, cards and footer, each line fit to the width it is drawn at. */
export function paneModel(v: PaneView): PaneModel {
  const inner = Math.max(1, v.columns - FRAME)
  const agents = v.panel.agents
  const running = agents.filter(a => a.status === 'running')
  const finished = agents.filter(a => a.status !== 'running').sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))
  const card = (key: CardKey, title: string, lines: Piece[][], count?: string): Card =>
    ({ key, tone: CARD_TONE[key], title, ...(count !== undefined ? { count } : {}), aside: [], lines: lines.map(line => fit(line, inner)) })
  const cards: Card[] = [card('session', 'Session', sessionLines(v, inner))]
  if (running.length || !agents.length) {
    const lines = running.length ? running.flatMap(a => [agentRow(a, v, inner), ...[activityLine(a, inner)].filter(line => line !== null)]) : [[p('No agents yet', 'dim')]]
    cards.push(card('running', 'Agents · running', lines, String(running.length)))
  }
  if (finished.length) cards.push(card('finished', 'Agents · finished', listed(finished, a => agentRow(a, v, inner)), String(finished.length)))
  const timeline = timelineLines(v, inner)
  if (timeline.length) cards.push(card('timeline', 'Last 15 minutes', timeline))
  // Short of rows, the least current cards go.
  for (const key of ['timeline', 'finished'] as const) {
    if (v.rows === undefined || rowsOf(cards) <= v.rows) break
    const at = cards.findIndex(c => c.key === key)
    if (at >= 0) cards.splice(at, 1)
  }
  const right = running.length ? [p(`● ${running.length} running`, 'ok')] : []
  return {
    header: fit(spread([p(' HUD ', 'badge'), p('  '), p('Session panel', 'title')], right, v.columns), v.columns),
    cards, footer: [p(`${agents.length} ${agents.length === 1 ? 'agent' : 'agents'}`, 'dim')],
    motion: running.length > 0, frame: v.frame,
  }
}

/** The model as plain lines, a card's title and count on one line: what a test or a plain-text surface reads. */
export function paneLines(v: PaneView): Piece[][] {
  const model = paneModel(v)
  const title = (c: Card) => [p(c.title, 'title'), ...(c.count !== undefined ? [p(` ${c.count}`, 'dim')] : [])]
  return [model.header, ...model.cards.flatMap(c => [title(c), ...c.lines]), model.footer]
}
