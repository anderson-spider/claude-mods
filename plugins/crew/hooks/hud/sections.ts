// The cards' rows (UI spec 4.4-4.6) as styled lines of an exact width, from the atoms through the H1 views. Pure: the
// time is `input.now`, nothing reads `$`; every row is fitted to the card's content width (`cw`), and text columns take
// the cells beyond the 52 the spec lays out at 56 columns.
import {
  FINISHED_MAX,
  consultingText,
  finishedInline,
  finishedRows,
  newestConsults,
  plannedFor,
  runningEmptyText,
  runningRows,
  type FinishedRow,
  type RunningRow,
  type Strip,
} from './agents-view'
import { fmtClock, fmtClockSeconds, fmtTokens, plural, prettyModel } from './format'
import {
  CONSULTING_GLYPH,
  FAVORED_MARK,
  GAUGE_EMPTY,
  GAUGE_FILLED,
  GAUGE_UNKNOWN,
  LEGEND,
  STEP_GLYPH,
  STEP_TONE,
  UNCLASSIFIED_GLYPH,
  VERDICT_GLYPH,
  type Tone,
} from './glyphs'
import { type LevelPlan, type NarrowPlan } from './layout'
import { dimmed, fitLine, sp, spreadLine, type Line, type SectionId, type Span } from './line'
import { elapsedCell } from './live'
import {
  overflowText,
  planProblem,
  planView,
  skippedNote,
  verificationGap,
  waitingOnYou,
  waveFooter,
  type Group,
  type ParsedPlan,
  type PlanView,
  type StepRow,
  type Waiting,
} from './plan'
import { filled, quotaView, type GaugeRow, type ProviderBlock, type QuotaView } from './quota-view'
import { typeInfo, withoutStepId, type Role } from './roles'
import { contextView, headerProfile, modelLine, receiptLine, tokenRow } from './session-view'
import { agentSince, defaultSession, isRunning, lastRound, loopSummary, statusOfCard } from './state'
import { LANE_GLYPH, laneStats, timelineAxis, timelineLanes, type Lane } from './timeline'
import type { AgentCard, Consult, Favored, LogLine, Loop, Session } from './types'
import type { Quota } from '../quota'
import { cellWidth, fit, pad, truncate, wrap } from './width'

// ------------------------------------------------------------------ input

/** Everything the drawing reads: the atoms' values, the active plan and the time. */
export type HudInput = {
  session: Session
  agents: readonly AgentCard[]
  consults: readonly Consult[]
  log: readonly LogLine[]
  loops: readonly Loop[]
  favored: Favored | null
  quota: Quota
  /** The active plan by name, `parsed: null` when its file could not be read; null when no plan is active. */
  plan: { name: string; parsed: ParsedPlan | null } | null
  now: number
}

/** What the session runs with, from the options and the registrations. */
export type HudContext = {
  /** Provider routing is on (`quotaRouting` with Jev on): the favored row and the `◆`. */
  routing: boolean
  /** Jev routing is on with a valid key: `jev` in the header. */
  jev: boolean
  /** Codex twins are registered: `cx` in the header and the Codex column. */
  twins: boolean
  /** The host has reported its rate limits at least once this session. */
  claudeMeasured: boolean
}

/** The views every card shares, computed once per drawing. */
export type Derived = {
  s: HudInput
  cx: HudContext
  view: PlanView | null
  /** The amber row when the plan cannot be shown. */
  problem: string | null
  /** The plan view threw: the Plan card is drawn as its failure row. */
  planBroken: boolean
  planIds: ReadonlySet<string>
  /** Queued plan steps owned by a type (the `▱` cells of its job strip). */
  planned: (type: string) => number
  /** Null when the view threw (a malformed atom): the cards that need it are drawn as their failure row. */
  quota: QuotaView | null
  waiting: Waiting | null
  running: RunningRow[] | null
  finished: FinishedRow[] | null
}

const attempt = <T,>(build: () => T, fallback: T): T => {
  try {
    return build()
  } catch {
    return fallback
  }
}

/** A view a card needs; a missing one makes the card throw, so it is drawn as its failure row. */
export function need<T>(value: T | null): T {
  if (value === null) throw new Error('view not available')
  return value
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback)
const num = (v: unknown, fallback = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)

/** A card the views can read, or null: id, type and description are text and every round has a start and a status. */
function cleanCard(c: unknown): AgentCard | null {
  if (!isObj(c) || typeof c.id !== 'string' || typeof c.type !== 'string' || typeof c.description !== 'string') return null
  if (!Array.isArray(c.rounds) || !c.rounds.every(r => isObj(r) && typeof r.startedAt === 'number' && typeof r.status === 'string')) return null
  const card = c as unknown as AgentCard
  return {
    ...card,
    provider: card.provider === 'codex' ? 'codex' : 'claude',
    stepId: typeof c.stepId === 'string' ? c.stepId : null,
    model: str(c.model),
    effort: str(c.effort),
    spawnedAt: num(c.spawnedAt, (c.rounds[0] as { startedAt: number } | undefined)?.startedAt ?? 0),
    steps: num(c.steps),
    ctx: num(c.ctx),
    output: num(c.output),
    lastStop: typeof c.lastStop === 'string' ? c.lastStop : null,
    lastTool: str(c.lastTool),
    denied: str(c.denied),
  }
}

