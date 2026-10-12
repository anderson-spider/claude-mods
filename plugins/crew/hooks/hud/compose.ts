// The HUD's surfaces as lines (UI spec 4, 6, 7): the docked pane at the fullest level that fits its rows, and the
// one-line-per-item summary that serves the inline pane (layout mini) and the band above the prompt. Pure; draw.ts turns
// these into elements.
import { consultingText, reviewRecent, type RunningRow } from './agents-view'
import { fmtCost, plural, prettyModel } from './format'
import { CONSULTING_GLYPH, GAUGE_EMPTY, GAUGE_FILLED, UNCLASSIFIED_GLYPH, VERDICT_GLYPH, type Tone } from './glyphs'
import { MAX_LEVEL, cardBottom, cardTop, levelPlan, narrowPlan, pickLevel, railRow, type LevelPlan } from './layout'
import { fitLine, sp, spreadLine, type Line, type SectionId, type Span } from './line'
import { elapsedCell } from './live'
import { filled, quotaNeedsLine } from './quota-view'
import { typeInfo, withoutStepId } from './roles'
import {
  derive,
  failedCard,
  finishedCard,
  headerLine,
  latestOf,
  legendLine,
  linkedStep,
  logCard,
  need,
  planCard,
  planLine,
  quotaCard,
  quotaLine,
  reviewCard,
  runningCard,
  sessionCard,
  timelineCard,
  waitingLine,
  type CardModel,
  type Derived,
  type Focus,
  type HudContext,
  type HudInput,
} from './sections'
import { agentSince, favoredChangedRecently } from './state'
import type { Waiting } from './plan'
import { contextView } from './session-view'
import { cellWidth, fit, pad, truncate } from './width'

export type Surface = 'terminal' | 'desktop'

// ------------------------------------------------------------------ the docked pane

export type PaneOptions = {
  /** `bodyColumns`. */
  width: number
  /** The rows the pane can show. */
  rows: number
  surface: Surface
  focus?: Focus | null
}

/** What level 7 drops, by priority, before it cuts lines; Session and the first running row stay. */
type Droppable = 'review' | 'finishedInline' | 'loops' | 'plan' | 'quota' | 'waiting' | 'header'
type Knobs = { maxRunning: number; drop: ReadonlySet<Droppable> }

export type PaneLayout = {
  level: number
  width: number
  header: Line | null
  waiting: Line | null
  /** In the spec's order (4.2). */
  cards: CardModel[]
  legend: Line | null
  /** The desktop's two columns from 110 columns: which cards go left and right, and a column's width; Log spans both. */
  split: { left: SectionId[]; right: SectionId[]; width: number } | null
  /** Sections that threw while drawing (each became one red row). */
  errors: SectionId[]
}

/** The desktop splits into two columns from this width. */
export const SPLIT_COLUMNS = 110
const LEFT: ReadonlySet<SectionId> = new Set(['session', 'quota', 'plan', 'review'])
const MAX_HOTKEYS = 9

function hotkeysOf(d: Derived, knobs: Knobs): Map<string, string> {
  const ids = [
    ...(d.running ?? []).slice(0, knobs.maxRunning).map(r => r.card.id),
    ...(d.finished ?? []).map(f => latestOf(d.s.agents, f.type)).filter((id): id is string => id !== null),
  ]
  return new Map(ids.slice(0, MAX_HOTKEYS).map((id, i) => [id, String(i + 1)]))
}

