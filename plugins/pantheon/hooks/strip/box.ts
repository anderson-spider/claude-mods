// The strip's rounded box, in the style of flightdeck's mini box: a session row, the 5h and 7d
// quota rows and a last-turn (or running agents) row. Quota bars and tones are hud's; the box,
// the projection and the receipt are new for pantheon. Every width is counted in terminal cells
// (theme.ts), because glyphs such as ⚡ take two.
import { cellWidth, OK } from '../theme'
import { contextData } from './context'
import { infoData, modelLabel } from './info'
import { cacheState } from './cache'
import { limitData, gaugeOf, sortLimits } from './limits'
import { BAR_CELLS, PACE_TICK, TERM_PACE, TERM_TONES, TERM_TRACK, TEXT_CELLS, ctxBand } from './constants'
import { project, recentRate } from './pace'
import type { Projection } from './pace'
import { turnData } from './receipt'
import { agentsRow } from './agents'
import type { AgentView } from './agents'
import { DIM, TEXT, dot, fit, padRuns, run, width } from './runs'
import type { Part, Run } from './runs'

export type BoxInput = { columns: number; now: number; isWorking: boolean; agents: AgentView[]; /** 'desktop' draws a native border and per-column boxes instead of glyph edges and space padding. */ surface?: string }

/** One column of a quota row: `w` cells wide when set (padded on the terminal, a Box on desktop), else as is. */
type Col = { runs: Run[]; w?: number }
/** A body row: plain runs, or quota columns. */
type Row = { runs: Run[] } | { cols: Col[] }
const flat = (row: Row): Run[] => ('cols' in row ? row.cols.flatMap(c => (c.w ? padRuns(c.runs, c.w) : c.runs)) : row.runs)

const BORDER = '#4b5468'
const ACCENT = '#E08A5B'
const AMBER = TERM_TONES.fast
const FAST = '#e5c07b'
const ALERT = TERM_TONES.alert
const CALM = TERM_TONES.calm
/** The quota bar is 10 cells plus the clock mark, at every width. */
const BAR_WIDTH = TEXT_CELLS + 1

// ---------- helpers ----------

const kfmt = (n: number): string => (n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : n >= 1e5 ? `${Math.round(n / 1e3)}k` : n >= 1e3 ? `${+(n / 1e3).toFixed(1)}k` : `${n}`)

/** 40m, 2h01, 3d13h: a span in milliseconds, short enough for a projection. */
export function compactSpan(ms: number): string {
  const m = Math.max(1, Math.round(ms / 60_000))
  if (m < 60) return `${m}m`
  if (m < 1440) return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`
  return `${Math.floor(m / 1440)}d${Math.floor((m % 1440) / 60)}h`
}

const turnDuration = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`
}

const usdText = (usd: number): string => (usd >= 100 ? `$${Math.round(usd)}` : `$${usd.toFixed(2)}`)

// ---------- row 1: the session ----------

function cacheParts(input: BoxInput): Part[] {
  const parts: Part[] = []
  const cache = cacheState(input.now)
  if (cache) {
    const t = cache.time
    const lead = run('cache ', TEXT)
    if (t.tone === 'alert') {
      const detail = [t.detail, t.advice].filter(Boolean)
      const full = [lead, run(t.value, ALERT, { bold: true }), ...detail.flatMap(d => [dot(), run(d, DIM)])]
      parts.push({ runs: full, drop: 45, keep: true, alt: [lead, run(t.value, ALERT, { bold: true })] })
    } else if (t.tone === 'none') {
      parts.push({ runs: [lead, run(t.value, DIM)], drop: 6 })
    } else {
      const time = [lead, run(t.value, t.urgent ? AMBER : undefined, { bold: true }), ...(t.stake ? [run(` ${t.stake}`, DIM)] : [])]
      const hit = cache.hit
      const withHit = hit ? [...time, run(` ${hit.value}`, hit.tone === 'fast' ? AMBER : DIM), ...(hit.detail ? [run(` ${hit.detail}`, DIM)] : [])] : time
      parts.push({ runs: withHit, drop: 6, alt: [lead, run(t.value, t.urgent ? AMBER : undefined, { bold: true })] })
      if (t.ttlLabel) parts.push({ runs: [run(t.ttlLabel, DIM)], drop: 0 })
    }
  }
  return parts
}