function cleanConsult(c: unknown): Consult | null {
  if (!isObj(c) || typeof c.id !== 'string' || typeof c.who !== 'string' || typeof c.at !== 'number') return null
  const consult = c as unknown as Consult
  const verdict = consult.verdict === 'Approve' || consult.verdict === 'Fixes' || consult.verdict === 'Reject' ? consult.verdict : null
  return {
    ...consult,
    endAt: typeof c.endAt === 'number' ? c.endAt : null,
    description: str(c.description),
    stepId: typeof c.stepId === 'string' ? c.stepId : null,
    line: str(c.line),
    verdict,
    reason: str(c.reason),
  }
}

const cleanList = <T,>(list: unknown, clean: (item: unknown) => T | null): T[] =>
  Array.isArray(list) ? list.map(clean).filter((x): x is T => x !== null) : []

/**
 * The input as the views can read it: an element of a list that is malformed drops itself only, a list that is not one
 * is empty, a session that is not an object is the default one (an atom before `session.start` set it).
 */
export function cleanInput(raw: HudInput): HudInput {
  const now = num(raw?.now)
  const plan = isObj(raw?.plan) && typeof raw.plan.name === 'string' ? raw.plan : null
  const parsed = plan && isObj(plan.parsed) && Array.isArray(plan.parsed.steps) && Array.isArray(plan.parsed.waves) ? plan.parsed : null
  return {
    session: isObj(raw?.session) ? { ...defaultSession(now), ...(raw.session as Session) } : defaultSession(now),
    agents: cleanList(raw?.agents, cleanCard),
    consults: cleanList(raw?.consults, cleanConsult),
    log: cleanList(raw?.log, l => (isObj(l) && typeof l.at === 'number' && typeof l.who === 'string' && typeof l.text === 'string' ? (l as unknown as LogLine) : null)),
    loops: cleanList(raw?.loops, l => (isObj(l) && typeof l.id === 'string' && typeof l.lastAt === 'number' ? (l as unknown as Loop) : null)),
    favored: isObj(raw?.favored) ? (raw.favored as unknown as Favored) : null,
    quota: raw?.quota,
    plan: plan ? { name: plan.name, parsed } : null,
    now,
  }
}

export function derive(input: HudInput, cx: HudContext): Derived {
  const s = cleanInput(input)
  const parsed = s.plan?.parsed ?? null
  const problem = attempt(() => (s.plan ? planProblem(s.plan.name, parsed) : null), null)
  let planBroken = false
  const view = attempt(
    () => (s.plan && parsed && problem === null ? planView(parsed, s.plan.name, { agents: s.agents, now: s.now }) : null),
    null,
  )
  if (s.plan && parsed && problem === null && view === null) planBroken = true
  const steps = attempt(() => (parsed?.steps ?? []).filter(step => typeof step?.id === 'string'), [])
  const planned = (type: string) => attempt(() => plannedFor(steps, type), 0)
  return {
    s,
    cx,
    view,
    problem,
    planBroken,
    planIds: new Set(steps.map(step => step.id)),
    planned,
    quota: attempt(() => quotaView(s.quota, { now: s.now, routing: cx.routing, twins: cx.twins, claudeMeasured: cx.claudeMeasured }), null),
    waiting: attempt(() => waitingOnYou(view, s.session, s.agents, s.consults), null),
    running: attempt(() => runningRows(s.agents, { now: s.now, window: s.session.contextWindow, planned }), null),
    finished: attempt(() => finishedRows(s.agents, { planned }), null),
  }
}

/**
 * The plan step an agent works on: its leading id, only when the plan holds that step (`API2 migration` is no link
 * unless the plan has a step `API2`).
 */
export const linkedStep = (card: Pick<AgentCard, 'stepId'>, planIds: ReadonlySet<string>): string | null =>
  card.stepId !== null && planIds.has(card.stepId) ? card.stepId : null

// ------------------------------------------------------------------ cards

/** A pressable row (an agent's first row): its hotkey opens the agent's details. */
export type Press = { row: number; id: string; hotkey: string }

export type CardModel = {
  id: SectionId
  title: string
  /** Content rows, each exactly the content width. */
  rows: Line[]
  /** The rail into this card animates (a step runs, an agent runs, a consult runs). */
  isLive: boolean
  press?: Press[]
  /** Lanes as data, for an SVG on the desktop. */
  lanes?: Lane[]
}

export const card = (id: SectionId, title: string, rows: Line[], isLive = false): CardModel => ({ id, title, rows, isLive })

/** Spec 4.5: a card that throws while drawing is one red row; the other cards still draw. */
export const SECTION_NAME: Readonly<Record<SectionId, string>> = {
  session: 'Session',
  quota: 'Quota',
  plan: 'Plan',
  running: 'Agents · running',
  review: 'Review',
  finished: 'Agents · finished',
  timeline: 'Last 15 minutes',
  log: 'Log',
}

export function failedCard(id: SectionId, cw: number): CardModel {
  return card(id, SECTION_NAME[id], [fitLine([sp(`${SECTION_NAME[id]} could not be drawn; see the debug log.`, 'bad')], cw)])
}

/** The layout's base content width (56 columns less the frame); text columns take what lies beyond it. */
export const BASE_CONTENT = 52

const extraOf = (cw: number) => Math.max(0, cw - BASE_CONTENT)

function gaugeSpans(pct: number | null, width: number, tone: Tone, section: SectionId): Span[] {
  if (width <= 0) return []
  if (pct === null) return [sp(GAUGE_UNKNOWN.repeat(width), 'faint')]
  const on = filled(pct, width)
  return [sp(GAUGE_FILLED.repeat(on), tone, { section }), sp(GAUGE_EMPTY.repeat(width - on), 'faint')]
}