function layoutAt(d: Derived, o: PaneOptions, lp: LevelPlan, knobs: Knobs): PaneLayout {
  const W = Math.max(0, Math.floor(o.width))
  const isSplit = o.surface === 'desktop' && W >= SPLIT_COLUMNS
  const column = isSplit ? Math.floor((W - 1) / 2) : W
  const widthOf = (id: SectionId) => (id === 'log' || !isSplit ? W : column)
  const cwOf = (id: SectionId) => Math.max(0, widthOf(id) - 4)
  const narOf = (id: SectionId) => narrowPlan(widthOf(id))
  const focus = o.focus ?? null
  const hotkeys = focus?.isFocused ? hotkeysOf(d, knobs) : new Map<string, string>()
  const errors: SectionId[] = []
  const safe = (id: SectionId, build: () => CardModel | null): CardModel | null => {
    try {
      return build()
    } catch {
      errors.push(id)
      return failedCard(id, cwOf(id))
    }
  }
  const drop = knobs.drop
  const cards = [
    safe('session', () => sessionCard(d, cwOf('session'), lp)),
    drop.has('quota') ? null : safe('quota', () => quotaCard(d, cwOf('quota'), lp)),
    drop.has('plan') ? null : safe('plan', () => planCard(d, cwOf('plan'), lp, narOf('plan'))),
    safe('running', () =>
      runningCard(d, cwOf('running'), lp, narOf('running'), {
        maxRunning: knobs.maxRunning,
        showFinishedInline: !drop.has('finishedInline'),
        showLoops: !drop.has('loops'),
        focus,
        hotkeys,
      }),
    ),
    drop.has('review') ? null : safe('review', () => reviewCard(d, cwOf('review'), lp)),
    lp.finished === 'card' ? safe('finished', () => finishedCard(d, cwOf('finished'), narOf('finished'), { focus, hotkeys })) : null,
    lp.timeline ? safe('timeline', () => timelineCard(d, cwOf('timeline'))) : null,
    lp.logRows > 0 ? safe('log', () => logCard(d, cwOf('log'), lp)) : null,
  ].filter((c): c is CardModel => c !== null)
  const ids = cards.map(c => c.id).filter(id => id !== 'log')
  // The unboxed rows: one that throws is left out (and counted with Session, whose state it reads).
  const row = (build: () => Line | null): Line | null => {
    try {
      return build()
    } catch {
      if (!errors.includes('session')) errors.push('session')
      return null
    }
  }
  return {
    level: lp.level,
    width: W,
    header: drop.has('header') ? null : row(() => headerLine(d, W)),
    waiting: drop.has('waiting') ? null : row(() => (d.waiting ? waitingLine(d.waiting, W, ' ') : null)),
    cards,
    legend: lp.legend ? row(() => legendLine(W)) : null,
    split: isSplit ? { left: ids.filter(id => LEFT.has(id)), right: ids.filter(id => !LEFT.has(id)), width: column } : null,
    errors,
  }
}

/** One row of the docked terminal pane: its static text, the card it belongs to, and what a surface may do with it. */
export type PaneRow = {
  spans: Line
  /** The card whose section color a `section` tone takes. */
  card?: SectionId
  /** A rail between cards: animates while the card below is live. */
  rail?: { section: SectionId; isLive: boolean }
  /** An agent's row: its hotkey opens the agent's details. */
  press?: { id: string; hotkey: string }
}

/** A card in its frame (UI spec 4.1): the title in the top border, content between `│ ` and ` │`. */
export function framedRows(c: CardModel, width: number): PaneRow[] {
  const cw = Math.max(0, width - 4)
  const top = cardTop(c.title, width)
  const title = width >= 6 ? truncate(c.title, width - 6) : ''
  const head: Line =
    title === ''
      ? [sp(top, 'section')]
      : [sp(top.slice(0, 3), 'section'), sp(title, 'section', { bold: true }), sp(top.slice(3 + title.length), 'section')]
  const press = new Map((c.press ?? []).map(p => [p.row, p]))
  const rows: PaneRow[] = [{ spans: head, card: c.id }]
  c.rows.forEach((row, i) => {
    const p = press.get(i)
    rows.push({
      spans: [sp('│ ', 'section'), ...fitLine(row, cw), sp(' │', 'section')],
      card: c.id,
      ...(p ? { press: { id: p.id, hotkey: p.hotkey } } : {}),
    })
  })
  rows.push({ spans: [sp(cardBottom(width), 'section')], card: c.id })
  return rows
}

/** The terminal pane's rows: header, S1, cards with a rail between flow cards (Session and Quota flush), legend. */
export function terminalRows(L: PaneLayout): PaneRow[] {
  const W = L.width
  const rails = levelPlan(L.level).rails
  const rows: PaneRow[] = []
  if (L.header) rows.push({ spans: L.header })
  if (L.waiting) rows.push({ spans: L.waiting })
  L.cards.forEach((c, i) => {
    const flush = c.id === 'quota' && L.cards[i - 1]?.id === 'session'
    if (rails && i > 0 && !flush) {
      rows.push({ spans: [sp(railRow(W, null), 'faint')], card: c.id, rail: { section: c.id, isLive: c.isLive } })
    }
    rows.push(...framedRows(c, W))
  })
  if (L.legend) rows.push({ spans: L.legend })
  return rows
}