function tailParts(): Part[] {
  const cur = infoData.current
  const dirty = cur.files > 0
  const branchRuns = (text: string) => [run(dirty ? `${text}*` : text, dirty ? ALERT : CALM)]
  const parts: Part[] = []
  if (cur.dir || cur.branch) {
    const branch = cur.branch ? branchRuns(cur.branch) : []
    const wt = cur.branch && cur.worktree ? [run(' ⎇wt', DIM)] : []
    parts.push({ runs: [...(cur.dir ? [run(cur.dir, DIM), run(cur.branch ? ' ' : '')] : []), ...branch, ...wt], drop: 3, alt: branch.length > 0 ? branch : undefined })
  }
  if (dirty && cur.branch) parts.push({ runs: cur.added || cur.removed ? [run(`+${cur.added}`, CALM), run(' '), run(`-${cur.removed}`, ALERT)] : [run(`${cur.files} ${cur.files === 1 ? 'file' : 'files'}`, DIM)], drop: 2 })
  if (cur.speed === 'fast') parts.push({ runs: [run('⚡fast', FAST)], drop: 1 })
  return parts
}

function sessionRow(input: BoxInput, room: number): Run[] {
  const cur = infoData.current
  const parts: Part[] = []
  if (cur.model) {
    parts.push({ runs: [run(modelLabel(cur.model), ACCENT, { bold: true }), ...(cur.effort ? [run(`·${cur.effort}`, DIM)] : [])], drop: 50, keep: true, alt: [run(modelLabel(cur.model), ACCENT, { bold: true })] })
  }
  const status = input.isWorking ? [run('●', OK), run(' working', OK, { bold: true })] : [run('○', DIM), run(' idle', DIM)]
  parts.push({ runs: status, drop: 5, alt: [status[0]] })
  const last = contextData.readings[contextData.readings.length - 1]
  if (last) {
    const band = ctxBand(Math.round(last.percent))
    const on = Math.round(last.percent / 20)
    const label = run('ctx ', TEXT)
    const pct = run(`  ${Math.round(last.percent)}%`, band.term, { bold: true })
    parts.push({ runs: [label, run('▰'.repeat(on), band.term), run('▱'.repeat(5 - on), TERM_TRACK), pct], drop: 40, keep: true, alt: [label, run(`${Math.round(last.percent)}%`, band.term, { bold: true })] })
  }
  parts.push(...cacheParts(input))
  if (turnData.usd !== null) parts.push({ runs: [run(usdText(turnData.usd), TEXT)], drop: 4 })
  parts.push(...tailParts())
  return fit(parts, room)
}

// ---------- rows 2 and 3: the quota windows ----------

type Gauge = ReturnType<typeof gaugeOf> & { projection: Projection | null }

function quotaBar(g: Gauge): Run[] {
  const cells = (pct: number) => Math.round((pct / 100) * TEXT_CELLS)
  const used = g.used > 0 ? Math.max(1, cells(Math.min(g.used, 100))) : 0
  const clock = g.elapsed === null ? used : cells(g.elapsed)
  const over = TERM_TONES[g.tone]
  const out: Run[] = []
  for (let i = 0; i < TEXT_CELLS; i++) {
    if (g.elapsed !== null && i === clock) out.push(run(PACE_TICK, TERM_PACE))
    if (i < Math.min(used, clock)) out.push(run(BAR_CELLS.used, CALM))
    else if (i < used) out.push(run(BAR_CELLS.over, over))
    else if (i < clock) out.push(run(BAR_CELLS.slack, CALM, { dim: true }))
    else out.push(run(BAR_CELLS.rest, TERM_TRACK))
  }
  if (g.elapsed !== null && clock >= TEXT_CELLS) out.push(run(PACE_TICK, TERM_PACE))
  return g.elapsed === null ? [...out, run(' ')] : out
}

function projectionRuns(g: Gauge): Run[] {
  const p = g.projection
  if (!p) return []
  if (p.kind === 'full') {
    const color = p.hot || g.tone === 'alert' ? ALERT : AMBER
    return p.hot
      ? [run('at recent pace: ', DIM), run(`100% in ${compactSpan(p.inMs)}`, color, { bold: true }), run(' ↯', ALERT, { bold: true })]
      : [run('at this pace: ', DIM), run(`100% in ${compactSpan(p.inMs)}`, color, { bold: true })]
  }
  return [run('at this pace: ', DIM), run(`~${p.pct}% at reset`, p.pct >= 85 ? AMBER : CALM)]
}