const maybeDim = (spans: Span[], isDim: boolean): Span[] => (isDim ? dimmed(spans) : spans)

const roleOf = (type: string): Role => (type === 'lead' ? 'lead' : typeInfo(type).role)

/** A clock column: static text of exactly `width` cells that ticks where the surface runs client modules. */
function clockSpan(key: string, since: number, now: number, width: number, align: 'left' | 'right', tone?: Tone): Span {
  const live = { kind: 'elapsed' as const, key, since, endAt: null, now, width, align }
  return sp(elapsedCell(live), tone, { live })
}

// ------------------------------------------------------------------ header, waiting, legend

/** ` CREW ` · profile · clock, unboxed, `width` cells. */
export function headerLine(d: Derived, width: number): Line {
  const profile = headerProfile({ mode: d.s.session.mode, jev: d.cx.jev, cx: d.cx.twins })
  const left = [sp(' CREW ', 'role', { role: 'lead', inverse: true, bold: true }), ...(profile ? [sp(` ${profile}`, 'dim')] : [])]
  return spreadLine(left, [sp(fmtClock(d.s.now), 'dim')], width)
}

/** S1: `! Waiting on you · …` in amber; `lead` adds the pane's leading space. */
export function waitingLine(w: Waiting, width: number, lead = ''): Line {
  return fitLine([sp(`${lead}! `, 'warn', { bold: true }), sp(`Waiting on you · ${w.text}`, 'warn')], width)
}

export const legendLine = (width: number): Line => fitLine([sp(`  ${LEGEND}`, 'dim')], width)

// ------------------------------------------------------------------ Session

const stateSpan = (s: Session): Span => (s.isWorking ? sp('● working', 'role', { role: 'lead' }) : sp('○ idle', 'dim'))

function contextSpans(s: Session, gaugeWidth: number): Span[] {
  const c = contextView(s)
  if (c.pct === null) return [sp('ctx ', 'dim'), sp('—', 'faint')]
  return [
    sp('ctx ', 'dim'),
    ...gaugeSpans(c.pct, gaugeWidth, c.tone, 'session'),
    sp(gaugeWidth > 0 ? fit(`${c.pct}%`, 4, 'right') : `${c.pct}%`, c.tone, { section: 'session' }),
    sp(pad(c.marker, 2), c.tone, { bold: true, section: 'session' }),
  ]
}

export function sessionCard(d: Derived, cw: number, lp: LevelPlan): CardModel {
  const s = d.s.session
  const now = d.s.now
  const tokens = tokenRow(s)
  if (lp.sessionRows === 1) {
    const left = [sp(modelLine(s), 'text'), sp('  '), stateSpan(s), sp('  '), ...contextSpans(s, 0)]
    return card('session', 'Session', [spreadLine(left, [sp(tokens.cost, 'text')], cw)])
  }
  const row1 = spreadLine([sp(modelLine(s), 'text')], [sp(pad(stateSpan(s).text, 9, 'right'), stateSpan(s).tone, { role: 'lead' })], cw)

  const c = contextView(s)
  const right2 = c.tokens === '' ? [] : [sp(c.tokens, 'dim')]
  const room = cw - 4 - 4 - 2 - (c.tokens === '' ? 0 : cellWidth(c.tokens) + 1)
  const row2 = spreadLine(contextSpans(s, room >= 4 ? Math.min(30, room) : 0), right2, cw)

  const right3 = [...(tokens.compacted ? [sp(`${tokens.compacted} `, 'warn')] : []), sp(tokens.uptime(now), 'dim')]
  const row3 = spreadLine([sp(tokens.cost, 'text'), sp(`  ${tokens.flow}`, 'dim')], right3, cw)

  const receipt = receiptLine(s, now, cw)
  let row4: Line
  if (s.turn === null && s.lastTurn === null) row4 = fitLine([sp(receipt, 'dim')], cw)
  else if (s.turn !== null || s.lastTurn === null) row4 = fitLine([sp(receipt, 'text')], cw)
  else {
    const tone: Tone = s.lastTurn.outcome === 'done' ? 'ok' : s.lastTurn.outcome === 'failed' ? 'bad' : 'dim'
    row4 = fitLine([sp(receipt.slice(0, 1), tone), sp(receipt.slice(1), 'text')], cw)
  }
  return card('session', 'Session', [row1, row2, row3, row4])
}

// ------------------------------------------------------------------ Quota

const QUOTA_LABEL = 4
const PCT = 4
const MARK = 2

/** A provider's heading in its block: name (+ ` ◆`) and `resets`; `resets` goes first, then the name is cut, so it fits. */
export function quotaHeading(b: ProviderBlock, width: number): Line {
  const mark = b.isFavored ? ` ${FAVORED_MARK}` : ''
  const markWidth = cellWidth(mark)
  const withResets = b.showResets && cellWidth(b.header) + markWidth + 1 + 'resets'.length <= width
  const name = truncate(b.header, Math.max(0, width - markWidth))
  const left = [sp(name, 'text', { bold: true, ...(b.isDim ? { dim: true } : {}) }), ...(mark ? [sp(mark, 'section', { section: 'quota' })] : [])]
  return withResets ? spreadLine(left, [sp('resets', 'dim')], width) : fitLine(left, width)
}

function pctSpans(g: GaugeRow, width = PCT): Span[] {
  const tone: Tone = g.pct === null ? 'faint' : g.tone
  return [
    sp(fit(g.pct === null ? '—' : `${g.pct}%`, width, 'right'), tone, { section: 'quota' }),
    sp(pad(g.marker, MARK), tone, { bold: true, section: 'quota' }),
  ]
}