/** Rows the desktop draws: a pill header (two rows), cards in native boxes (title inside, one gap row between). */
export function desktopHeight(L: PaneLayout): number {
  const head = (L.header ? 2 : 0) + (L.waiting ? 1 : 0) + (L.legend ? 1 : 0)
  const tall = (c: CardModel) => c.rows.length + 3
  const stack = (cards: readonly CardModel[]) => cards.reduce((sum, c, i) => sum + tall(c) + (i > 0 ? 1 : 0), 0)
  if (!L.split) return head + stack(L.cards)
  const split = L.split
  const of = (ids: readonly SectionId[]) => L.cards.filter(c => ids.includes(c.id))
  const log = L.cards.find(c => c.id === 'log')
  return head + Math.max(stack(of(split.left)), stack(of(split.right))) + (log ? 1 + tall(log) : 0)
}

const heightOf = (L: PaneLayout, surface: Surface) => (surface === 'desktop' ? desktopHeight(L) : terminalRows(L).length)

/**
 * The docked pane at the fullest level whose drawing fits `rows` (UI spec 7). At level 7, what still does not fit is
 * dropped by priority (spec 6, 7): Review, running rows beyond the first (`+N more running`), the finished row, the
 * loops row, the header, Quota, Plan, S1; Session and the first running row are never dropped.
 */
export function paneLayout(input: HudInput, ctx: HudContext, o: PaneOptions): PaneLayout {
  const d = derive(input, ctx)
  const full: Knobs = { maxRunning: (d.running ?? []).length, drop: new Set() }
  const level = pickLevel(o.rows, lp => heightOf(layoutAt(d, o, lp, full), o.surface))
  let L = layoutAt(d, o, levelPlan(level), full)
  if (level < MAX_LEVEL) return L
  const lp = levelPlan(MAX_LEVEL)
  const fits = () => heightOf(L, o.surface) <= o.rows
  let knobs = full
  const apply = (next: Knobs) => {
    knobs = next
    L = layoutAt(d, o, lp, knobs)
  }
  const without = (item: Droppable) => apply({ ...knobs, drop: new Set([...knobs.drop, item]) })
  if (!fits()) without('review')
  while (!fits() && knobs.maxRunning > 1) apply({ ...knobs, maxRunning: knobs.maxRunning - 1 })
  for (const item of ['finishedInline', 'loops', 'header', 'quota', 'plan', 'waiting'] as const) if (!fits()) without(item)
  return L
}

/** The terminal pane's rows, cut from the bottom when even level 7 does not fit. */
export function paneRows(input: HudInput, ctx: HudContext, o: Omit<PaneOptions, 'surface'>): { layout: PaneLayout; rows: PaneRow[] } {
  const layout = paneLayout(input, ctx, { ...o, surface: 'terminal' })
  const rows = terminalRows(layout)
  return { layout, rows: rows.length > o.rows ? rows.slice(0, Math.max(0, o.rows)) : rows }
}

// ------------------------------------------------------------------ mini and band

export type SummaryForm = 'mini' | 'band'

export type SummaryOptions = {
  /** `bodyColumns`. */
  width: number
  form: SummaryForm
  /** The band's `maxRows`, or the inline pane's rows (mini: 8 at most). */
  maxRows: number
  /** The pane is docked beside the transcript (layout `mini` there): the mini's docking hint is left out. */
  docked?: boolean
}

/** Rows the summary may take: mini 8, the band `min(6, maxRows - 4)`. */
export const summaryRowCap = (form: SummaryForm, maxRows: number): number =>
  form === 'band' ? Math.max(1, Math.min(6, maxRows - 4)) : Math.max(1, Math.min(8, maxRows))

/** Live agents the summary lists: three, and in the band `min(3, max(1, maxRows - 5))`. */
export const summaryLiveCap = (form: SummaryForm, maxRows: number): number =>
  form === 'band' ? Math.min(3, Math.max(1, maxRows - 5)) : 3