/** The windows to draw (an expired one is hidden), at most two rows. */
function gaugesOf(now: number): Gauge[] {
  const live = limitData.reading.list.filter(l => !(Date.parse(l.resetsAt ?? '') <= now))
  return sortLimits(live).slice(0, 2).map(l => {
    const g = gaugeOf(l, now)
    const recent = recentRate(limitData.history[l.kind]?.points, now, g.used)
    return { ...g, projection: project(g.used, g.span, g.left, recent) }
  })
}

/**
 * The quota rows, columns lined up: label, the 10-cell bar with its clock mark, the percentage, the
 * pace mark and the time left (each padded to the widest of the rows), then the projection. A row
 * too wide gives up the projection first, then the bar, then the time left, for every row at once.
 */
function quotaRows(gauges: Gauge[], room: number): Row[] {
  if (gauges.length === 0) return []
  const pctW = Math.max(3, ...gauges.map(g => cellWidth(g.value)))
  const markW = Math.max(3, ...gauges.map(g => cellWidth(g.mark)))
  const leftW = Math.max(6, ...gauges.map(g => cellWidth(g.when)))
  const labelW = Math.max(...gauges.map(g => cellWidth(g.label)))
  const build = (g: Gauge, { bar, left, proj }: { bar: boolean; left: boolean; proj: boolean }): Row => {
    const cols: Col[] = [{ runs: [run(g.label, DIM)], w: labelW }, { runs: [run(' ')] }]
    if (bar) cols.push({ runs: quotaBar(g), w: BAR_WIDTH }, { runs: [run(' ')] })
    cols.push({ runs: [run(g.value, g.tone === 'alert' ? ALERT : undefined, { bold: true })], w: pctW })
    cols.push({ runs: [run(' ')] }, { runs: g.mark ? [run(g.mark, g.mark.startsWith('▼') ? CALM : TERM_TONES[g.tone], { bold: true })] : [], w: markW })
    if (left && g.when) cols.push({ runs: [dot()] }, { runs: [run(g.when, DIM)], w: leftW })
    const extra = proj ? projectionRuns(g) : []
    if (extra.length > 0) cols.push({ runs: [dot()] }, { runs: extra })
    return { cols }
  }
  const variants = [{ bar: true, left: true, proj: true }, { bar: true, left: true, proj: false }, { bar: false, left: true, proj: false }, { bar: false, left: false, proj: false }]
  for (const v of variants) {
    const rows = gauges.map(g => build(g, v))
    if (rows.every(r => width(flat(r)) <= room)) return rows
  }
  return gauges.map(g => build(g, variants[variants.length - 1]))
}

// ---------- row 4: the last turn, or the agents running ----------

function receiptRow(room: number): Run[] {
  const t = turnData.last
  if (!t) return []
  const parts: Part[] = [
    { runs: [run('last turn ', DIM), run(turnDuration(t.ms), TEXT)], drop: 50, keep: true, alt: [run('last ', DIM), run(turnDuration(t.ms), TEXT)] },
    { runs: [run(`${t.agents} agent${t.agents === 1 ? '' : 's'}`, t.agents ? '#A56BD8' : DIM)], drop: 2, alt: [run(`${t.agents} ag`, t.agents ? '#A56BD8' : DIM)] },
    { runs: [run(`${t.edits} edit${t.edits === 1 ? '' : 's'}`, DIM)], drop: 1 },
    { runs: [run(`${t.errors} error${t.errors === 1 ? '' : 's'}`, t.errors ? ALERT : DIM)], drop: t.errors ? 3 : 0, alt: [run(`${t.errors} err`, t.errors ? ALERT : DIM)] },
    { runs: t.usd !== null ? [run(`+${usdText(t.usd)}`, TEXT, { bold: true })] : [run(`+${kfmt(t.ctx)} ctx`, DIM)], drop: 60, keep: true },
  ]
  return fit(parts, room)
}

// ---------- the box ----------

/** The body rows (session, quotas, last turn or agents) for `inner` cells; empty when there is nothing to show. */
function bodyRows(input: BoxInput, inner: number): Row[] {
  const { now } = input
  const gauges = gaugesOf(now)
  const cur = infoData.current
  const hasContent = Boolean(cur.model) || contextData.readings.length > 0 || gauges.length > 0 || turnData.last !== null || turnData.usd !== null || input.agents.length > 0
  if (!hasContent) return []
  const body: Row[] = []
  const session = sessionRow(input, inner)
  if (session.length > 0) body.push({ runs: session })
  body.push(...quotaRows(gauges, inner))
  const last = input.agents.length > 0 ? agentsRow(input.agents, inner, now) : receiptRow(inner)
  if (last.length > 0) body.push({ runs: last })
  return body
}