/** `▰▰▰▰▱▱▱▱▱▱  41%   2h10m` in `width` cells with a `gaugeWidth`-cell gauge. */
function gaugeBlock(g: GaugeRow | undefined, width: number, gaugeWidth: number): Line {
  if (!g) return fitLine([], width)
  const resetWidth = Math.max(0, width - gaugeWidth - 1 - PCT - MARK)
  const spans = [
    ...gaugeSpans(g.pct, gaugeWidth, g.tone, 'quota'),
    sp(' '),
    ...pctSpans(g),
    sp(fit(g.resetText, resetWidth, 'right'), 'dim'),
  ]
  return fitLine(maybeDim(spans, g.isDim), width)
}

/** The card form: a heading row, then 5h and 7d, Claude and Codex side by side (Claude alone: 30-cell gauges). */
function quotaBlockRows(v: QuotaView, cw: number): Line[] {
  const label = (text: string) => sp(pad(text, QUOTA_LABEL), 'dim')
  if (v.codex === null) {
    const width = cw - QUOTA_LABEL
    const rows = [fitLine([label(''), ...quotaHeading(v.claude, width)], cw)]
    const gaugeWidth = Math.max(0, Math.min(30, width - 1 - PCT - MARK - 6))
    for (const g of v.claude.gauges) rows.push(fitLine([label(g.label), ...gaugeBlock(g, width, gaugeWidth)], cw))
    return rows
  }
  const gap = 2
  const w1 = Math.floor((cw - QUOTA_LABEL - gap) / 2)
  const w2 = cw - QUOTA_LABEL - gap - w1
  const gaugeWidth = Math.max(0, Math.min(10, w1 - 1 - PCT - MARK - 6))
  const rows = [fitLine([label(''), ...quotaHeading(v.claude, w1), sp(' '.repeat(gap)), ...quotaHeading(v.codex, w2)], cw)]
  for (const [i, name] of ['5h', '7d'].entries()) {
    const claude = v.claude.gauges[i]
    const codex = v.codex.gauges[i]
    rows.push(fitLine([label(name), ...gaugeBlock(claude, w1, gaugeWidth), sp(' '.repeat(gap)), ...gaugeBlock(codex, w2, gaugeWidth)], cw))
  }
  return rows
}

const providerName = (b: ProviderBlock) => (b.provider === 'claude' ? 'Claude' : 'Codex')

/** Level 4 (and narrow panes): no heading row; the provider names move into the rows. */
function quotaFlatRows(v: QuotaView, cw: number): Line[] {
  const rows: Line[] = []
  const parts = [v.claude, ...(v.codex ? [v.codex] : [])].filter(b => b.gauges.length > 0)
  if (v.claude.gauges.length === 0) rows.push(fitLine([sp(v.claude.header, 'dim')], cw))
  if (parts.length === 0) return rows
  const solo = parts.length === 1
  const NAME = 7
  const per = solo ? cw - 3 : Math.floor((cw - 3 - 3) / 2)
  const fixed = NAME + 1 + 1 + PCT + MARK
  // Too narrow for a readable gauge: the percentages stay, the gauges go.
  const room = Math.min(solo ? 30 : 10, per - fixed - (solo ? 7 : 0))
  const gaugeWidth = room >= 3 ? room : 0
  for (const [i, name] of ['5h', '7d'].entries()) {
    const spans: Span[] = [sp(pad(name, 3), 'dim')]
    parts.forEach((b, k) => {
      const g = b.gauges[i]
      if (k > 0) spans.push(sp(' · ', 'dim'))
      const head = sp(pad(`${providerName(b)}${b.isFavored ? FAVORED_MARK : ''}`, NAME), 'text', { bold: true })
      const body = g ? [...gaugeSpans(g.pct, gaugeWidth, g.tone, 'quota'), ...(gaugeWidth > 0 ? [sp(' ')] : []), ...pctSpans(g)] : []
      const reset = solo && g ? [sp(fit(g.resetText, 7, 'right'), 'dim')] : []
      const part = [head, sp(' '), ...body, ...reset]
      spans.push(...maybeDim(part, b.isDim))
    })
    rows.push(fitLine(spans, cw))
  }
  return rows
}

/** The 5h window when it is at 85% or more, else the 7d one. */
function hotWindow(b: ProviderBlock): GaugeRow | undefined {
  const [five, seven] = b.gauges
  return five && five.pct !== null && five.pct >= 85 ? five : (seven ?? five)
}

/**
 * The one-line quota (mini, band, level 6): `7d Claude ▰▰▰▰▰▰▱▱ 71%! · Codex ▰▰▰▱▱▱▱▱ 38% → Codex`; a 5h window at 85% or
 * more replaces its provider's 7d; Claude alone adds its other window: `7d Claude ▰▰▰▰▰▰▱▱ 71%! · 5h 41%`.
 */
