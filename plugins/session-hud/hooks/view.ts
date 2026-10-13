import type { SessionHudCard } from '../types'
import { WINDOW_MS, money, paceOf, span } from './usage'

export type Style = 'plain' | 'strong' | 'secondary' | 'model' | 'success' | 'warning' | 'bar' | 'track' | 'tick' | 'frame'
export type Segment = { text: string; style: Style }
export type Row = Segment[]

/** What the card shows of the crew: running helpers and the open plans' totals with their running steps. */
export type CrewSummary = { agents: number; done: number; running: number; left: number; steps: readonly string[] }
/** Everything the card may read: prepared atoms, the clock and the width, never a host. */
export type Snapshot = { card: SessionHudCard; crew?: CrewSummary; now: number; columns: number; working?: boolean }
/** The card as the screen draws it: the rows above the rule and the row under it; empty when there is nothing to show. */
export type Card = { top: Row[]; bottom: Row[] }

const seg = (text: string, style: Style = 'plain'): Segment => ({ text, style })
const cells = (row: Row) => row.reduce((n, part) => n + part.text.length, 0)
const widthOf = (columns: number) => Math.max(4, Math.floor(Number.isFinite(columns) ? columns : 60))
const count = (n: number) => (Number.isSafeInteger(n) && n >= 0 ? n : 0)
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/** One row cut to the width, the cut ending in an ellipsis; segments keep their styles. */
function cutRow(row: Row, columns: number): Row {
  const width = widthOf(columns)
  const out: Row = []
  let used = 0
  for (const part of row) {
    if (used + part.text.length <= width) { out.push(part); used += part.text.length; continue }
    const room = width - used
    if (room > 1) out.push({ ...part, text: `${part.text.slice(0, room - 1)}…` })
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

const FAMILY = /^claude-(opus|sonnet|haiku|fable)-([0-9]{1,2}(?:-[0-9]{1,2})*)(?:-[0-9]{8})?$/
const ALIAS = /^(opus|sonnet|haiku|fable)$/
/** A Claude model as the card names it, `claude-opus-5-5` as `Opus 5.5`; anything else is `?`, so no other text reaches the screen. */
export function modelName(id: string | undefined): string | undefined {
  if (id === undefined) return undefined
  const title = (family: string) => `${family[0]!.toUpperCase()}${family.slice(1)}`
  const full = FAMILY.exec(id)
  if (full) return `${title(full[1]!)} ${full[2]!.replace(/-/g, '.')}`
  return ALIAS.test(id) ? title(id) : '?'
}
const EFFORTS: ReadonlySet<string> = new Set(['low', 'medium', 'high', 'xhigh', 'max'])

const BAR = 8
/** A token count as the card writes it: `440k`, `1M`, `1.5M`. */
function tokens(n: number): string {
  if (n >= 1_000_000) return `${Number((n / 1_000_000).toFixed(1))}M`
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(Math.round(n))
}
const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n)
/**
 * `ctx ━━━ 88% · 440k/500k`: the last input against the window the host compacts at when it is known (a smaller
 * `autoCompactWindow`), else the host's own percent of the model's window.
 */
function contextCells(card: SessionHudCard): Row {
  const used = card.context?.tokens
  const window = finite(card.contextWindow) && card.contextWindow > 0 ? card.contextWindow : card.context?.window
  const percent = finite(used) && used >= 0 && finite(window) && window > 0 ? (used / window) * 100 : card.context?.percent
  if (!finite(percent)) return []
  const shown = Math.max(0, Math.round(percent))
  const lit = Math.min(BAR, Math.round((Math.min(100, shown) / 100) * BAR))
  const row = [seg('ctx ', 'secondary'), seg('━'.repeat(lit), 'success'), seg('━'.repeat(BAR - lit), 'track'), seg(` ${shown}%`, 'strong')]
  if (finite(used) && used >= 0 && finite(window) && window > 0) row.push(seg(` · ${tokens(used)}/${tokens(window)}`, 'secondary'))
  return row
}

/** The first row: the dot (yellow with the turn's time while one runs), the model and its effort, the context bar, the cache share; the session's cost on the right. */
function modelRow(card: SessionHudCard, now: number, working: boolean, inner: number): Row | undefined {
  const name = modelName(card.model)
  const left: Row = []
  if (name !== undefined) {
    left.push(seg('● ', working ? 'warning' : 'success'), seg(name, 'model'))
    if (card.effort !== undefined && EFFORTS.has(card.effort)) left.push(seg(` · ${card.effort}`, 'secondary'))
    if (working && finite(card.turnStartedAt) && finite(now)) left.push(seg(` · working ${span(Math.max(0, now - card.turnStartedAt))}`, 'warning'))
  }
  const context = contextCells(card)
  if (context.length) left.push(...(left.length ? [seg('   ')] : []), ...context)
  if (card.cache !== undefined && Number.isFinite(card.cache)) left.push(...(left.length ? [seg('   ')] : []), seg(`cache ${Math.round(card.cache)}%`, 'secondary'))
  const right = card.cost !== undefined ? [seg('session ', 'secondary'), seg(money(card.cost), 'strong')] : []
  if (!left.length && !right.length) return undefined
  return spread(left, right, inner)
}

const LABELS: Readonly<Record<string, string>> = { five_hour: '5h', seven_day: '7d' }
/** A window's bar is at most this long, so the percent stays beside it on a wide terminal. */
const LIMIT_BAR = 30
/** A window's block at its widest: label, bar, ` 100%` and ` ▲100`; the second window starts right after it. */
const LIMIT_BLOCK = 4 + LIMIT_BAR + 12

/** One window's two lines: its bar with the elapsed-time tick, percent and lead; then the time left and where the pace ends. */
function limitLines(limit: SessionHudCard['limits'][number], now: number, width: number): Row[] {
  const used = Math.max(0, Number.isFinite(limit.percentUsed) ? limit.percentUsed : 0)
  const pace = paceOf(limit, now)
  const head: Row = [seg(`${LABELS[limit.kind]}`.padEnd(4), 'secondary')]
  const percent = seg(` ${Math.round(used)}%`, 'strong')
  const ahead = pace && pace.ahead > 0 ? [seg(` ▲${pace.ahead}`, 'warning')] : []
  const span_ = Math.min(LIMIT_BAR, Math.max(6, width - 4 - percent.text.length - 4))
  const lit = Math.min(span_, Math.round((Math.min(100, used) / 100) * span_))
  const tick = pace ? Math.min(span_ - 1, Math.round(pace.elapsed * span_)) : -1
  const bar: Row = []
  for (let i = 0; i < span_; i++) {
    const part = i === tick ? seg('│', 'tick') : seg('━', i < lit ? 'bar' : 'track')
    const last = bar[bar.length - 1]
    if (last && last.style === part.style) last.text += part.text
    else bar.push(part)
  }
  const lines = [cutRow([...head, ...bar, percent, ...ahead], width)]
  if (pace) {
    const end = pace.fullIn !== undefined ? `100% in ${span(pace.fullIn)}` : `~${pace.atReset}% at reset`
    lines.push(cutRow([seg('    '), seg(`${span(pace.left)} left · `, 'secondary'), seg(end, pace.fullIn !== undefined || pace.atReset > 100 ? 'warning' : 'secondary')], width))
  }
  return lines
}

/** The windows side by side where two fit (a gap of four between, the second no further than one block in), one under the other where they do not. */
function limitRows(card: SessionHudCard, now: number, inner: number): Row[] {
  const limits = card.limits.filter(limit => WINDOW_MS[limit.kind] !== undefined && LABELS[limit.kind] !== undefined)
    .sort((a, b) => WINDOW_MS[a.kind]! - WINDOW_MS[b.kind]!)
  if (!limits.length) return []
  const half = Math.floor((inner - 4) / 2)
  if (limits.length < 2 || half < 34) return limits.flatMap(limit => limitLines(limit, now, inner))
  const block = Math.min(half, LIMIT_BLOCK)
  const [a, b] = limits.slice(0, 2).map(limit => limitLines(limit, now, block))
  const rows: Row[] = []
  for (let i = 0; i < Math.max(a!.length, b!.length); i++) {
    const left = a![i] ?? []
    rows.push([...left, seg(' '.repeat(block - cells(left) + 4)), ...(b![i] ?? [])])
  }
  return rows
}

/** The row under the rule: the last turn, the crew's helpers, edits, errors and the turn's cost; the crew's plan on the right. */
function turnRow(card: SessionHudCard, crew: CrewSummary | undefined, inner: number): Row {
  const parts: string[] = []
  if (card.lastTurnMs !== undefined) parts.push(`last turn ${span(card.lastTurnMs)}`)
  if (crew) parts.push(plural(count(crew.agents), 'agent'))
  parts.push(plural(count(card.edits), 'edit'), plural(count(card.errors), 'error'))
  if (card.lastTurnCost !== undefined && Number.isFinite(card.lastTurnCost) && card.lastTurnCost >= 0) parts.push(`+${money(card.lastTurnCost)}`)
  const right: Row = []
  if (crew && count(crew.done) + count(crew.running) + count(crew.left) > 0) {
    right.push(seg(`plan ${count(crew.done)} done · `, 'secondary'), seg(`${count(crew.running)} running`, count(crew.running) ? 'warning' : 'secondary'),
      seg(` · ${count(crew.left)} left`, 'secondary'))
    if (crew.steps.length) right.push(seg(`  ${crew.steps.join('  ')}`, 'warning'))
  }
  const left = [seg(parts.join(' · '), 'secondary')]
  // Where the plan's words do not fit beside the turn, its counts shrink to done/running/left.
  if (crew && right.length && cells(left) + cells(right) + 2 > widthOf(inner)) {
    const steps = crew.steps.length ? [seg(`  ${crew.steps.join('  ')}`, 'warning')] : []
    return spread(left, [seg(`plan ${count(crew.done)}/${count(crew.running)}/${count(crew.left)}`, 'secondary'), ...steps], inner)
  }
  return spread(left, right, inner)
}

/** The card from one snapshot: rows sized to the band's width less the border and padding (four cells). */
export function cardView({ card, crew, now, columns, working = false }: Snapshot): Card {
  const inner = widthOf(columns) - 4
  const top = [modelRow(card, now, working, inner), ...limitRows(card, now, inner)].filter((row): row is Row => row !== undefined)
  if (!top.length && !crew) return { top: [], bottom: [] }
  return { top, bottom: [turnRow(card, crew, inner)] }
}

const STEP_ID = /^[A-Z][A-Z0-9]*[a-z]?$/
const OWNER = /^(main|crew:[a-z]+(-codex)?)$/
type CrewPlans = readonly ({ groups: readonly { done: number; running: number; left: number; steps: readonly { id: string; owner: string; state: string }[] }[] }
  | { state: string })[]

/** The crew's part of the card from its atoms: running crew helpers, the open plans' totals and the running steps by id and owner. */
export function crewSummary(plans: CrewPlans, agents: readonly { type: string; status: string }[]): CrewSummary {
  const summary = { agents: agents.filter(agent => agent.status === 'running' && agent.type.startsWith('crew:')).length, done: 0, running: 0, left: 0, steps: [] as string[] }
  for (const plan of plans) {
    if (!('groups' in plan)) continue
    for (const group of plan.groups) {
      summary.done += count(group.done)
      summary.running += count(group.running)
      summary.left += count(group.left)
      for (const step of group.steps) {
        if (step.state === 'implementing') summary.steps.push(`${STEP_ID.test(step.id) ? step.id : '?'} ${OWNER.test(step.owner) ? step.owner.replace(/^crew:/, '') : '?'}`)
      }
    }
  }
  return summary
}