/** The box as rows of runs, every row exactly `columns` cells wide; empty when there is nothing to show. */
export function boxLines(input: BoxInput): Run[][] {
  const { columns } = input
  const inner = columns - 4
  const body = bodyRows(input, inner)
  if (body.length === 0) return []
  const edge = (text: string): Run => run(text, BORDER)
  return [
    [edge(`╭${'─'.repeat(columns - 2)}╮`)],
    ...body.map(row => [edge('│'), run(' '), ...padRuns(flat(row), inner), run(' '), edge('│')]),
    [edge(`╰${'─'.repeat(columns - 2)}╯`)],
  ]
}

const textOf = (Text: any, part: Run, k: number) => Text({
  key: `t${k}`,
  ...(part.color ? { color: part.color } : {}),
  ...(part.dim ? { dimColor: true } : {}),
  ...(part.bold ? { bold: true } : {}),
  children: part.text,
})

/** The box as an element tree, or null when there is nothing to show. */
export function drawBox(elements: any, input: BoxInput): unknown {
  const { Box, Text } = elements
  if (input.surface === 'desktop') return drawDesktopBox(elements, input)
  const lines = boxLines(input)
  if (lines.length === 0) return null
  return Box({
    key: 'strip',
    flexDirection: 'column',
    children: lines.map((row, r) => Box({
      key: `strip-r${r}`,
      flexDirection: 'row',
      children: row.map((part, k) => textOf(Text, part, k)),
    })),
  })
}

// ---------- desktop: three rows, bars drawn as Svg ----------