export function quotaLine(d: Derived, width: number): Line {
  const v = need(d.quota)
  const spans: Span[] = []
  const small = (g: GaugeRow) => [...gaugeSpans(g.pct, 8, g.tone, 'quota'), sp(' '), sp(g.pct === null ? '—' : `${g.pct}%`, g.pct === null ? 'faint' : g.tone, { section: 'quota' }), sp(g.marker, g.tone, { bold: true, section: 'quota' })]
  const claude = hotWindow(v.claude)
  if (claude) spans.push(...maybeDim([sp(`${claude.label} `, 'dim'), sp('Claude ', 'text'), ...small(claude)], v.claude.isDim))
  else spans.push(sp(v.claude.header, 'dim'))
  if (v.codex) {
    const codex = hotWindow(v.codex)
    spans.push(sp(' · ', 'dim'))
    if (codex) {
      const head = claude && claude.label === codex.label ? [] : [sp(`${codex.label} `, 'dim')]
      spans.push(...maybeDim([...head, sp('Codex ', 'text'), ...small(codex)], v.codex.isDim))
    } else spans.push(sp(v.codex.header, 'dim'))
  } else if (claude) {
    const other = v.claude.gauges.find(g => g.label !== claude.label)
    if (other) spans.push(sp(' · ', 'dim'), sp(`${other.label} `, 'dim'), sp(other.pct === null ? '—' : `${other.pct}%`, other.pct === null ? 'faint' : other.tone, { section: 'quota' }), sp(other.marker, other.tone, { bold: true }))
  }
  if (v.favoredRow !== null) {
    const favored = v.claude.isFavored ? 'Claude' : v.codex?.isFavored ? 'Codex' : null
    if (favored) spans.push(sp(` → ${favored}`, 'text'))
  }
  return fitLine(spans, width)
}

export function quotaCard(d: Derived, cw: number, lp: LevelPlan): CardModel {
  const v = need(d.quota)
  if (lp.quota === 'line') return card('quota', 'Quota', [quotaLine(d, cw)])
  const flat = lp.quota !== 'card'
  const rows = flat ? quotaFlatRows(v, cw) : quotaBlockRows(v, cw)
  const hot = (v.hottest ?? 0) >= 70
  if (v.favoredRow !== null && (lp.quota !== 'favored-when-hot' || hot)) rows.push(fitLine([sp(v.favoredRow, 'text')], cw))
  return card('quota', 'Quota', rows)
}

// ------------------------------------------------------------------ Plan

/** A strip squeezed into `width` cells: verified green, in progress amber `▶`, the rest `▱`. */
function squeezedStrip(v: PlanView, width: number): Span[] {
  if (width <= 0 || v.total === 0) return []
  const active = v.lists.implementing.length + v.lists.qa.length + v.lists.fixes.length
  const done = Math.min(width, Math.round((v.done / v.total) * width))
  const busy = active > 0 ? Math.min(width - done, Math.max(1, Math.round((active / v.total) * width))) : 0
  return [sp(GAUGE_FILLED.repeat(done), 'ok'), sp('▶'.repeat(busy), 'warn'), sp(GAUGE_EMPTY.repeat(width - done - busy), 'dim')]
}

function stripSpans(d: Derived, v: PlanView, width: number): Span[] {
  if (v.strip.length > width) return squeezedStrip(v, width)
  const steps = d.s.plan?.parsed?.steps ?? []
  return v.strip.map((cell, i) => sp(cell.glyph, cell.tone, { role: roleOf(steps[i]?.owner ?? '') }))
}

const RIGHT_TONE: Readonly<Record<StepRow['right']['kind'], Tone | undefined>> = {
  elapsed: undefined,
  qa: 'text',
  fixes: 'warn',
  failed: 'bad',
  ready: 'ok',
  on: 'dim',
  blocked: 'bad',
  none: undefined,
}

/** When the running agent linked to a step started its current job (its clock's start), or null. */
function linkedSince(d: Derived, stepId: string): number | null {
  const running = d.s.agents.filter(a => a.stepId === stepId && isRunning(a)).sort((a, b) => a.spawnedAt - b.spawnedAt)[0]
  return running ? agentSince(running) : null
}

const BUCKETS: readonly { key: 'now' | 'blocked' | 'next' | 'waits'; label: string; more: string }[] = [
  { key: 'now', label: 'now', more: 'now' },
  { key: 'blocked', label: 'blocked', more: 'blocked' },
  { key: 'next', label: 'next', more: 'ready' },
  { key: 'waits', label: 'waits', more: 'waiting' },
]

function stepLine(d: Derived, row: StepRow, label: string, cols: { id: number; owner: number; text: number }, cw: number): Line {
  const role = roleOf(row.step.owner)
  const right: Span =
    row.right.kind === 'elapsed' && linkedSince(d, row.step.id) !== null
      ? clockSpan(`plan-${row.step.id}`, linkedSince(d, row.step.id) as number, d.s.now, 8, 'right')
      : sp(fit(row.right.text, 8, 'right'), RIGHT_TONE[row.right.kind])
  return fitLine(
    [
      sp(pad(label, 8), 'dim'),
      sp(`${STEP_GLYPH[row.kind]} `, STEP_TONE[row.kind], { role }),
      sp(fit(row.step.id, cols.id), 'text', { bold: true }),
      ...(cols.owner > 0 ? [sp(`${fit(row.owner, cols.owner - 1)} `, 'role', { role })] : []),
      sp(`${fit(row.label, Math.max(0, cols.text - 1))} `, 'text'),
      right,
    ],
    cw,
  )
}

function bucketLines(d: Derived, v: PlanView, groups: readonly { label: string; more: string; group: Group }[], cw: number, nar: NarrowPlan): Line[] {
  const shown = groups.flatMap(g => g.group.rows)
  const id = Math.max(4, ...shown.map(r => cellWidth(r.step.id) + 1))
  const owner = nar.planOwner ? 13 : 0
  const text = Math.max(0, cw - 8 - 2 - id - owner - 8)
  const rows: Line[] = []
  for (const g of groups) {
    g.group.rows.forEach((row, i) => rows.push(stepLine(d, row, i === 0 ? g.label : '', { id, owner, text }, cw)))
    if (g.group.more > 0) rows.push(fitLine([sp(' '.repeat(8)), sp(overflowText(g.more, g.group, cw - 8), 'dim')], cw))
  }
  return rows
}