export const MINI_HINT = 'docks beside the transcript in fullscreen from 110 columns'
export const BAND_HINT = '/crew:panel side shows everything'

function gaugeSmall(pct: number, width: number, tone: Tone): Span[] {
  const on = filled(pct, width)
  return [sp(GAUGE_FILLED.repeat(on), tone, { section: 'session' }), sp(GAUGE_EMPTY.repeat(width - on), 'faint')]
}

/** `● working 0:42  Opus 5.5·high  ctx ▰▰▰▰▰▰▱▱▱▱ 64%  $4.12`; narrower drops the cost, then the gauge, then the model. */
export function sessionMiniLine(d: Derived, width: number): Line {
  const s = d.s.session
  const state: Span[] = s.isWorking
    ? [
        sp('● working ', 'role', { role: 'lead' }),
        s.turn
          ? {
              ...sp('', 'role', { role: 'lead' }),
              live: { kind: 'elapsed', key: 'mini-turn', since: s.turn.startedAt, endAt: null, now: d.s.now, width: 5, align: 'left' },
              text: elapsedCell({ since: s.turn.startedAt, now: d.s.now, endAt: null, width: 5, align: 'left' }),
            }
          : sp('     '),
        sp(' '),
      ]
    : [sp(pad('○ idle', 16), 'dim')]
  const model = prettyModel(s.model)
  const modelText = model === '' ? '' : s.effort === '' ? model : `${model}·${s.effort}`
  const modelSpans = modelText === '' ? [] : [sp(`${fit(modelText, 13)}  `, 'text')]
  const c = contextView(s)
  const ctx = (withGauge: boolean): Span[] =>
    c.pct === null
      ? [sp('ctx ', 'dim'), sp('—', 'faint')]
      : [
          sp('ctx ', 'dim'),
          ...(withGauge ? [...gaugeSmall(c.pct, 10, c.tone), sp(' ')] : []),
          sp(`${c.pct}%`, c.tone, { section: 'session' }),
          sp(c.marker, c.tone, { bold: true, section: 'session' }),
        ]
  const cost = [sp(fmtCost(s.costUsd ?? 0), 'text')]
  const variants: [Span[], Span[]][] = [
    [[...state, ...modelSpans, ...ctx(true)], cost],
    [[...state, ...modelSpans, ...ctx(true)], []],
    [[...state, ...modelSpans, ...ctx(false)], []],
    [[...state, ...ctx(false)], []],
  ]
  const fitting = variants.find(([left, right]) => cellWidth(left.map(x => x.text).join('')) + (right.length ? 2 + cellWidth(right.map(x => x.text).join('')) : 0) <= width)
  const [left, right] = fitting ?? (variants[variants.length - 1] as [Span[], Span[]])
  return right.length ? spreadLine(left, right, width) : fitLine(left, width)
}

/** `● developer   T2 contract injection point: //go…    3:12`. */
export function runningMiniLine(d: Derived, r: RunningRow, width: number): Line {
  const c = r.card
  const role = typeInfo(c.type).role
  const since = agentSince(c)
  const step = linkedStep(c, d.planIds)
  const task = step === null ? c.description : `${step} ${withoutStepId(c.description)}`
  const taskWidth = Math.max(0, width - 2 - 13 - 6)
  const live = { kind: 'elapsed' as const, key: `mini-run-${c.id}`, since, endAt: null, now: d.s.now, width: 6, align: 'right' as const }
  return fitLine(
    [sp('● ', 'role', { role }), sp(`${fit(r.name, 12)} `, 'role', { role }), sp(fit(task, taskWidth), 'text'), sp(elapsedCell(live), undefined, { live })],
    width,
  )
}

/** `↺ architect   Fixes: keepalive test races on stop`, or a consult that runs. */
export function reviewMiniLine(d: Derived, width: number): Line | null {
  const c = reviewRecent(d.s.consults, d.s.now)
  if (!c) return null
  const glyph =
    c.endAt === null
      ? sp(`${CONSULTING_GLYPH} `, 'role', { role: 'architect' })
      : c.verdict
        ? sp(`${VERDICT_GLYPH[c.verdict]} `, c.verdict === 'Approve' ? 'ok' : c.verdict === 'Fixes' ? 'warn' : 'bad')
        : sp(`${UNCLASSIFIED_GLYPH} `, 'dim')
  const text = c.endAt === null ? consultingText(c, d.s.now) : c.line === '' ? 'ended without an answer' : c.line
  return fitLine([glyph, sp(`${fit(c.who, 12)} `, 'role', { role: 'architect' }), sp(text, c.line === '' && c.endAt !== null ? 'dim' : 'text')], width)
}