const COL_PX = 8
const DESK_TONE = { calm: '#4fb383', fast: '#e5c07b', alert: '#e06c75' } as const
const DESK_TRACK = '#34383f'
const DESK_RULE = '#2c3038'
const DESK_TICK = '#e6e6e6'
const DESK_MIN_SIDE_BY_SIDE = 66
const svgDoc = (w: number, h: number, body: string) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${body}</svg>`

/** A rounded quota or context bar: track, fill from the left and, when `tick` is set, the elapsed-time mark. */
export function barSource(px: number, used: number, color: string, tick: number | null): string {
  const fill = Math.max(0, Math.min(100, used)) / 100 * px
  return svgDoc(px, 12,
    `<rect x="0" y="3" width="${px}" height="6" rx="3" fill="${DESK_TRACK}"/>`
    + (fill > 0 ? `<rect x="0" y="3" width="${Math.max(3, fill).toFixed(1)}" height="6" rx="3" fill="${color}"/>` : '')
    + (tick === null ? '' : `<rect x="${Math.min(px - 1.5, Math.max(0, (tick / 100) * px - 0.75)).toFixed(1)}" y="0" width="1.5" height="12" fill="${DESK_TICK}"/>`))
}

const PULSE = (color: string) => svgDoc(10, 10,
  `<circle cx="5" cy="5" r="3" fill="${color}"/><circle cx="5" cy="5" r="3" fill="none" stroke="${color}" stroke-width="1"><animate attributeName="r" values="3;5" dur="1.4s" repeatCount="indefinite"/><animate attributeName="opacity" values="0.6;0" dur="1.4s" repeatCount="indefinite"/></circle>`)
const RING = (color: string) => svgDoc(8, 8, `<circle cx="4" cy="4" r="3" fill="none" stroke="${color}" stroke-width="1.5"/>`)

/** The projection under a bar, shorter than the terminal's: the label above it already says what it is. */
function deskProjection(g: Gauge): Run[] {
  const p = g.projection
  if (!p) return []
  if (p.kind === 'full') return p.hot ? [run(`100% in ${compactSpan(p.inMs)} ↯`, ALERT, { bold: true })] : [run(`100% in ${compactSpan(p.inMs)}`, p.hot || g.tone === 'alert' ? ALERT : AMBER)]
  return [run(`~${p.pct}% at reset`, p.pct >= 85 ? AMBER : CALM)]
}

/** One piece of the session row; `drop` and `keep` work as in `Part`. */
type Item = { cells: number; drop: number; keep?: boolean; node: unknown; alt?: { cells: number; node: unknown } }

function fitItems(items: Item[], room: number, gap: number): Item[] {
  const list = items.map(i => ({ ...i }))
  const total = () => list.reduce((n, i, k) => n + i.cells + (k ? gap : 0), 0)
  while (total() > room) {
    const cand = list.filter(i => i.alt || !i.keep).sort((a, b) => a.drop - b.drop)[0]
    if (!cand) break
    if (cand.alt) { cand.cells = cand.alt.cells; cand.node = cand.alt.node; cand.alt = undefined } else list.splice(list.indexOf(cand), 1)
  }
  return list
}

function drawDesktopBox(elements: any, input: BoxInput): unknown {
  const { Box, Text, Svg } = elements
  const inner = input.columns - 4
  const { now } = input
  const gauges = gaugesOf(now)
  const cur = infoData.current
  const hasContent = Boolean(cur.model) || contextData.readings.length > 0 || gauges.length > 0 || turnData.last !== null || turnData.usd !== null || input.agents.length > 0
  if (!hasContent) return null
  const runsBox = (key: string, runs: Run[]) => Box({ key, flexShrink: 0, children: runs.map((part, j) => textOf(Text, part, j)) })
  const image = (key: string, source: string, w: number, h: number, alt: string, isInteractive = false) => Svg({ key, source, width: w, height: h, alt, ...(isInteractive ? { isInteractive: true } : {}) })
  // A fixed-width cell for an Svg: the picture is in CSS px, the Box in cells.
  const slot = (key: string, cells: number, child: unknown) => Box({ key, width: cells, flexShrink: 0, alignItems: 'center', children: [child] })
  const cellsOf = (px: number) => Math.ceil(px / COL_PX)

  // ---- row 1: the session
  const items: Item[] = []
  const status = input.isWorking
    ? { cells: 11, node: Box({ key: 's-state', flexShrink: 0, alignItems: 'center', gap: 0.5, children: [Svg ? slot('s-dot', 1.5, image('s-dot-i', PULSE(DESK_TONE.calm), 10, 10, 'working', true)) : textOf(Text, run('●', DESK_TONE.calm), 0), textOf(Text, run('working', DESK_TONE.calm, { bold: true }), 1)] }) }
    : { cells: 7, node: Box({ key: 's-state', flexShrink: 0, alignItems: 'center', gap: 0.5, children: [Svg ? slot('s-dot', 1.5, image('s-dot-i', RING(DIM), 8, 8, 'idle')) : textOf(Text, run('○', DIM), 0), textOf(Text, run('idle', DIM), 1)] }) }
  const dotOnly = Svg ? slot('s-dot', 1.5, image('s-dot-i', input.isWorking ? PULSE(DESK_TONE.calm) : RING(DIM), input.isWorking ? 10 : 8, input.isWorking ? 10 : 8, input.isWorking ? 'working' : 'idle', input.isWorking)) : textOf(Text, run(input.isWorking ? '●' : '○', input.isWorking ? DESK_TONE.calm : DIM), 0)
  items.push({ ...status, drop: 5, alt: { cells: 2, node: dotOnly } })
  if (cur.model) {
    const label = run(modelLabel(cur.model), ACCENT, { bold: true })
    items.push({ cells: width([label]) + (cur.effort ? cellWidth(`·${cur.effort}`) : 0), drop: 50, keep: true, node: runsBox('s-model', [label, ...(cur.effort ? [run(` · ${cur.effort}`, DIM)] : [])]), alt: { cells: width([label]), node: runsBox('s-model', [label]) } })
  }
  const last = contextData.readings[contextData.readings.length - 1]
  if (last) {
    const pct = Math.round(last.percent)
    const band = ctxBand(pct)
    const pctRun = run(`${pct}%`, band.term, { bold: true })
    const bar = Svg ? slot('s-ctx-bar', 7.5, image('s-ctx-bar-i', barSource(56, pct, band.term, null), 56, 12, `context ${pct}%`)) : null
    items.push({
      cells: 3 + (bar ? 8 : 0) + 4, drop: 40, keep: true,
      node: Box({ key: 's-ctx', flexShrink: 0, alignItems: 'center', gap: 0.5, children: [textOf(Text, run('ctx', DIM), 0), ...(bar ? [bar] : []), textOf(Text, pctRun, 2)] }),
      alt: { cells: 8, node: Box({ key: 's-ctx', flexShrink: 0, alignItems: 'center', gap: 0.5, children: [textOf(Text, run('ctx', DIM), 0), textOf(Text, pctRun, 2)] }) },
    })
  }
  cacheParts(input).forEach((p, k) => items.push({ cells: width(p.runs), drop: p.drop, keep: p.keep, node: runsBox(`s-cache${k}`, p.runs), ...(p.alt ? { alt: { cells: width(p.alt), node: runsBox(`s-cache${k}`, p.alt) } } : {}) }))
  tailParts().forEach((p, k) => items.push({ cells: width(p.runs), drop: p.drop, keep: p.keep, node: runsBox(`s-tail${k}`, p.runs), ...(p.alt ? { alt: { cells: width(p.alt), node: runsBox(`s-tail${k}`, p.alt) } } : {}) }))
  const cost = turnData.usd !== null ? [run(usdText(turnData.usd), TEXT, { bold: true })] : []
  const costCells = cost.length ? width(cost) + 2 : 0
  const shown = fitItems(items, inner - costCells, 2)
  const sessionRowNode = Box({
    key: 'strip-r0', flexDirection: 'row', alignItems: 'center', width: inner, gap: 2,
    children: [...shown.map(i => i.node), ...(cost.length ? [Box({ key: 's-spacer', flexGrow: 1 }), runsBox('s-cost', cost)] : [])],
  })

  // ---- row 2: the quota windows, side by side (stacked when narrow)
  const stacked = inner < DESK_MIN_SIDE_BY_SIDE
  const colCells = stacked ? inner : Math.floor((inner - 3) / 2)
  const labelCells = Math.max(2, ...gauges.map(g => cellWidth(g.label))) + 1
  const gaugeNode = (g: Gauge, k: number) => {
    const tone = DESK_TONE[g.tone]
    const markRun = g.mark ? run(g.mark, g.mark.startsWith('▼') ? DESK_TONE.calm : tone, { bold: true }) : null
    const pctCells = 4
    const markCells = 4
    const barCells = colCells - labelCells - pctCells - markCells - 1.5
    const bar = Svg && barCells >= 4 ? slot(`g${k}-bar`, barCells, image(`g${k}-bar-i`, barSource(Math.floor(barCells * COL_PX), g.used, tone, g.elapsed), Math.floor(barCells * COL_PX), 12, `${g.label} ${g.value} used`)) : Box({ key: `g${k}-bar`, flexGrow: 1 })
    const top = Box({
      key: `g${k}-top`, width: colCells, flexDirection: 'row', alignItems: 'center', gap: 0.5,
      children: [
        Box({ key: `g${k}-label`, width: labelCells, flexShrink: 0, children: [textOf(Text, run(g.label, DIM), 0)] }),
        bar,
        Box({ key: `g${k}-pct`, width: pctCells, flexShrink: 0, justifyContent: 'flex-end', children: [textOf(Text, run(g.value, g.tone === 'alert' ? ALERT : TEXT, { bold: true }), 0)] }),
        Box({ key: `g${k}-mark`, width: markCells, flexShrink: 0, children: markRun ? [textOf(Text, markRun, 0)] : [] }),
      ],
    })
    const proj = deskProjection(g)
    const detail = [...(g.when ? [run(`${g.when} left`, DIM)] : []), ...(g.when && proj.length ? [run(' · ', DIM)] : []), ...proj]
    return Box({
      key: `strip-g${k}`, flexDirection: 'column', width: colCells, flexShrink: 0,
      children: [top, ...(detail.length ? [Box({ key: `g${k}-detail`, width: colCells, marginLeft: labelCells, children: detail.map((part, j) => textOf(Text, part, j)) })] : [])],
    })
  }
  const quota = gauges.length === 0 ? [] : [Box({
    key: 'strip-r1', flexDirection: stacked ? 'column' : 'row', width: inner, gap: stacked ? 0.4 : 3,
    children: gauges.map(gaugeNode),
  })]

  // ---- row 3: the last turn, or the agents running
  const tail = input.agents.length > 0 ? agentsRow(input.agents, inner, now) : receiptRow(inner)
  const rule = Svg && tail.length > 0 ? [image('strip-rule', svgDoc(inner * COL_PX, 1, `<path d="M0 .5H${inner * COL_PX}" stroke="${DESK_RULE}"/>`), inner * COL_PX, 1, 'divider')] : []
  const last3 = tail.length > 0 ? [Box({ key: 'strip-r2', flexDirection: 'row', width: inner, children: tail.map((part, k) => textOf(Text, part, k)) })] : []

  return Box({
    key: 'strip',
    flexDirection: 'column',
    borderStyle: 'round',
    borderColor: BORDER,
    paddingX: 1,
    gap: 0.4,
    children: [...(shown.length ? [sessionRowNode] : []), ...quota, ...rule, ...last3],
  })
}