export function planCard(d: Derived, cw: number, lp: LevelPlan, nar: NarrowPlan): CardModel | null {
  const plan = d.s.plan
  if (!plan) return null
  const title = `Plan · ${plan.name}`
  if (d.planBroken) throw new Error('plan view failed')
  if (d.problem !== null || d.view === null) return card('plan', title, [fitLine([sp(d.problem ?? '', 'warn')], cw)])
  const v = d.view
  const isLive = v.now.rows.some(r => r.right.kind === 'elapsed')
  if (lp.plan === 'line') return card('plan', title, [planLine(d, cw)], isLive)

  const counts = `  ${v.done}/${v.total} verified${v.waveNo !== null ? ` · wave ${v.waveNo}/${v.waveCount}` : ''}`
  const stripWidth = Math.max(0, Math.min(30, cw - cellWidth(counts)))
  const rows: Line[] = [fitLine([...stripSpans(d, v, stripWidth), sp(counts, 'text')], cw)]
  if (v.allDone) {
    rows.push(fitLine([sp(`✓ all ${v.total} steps verified · ${v.committed} committed`, 'ok')], cw))
    return card('plan', title, rows, isLive)
  }
  if (lp.plan === 'short') {
    const first = (g: Group): Group => ({ rows: g.rows.slice(0, 1), more: 0, moreIds: [] })
    rows.push(...bucketLines(d, v, [{ label: 'now', more: 'now', group: first(v.now) }, { label: 'next', more: 'ready', group: first(v.next) }], cw, nar))
    return card('plan', title, rows, isLive)
  }
  rows.push(...bucketLines(d, v, BUCKETS.map(b => ({ label: b.label, more: b.more, group: v[b.key] })), cw, nar))
  const skipped = skippedNote(v.skipped)
  const wave = waveFooter(v, skipped ? Math.max(0, cw - cellWidth(skipped) - 3) : cw)
  const footer = [wave, skipped].filter((t): t is string => t !== null && t !== '').join(' · ')
  if (footer) rows.push(fitLine([sp(footer, 'dim')], cw))
  const gap = verificationGap(v, d.s.agents, d.s.consults)
  if (gap) rows.push(fitLine([sp(gap, 'warn')], cw))
  return card('plan', title, rows, isLive)
}

/** The one-line plan (mini, band, level 6): `plan 2/14 ▰▰▶▱▱▱▱▱ · now T2 · next T3 · ⊘ 1 blocked`. */
export function planLine(d: Derived, width: number): Line {
  if (d.planBroken) throw new Error('plan view failed')
  if (d.problem !== null || d.view === null) return fitLine([sp(d.problem ?? '', 'warn')], width)
  const v = d.view
  const spans: Span[] = [sp('plan ', 'section', { section: 'plan' }), sp(`${v.done}/${v.total} `, 'text'), ...squeezedStrip(v, 8)]
  if (v.allDone) spans.push(sp(' · all verified', 'ok'))
  else {
    const now = [...v.lists.fixes, ...v.lists.qa, ...v.lists.implementing].map(s => s.id)
    const next = v.lists.ready.map(s => s.id)
    if (now.length > 0) spans.push(sp(` · now ${now.join(' ')}`, 'text'))
    if (next.length > 0) spans.push(sp(` · next ${next.join(' ')}`, 'text'))
    if (v.lists.blocked.length > 0) spans.push(sp(` · ⊘ ${v.lists.blocked.length} blocked`, 'bad'))
  }
  return fitLine(spans, width)
}

// ------------------------------------------------------------------ Agents · running

function jobSpans(strip: Strip, width: number, role: Role): Span[] {
  if (width <= 0) return []
  const spans = strip.cells.map(c => sp(c.glyph, c.tone, { role }))
  if (strip.more > 0) spans.push(sp(`+${strip.more}`, 'dim'))
  return fitLine(spans, width)
}

/** The task as the lead wrote it, the plan step id first when the plan holds it. */
function taskSpans(d: Derived, c: AgentCard): Span[] {
  const step = linkedStep(c, d.planIds)
  return step === null ? [sp(c.description, 'text')] : [sp(step, 'text', { bold: true }), sp(` ${withoutStepId(c.description)}`, 'text')]
}

const modelText = (c: AgentCard, withEffort: boolean) => {
  const model = prettyModel(c.model)
  return withEffort && c.effort !== '' ? `${model} · ${c.effort}` : model
}

/** Cells the host's plain Button draws before its content: the hotkey, a colon and a space (`1: `). */
export const HOTKEY_CELLS = 3

/**
 * A row of a focused pane: `1: ` then the content in 3 cells less, as the host draws a plain Button with a hotkey, so
 * the row keeps its width. A row without a hotkey keeps the same 3 cells blank, so the columns line up.
 */
function keyedRow(spans: readonly Span[], cw: number, focus: Focus | null, hotkey: string | undefined): Line {
  if (!focus?.isFocused) return fitLine(spans, cw)
  const prefix = hotkey ? sp(`${hotkey}: `, 'dim', { pressPrefix: true }) : sp(' '.repeat(HOTKEY_CELLS))
  return [prefix, ...fitLine(spans, Math.max(0, cw - HOTKEY_CELLS))]
}