/**
 * The summary (UI spec 6): one line per item at `width`. Items are taken by priority (Session, S1, the first running
 * agent, Plan, Quota, the other running agents, Review) up to the row cap, keeping a row for the footer when something
 * is left out, then drawn in the table's order (S1, Session, Quota, Plan, agents, Review, footer).
 */
export function summaryLines(input: HudInput, ctx: HudContext, o: SummaryOptions): Line[] {
  const d = derive(input, ctx)
  const W = Math.max(0, Math.floor(o.width))
  const cap = summaryRowCap(o.form, o.maxRows)
  const live = summaryLiveCap(o.form, o.maxRows)
  type Item = { order: number; line: Line; isRun: boolean }
  // An item that throws (a malformed atom) is left out; the others still draw.
  const item = (order: number, isRun: boolean, build: () => Line | null): Item | null => {
    try {
      const line = build()
      return line === null ? null : { order, line, isRun }
    } catch {
      return null
    }
  }
  const running = d.running ?? []
  const runs = running.slice(0, live).map((r, i) => item(4 + i, true, () => runningMiniLine(d, r, W)))
  const showQuota = (() => {
    try {
      return quotaNeedsLine(need(d.quota), d.s.quota, ctx.twins, favoredChangedRecently(d.s.favored, d.s.now))
    } catch {
      return false
    }
  })()
  const byPriority = [
    item(1, false, () => sessionMiniLine(d, W)),
    d.waiting ? item(0, false, () => waitingLine(d.waiting as Waiting, W)) : null,
    runs[0] ?? null,
    d.s.plan ? item(3, false, () => planLine(d, W)) : null,
    showQuota ? item(2, false, () => quotaLine(d, W)) : null,
    ...runs.slice(1),
    item(20, false, () => reviewMiniLine(d, W)),
  ].filter((x): x is Item => x !== null)

  const loops = d.s.loops.length
  const hiddenByCap = running.length - runs.length
  const fitsAll = byPriority.length + (hiddenByCap > 0 || loops > 0 ? 1 : 0) <= cap
  const picked = fitsAll ? byPriority : byPriority.slice(0, Math.max(1, cap - 1))
  const dropped = byPriority.length - picked.length
  const hiddenRuns = hiddenByCap + byPriority.slice(picked.length).filter(x => x.isRun).length
  const lines = [...picked].sort((a, b) => a.order - b.order).map(x => x.line)
  if ((dropped > 0 || hiddenRuns > 0 || loops > 0) && lines.length < cap) {
    const parts = [...(hiddenRuns > 0 ? [`+${hiddenRuns} more running`] : []), ...(loops > 0 ? [plural(loops, 'loop')] : [])]
    const hint = o.form === 'band' ? BAND_HINT : o.docked ? null : MINI_HINT
    const withHint = [...parts, ...(hint === null ? [] : [hint])].join(' · ')
    const text = cellWidth(withHint) <= W || parts.length === 0 ? withHint : parts.join(' · ')
    if (text !== '') lines.push(fitLine([sp(text, 'dim')], W))
  }
  return lines
}

// ------------------------------------------------------------------ which form

export type PanelChoice = { isVisible: boolean; placement: 'side' | 'prompt' }

/** The band draws only on the terminal and the desktop, with no survey up, while the panel is visible in `prompt`. */
export function bandShows(o: { surface: string; hasSurvey: boolean; choice: PanelChoice | null }): boolean {
  return (o.surface === 'terminal' || o.surface === 'desktop') && !o.hasSurvey && o.choice !== null && o.choice.isVisible && o.choice.placement === 'prompt'
}

/** The pane's form: the full HUD when docked under `auto`; the summary when inline or under `mini`. */
export const paneForm = (o: { layout: 'auto' | 'mini'; placement: 'dock' | 'inline' }): 'full' | 'mini' =>
  o.layout === 'mini' || o.placement === 'inline' ? 'mini' : 'full'