function agentLines(d: Derived, r: RunningRow, cw: number, lp: LevelPlan, nar: NarrowPlan, focus: Focus | null, hotkey: string | undefined): Line[] {
  const c = r.card
  const role = typeInfo(c.type).role
  const stripWidth = nar.jobStrip ? 9 : 0
  const keyCells = focus?.isFocused ? HOTKEY_CELLS : 0
  const modelWidth = Math.max(0, cw - keyCells - 2 - 13 - stripWidth - 8)
  const since = agentSince(c)
  const row1 = keyedRow(
    [
      sp('● ', 'role', { role }),
      sp(`${fit(r.name, 12)} `, 'role', { role }),
      sp(`${fit(modelText(c, nar.effort), Math.max(0, modelWidth - 1))} `, 'text'),
      ...jobSpans(r.strip, stripWidth, role),
      clockSpan(`run-${c.id}`, since, d.s.now, 8, 'right'),
    ],
    cw,
    focus,
    hotkey,
  )
  const rows = [row1]
  if (lp.agentRows >= 2) rows.push(fitLine([sp('  ↳ ', 'dim'), ...taskSpans(d, c)], cw))
  if (lp.agentRows >= 3 && lp.activityRow) {
    const a = r.activity
    const tone: Tone = a.kind === 'denied' ? 'bad' : a.kind === 'starting' ? 'dim' : 'text'
    rows.push(spreadLine([sp('    '), sp(a.text, tone)], a.ctxPct === null ? [] : [sp(`ctx ${a.ctxPct}%`, 'dim')], cw))
  }
  return rows
}

/** The details block under an agent's row (spec 4.6): its task, model and counts, its last tool and a refusal. */
export function detailLines(c: AgentCard, cw: number): Line[] {
  const width = Math.max(0, cw - 4)
  const bar = sp('  ┆ ', 'dim')
  const rows: Line[] = wrap(c.description, width, 3).map(text => fitLine([bar, sp(text, 'text')], cw))
  const status = statusOfCard(c)
  const last = lastRound(c)
  rows.push(fitLine([bar, sp(`${modelText(c, true) || 'model unknown'} · ${plural(c.steps, 'step')} · ${fmtTokens(c.output)} out`, 'dim')], cw))
  if (c.lastTool !== '') rows.push(fitLine([bar, sp(`· ${c.lastTool}`, 'text')], cw))
  if (c.denied !== '') rows.push(fitLine([bar, sp(`✗ denied ${c.denied}`, 'bad')], cw))
  if (status === 'failed') rows.push(fitLine([bar, sp(`✗ failed · ${last?.failure ?? 'error'}`, 'bad')], cw))
  else if (status === 'stopped') rows.push(fitLine([bar, sp('■ stopped', 'dim')], cw))
  return rows.slice(0, 10)
}

export type Focus = { isFocused: boolean; openId: string | null }

export type RunningOptions = {
  /** Live agents shown; the rest become `+N more running` (level 7). */
  maxRunning: number
  showFinishedInline: boolean
  showLoops: boolean
  focus: Focus | null
  /** Hotkeys by agent id, in display order. */
  hotkeys: ReadonlyMap<string, string>
}

const loopsText = (loops: readonly Loop[], now: number): string | null => {
  const sum = loopSummary(loops, now)
  return sum === null ? null : `⋯ ${plural(sum.total, 'loop')} · ${sum.active} active (workflow agents, forks)`
}

export function runningCard(d: Derived, cw: number, lp: LevelPlan, nar: NarrowPlan, o: RunningOptions): CardModel {
  const running = need(d.running)
  const rows: Line[] = []
  const press: Press[] = []
  const shown = running.slice(0, Math.max(0, o.maxRunning))
  for (const r of shown) {
    const hotkey = o.hotkeys.get(r.card.id)
    if (hotkey && o.focus?.isFocused) press.push({ row: rows.length, id: r.card.id, hotkey })
    rows.push(...agentLines(d, r, cw, lp, nar, o.focus, hotkey))
    if (o.focus?.openId === r.card.id) rows.push(...detailLines(r.card, cw))
  }
  const hidden = running.length - shown.length
  if (hidden > 0) rows.push(fitLine([sp(`+${hidden} more running`, 'dim')], cw))
  if (running.length === 0) {
    rows.push(fitLine([sp(runningEmptyText(d.s.agents, d.s.now), 'dim')], cw))
  }
  if (lp.finished === 'inline' && o.showFinishedInline) {
    const inline = finishedInline(finishedRows(d.s.agents, { planned: () => 0 }))
    if (inline) rows.push(fitLine([sp(inline, 'dim')], cw))
  }
  const loops = o.showLoops ? loopsText(d.s.loops, d.s.now) : null
  if (loops) rows.push(fitLine([sp(loops, 'dim')], cw))
  if (o.focus?.isFocused && o.hotkeys.size > 0) rows.push(fitLine([sp('1-9 details (again to close)', 'dim')], cw))
  const n = running.length
  return { ...card('running', `Agents · running${n > 0 ? ` ${n}` : ''}`, rows, n > 0), ...(press.length ? { press } : {}) }
}

// ------------------------------------------------------------------ Review

export function reviewCard(d: Derived, cw: number, lp: LevelPlan): CardModel | null {
  const consults = d.s.consults
  if (consults.length === 0) return null
  const now = d.s.now
  const rows = newestConsults(consults, lp.reviewRows).map(c => {
    const running = c.endAt === null
    const glyph = running
      ? sp(`${CONSULTING_GLYPH} `, 'role', { role: 'architect' })
      : c.verdict
        ? sp(`${VERDICT_GLYPH[c.verdict]} `, c.verdict === 'Approve' ? 'ok' : c.verdict === 'Fixes' ? 'warn' : 'bad')
        : sp(`${UNCLASSIFIED_GLYPH} `, 'dim')
    const text = running
      ? sp(consultingText(c, now), 'text')
      : c.line === ''
        ? sp('ended without an answer', 'dim')
        : sp(c.line, 'text')
    return fitLine([glyph, sp(`${fmtClock(c.at)} `, 'dim'), sp(`${fit(c.who, 12)} `, 'role', { role: 'architect' }), text], cw)
  })
  return card('review', `Review ${consults.length}`, rows, consults.some(c => c.endAt === null))
}

// ------------------------------------------------------------------ Agents · finished

export function finishedCard(d: Derived, cw: number, nar: NarrowPlan, o: { focus: Focus | null; hotkeys: ReadonlyMap<string, string> }): CardModel | null {
  const finished = need(d.finished)
  if (finished.length === 0) return null
  const extra = extraOf(cw)
  const withModel = extra >= 10
  const stripWidth = nar.finishedStrip ? 9 : 0
  const rows: Line[] = []
  const press: Press[] = []
  for (const row of finished.slice(0, FINISHED_MAX)) {
    const role = typeInfo(row.type).role
    const tone: Tone = row.status === 'done' ? 'ok' : row.status === 'failed' ? 'bad' : 'dim'
    const id = latestOf(d.s.agents, row.type)
    const hotkey = id ? o.hotkeys.get(id) : undefined
    if (id && hotkey && o.focus?.isFocused) press.push({ row: rows.length, id, hotkey })
    rows.push(
      keyedRow(
        [
          sp(`${row.glyph} `, tone),
          sp(`${fit(row.name, 12)} `, 'role', { role }),
          ...(withModel ? [sp(`${fit(prettyModel(row.model), 10)} `, 'dim')] : []),
          ...jobSpans(row.strip, stripWidth, role),
          sp(`${fit(row.duration, 5, 'right')} `, 'dim'),
          sp(row.task, row.status === 'failed' ? 'bad' : row.status === 'stopped' ? 'dim' : 'text'),
        ],
        cw,
        o.focus,
        hotkey,
      ),
    )
    if (id && o.focus?.openId === id) {
      const c = d.s.agents.find(a => a.id === id)
      if (c) rows.push(...detailLines(c, cw))
    }
  }
  const more = finished.length - FINISHED_MAX
  if (more > 0) rows.push(fitLine([sp(`+${more} more type${more === 1 ? '' : 's'}`, 'dim')], cw))
  return { ...card('finished', `Agents · finished ${finished.length}`, rows), ...(press.length ? { press } : {}) }
}

/** The id of the latest card of a type. */
export function latestOf(agents: readonly AgentCard[], type: string): string | null {
  const cards = agents.filter(a => a.type === type).sort((a, b) => b.spawnedAt - a.spawnedAt)
  return cards[0]?.id ?? null
}

// ------------------------------------------------------------------ Last 15 minutes

function laneSpans(lane: Lane): Span[] {
  const role: Role = lane.isLead ? 'lead' : typeInfo(lane.key).role
  return lane.cells.map(cell =>
    cell === 'idle'
      ? sp(LANE_GLYPH.idle, 'faint')
      : cell === 'failed'
        ? sp(LANE_GLYPH.failed, 'bad')
        : sp(LANE_GLYPH[cell], 'role', { role, ...(cell === 'running' ? { bold: true } : {}) }),
  )
}

export function timelineCard(d: Derived, cw: number): CardModel | null {
  if (d.s.agents.length + d.s.consults.length === 0) return null
  const lanes = timelineLanes(d.s.agents, d.s.consults, d.s.session, d.s.now)
  // Narrow: the stats column goes before the names are cut below 8 cells.
  const withStats = cw - 31 - 9 >= 8
  const label = Math.max(1, Math.min(12, cw - 31 - (withStats ? 9 : 0)))
  const rows = lanes.map(lane => {
    const role: Role = lane.isLead ? 'lead' : typeInfo(lane.key).role
    const stats = withStats ? [sp(' '), sp(laneStats(lane), 'dim')] : []
    return fitLine([sp(`${fit(lane.name, label)} `, 'role', { role }), ...laneSpans(lane), ...stats], cw)
  })
  rows.push(fitLine([sp(' '.repeat(label + 1)), sp(timelineAxis(), 'dim')], cw))
  return { ...card('timeline', 'Last 15 minutes', rows), lanes }
}

// ------------------------------------------------------------------ Log

const AMBER_WHO = new Set(['you', 'lead', 'plan'])

export function logCard(d: Derived, cw: number, lp: LevelPlan): CardModel | null {
  if (lp.logRows <= 0) return null
  const lines = d.s.log.slice(-lp.logRows)
  if (lines.length === 0) return card('log', 'Log', [fitLine([sp('Nothing logged yet.', 'dim')], cw)])
  const rows = lines.map(line => {
    const who = AMBER_WHO.has(line.who)
      ? sp(`${fit(line.who, 12)} `, 'warn')
      : sp(`${fit(line.who, 12)} `, 'role', { role: line.type ? roleOf(line.type) : 'other' })
    const tone: Tone = line.kind === 'failed' || line.kind === 'deny' ? 'bad' : line.kind === 'stopped' ? 'dim' : 'text'
    return fitLine([sp(`${fmtClockSeconds(line.at)} `, 'dim'), who, sp(line.text, tone)], cw)
  })
  return card('log', 'Log', rows)
}
