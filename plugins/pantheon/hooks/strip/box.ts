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

export type BoxInput = { columns: number; now: number; isWorking: boolean; agents: AgentView[] }

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

function sessionRow(input: BoxInput, room: number): Run[] {
  const cur = infoData.current
  const dirty = cur.files > 0
  const branchRuns = (text: string) => [run(dirty ? `${text}*` : text, dirty ? ALERT : CALM)]
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
    const pct = run(` ${Math.round(last.percent)}%`, band.term, { bold: true })
    parts.push({ runs: [label, run('▰'.repeat(on), band.term), run('▱'.repeat(5 - on), TERM_TRACK), pct], drop: 40, keep: true, alt: [label, run(`${Math.round(last.percent)}%`, band.term, { bold: true })] })
  }
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
  if (turnData.usd !== null) parts.push({ runs: [run(usdText(turnData.usd), TEXT)], drop: 4 })
  if (cur.dir || cur.branch) {
    const branch = cur.branch ? branchRuns(cur.branch) : []
    const wt = cur.branch && cur.worktree ? [run(' ⎇wt', DIM)] : []
    parts.push({ runs: [...(cur.dir ? [run(cur.dir, DIM), run(cur.branch ? ' ' : '')] : []), ...branch, ...wt], drop: 3, alt: branch.length > 0 ? branch : undefined })
  }
  if (dirty && cur.branch) parts.push({ runs: cur.added || cur.removed ? [run(`+${cur.added}`, CALM), run(' '), run(`-${cur.removed}`, ALERT)] : [run(`${cur.files} ${cur.files === 1 ? 'file' : 'files'}`, DIM)], drop: 2 })
  if (cur.speed === 'fast') parts.push({ runs: [run('⚡fast', FAST)], drop: 1 })
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
      ? [run('↯', ALERT, { bold: true }), run('at recent pace: ', DIM), run(`100% in ${compactSpan(p.inMs)}`, color, { bold: true })]
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
function quotaRows(gauges: Gauge[], room: number): Run[][] {
  if (gauges.length === 0) return []
  const pctW = Math.max(3, ...gauges.map(g => cellWidth(g.value)))
  const markW = Math.max(3, ...gauges.map(g => cellWidth(g.mark)))
  const leftW = Math.max(6, ...gauges.map(g => cellWidth(g.when)))
  const labelW = Math.max(...gauges.map(g => cellWidth(g.label)))
  const build = (g: Gauge, { bar, left, proj }: { bar: boolean; left: boolean; proj: boolean }): Run[] => {
    const out: Run[] = [...padRuns([run(g.label, DIM)], labelW), run(' ')]
    if (bar) out.push(...quotaBar(g), run(' '))
    out.push(...padRuns([run(g.value, g.tone === 'alert' ? ALERT : undefined, { bold: true })], pctW))
    out.push(run(' '), ...padRuns(g.mark ? [run(g.mark, g.mark.startsWith('▼') ? CALM : TERM_TONES[g.tone], { bold: true })] : [], markW))
    if (left && g.when) out.push(dot(), ...padRuns([run(g.when, DIM)], leftW))
    const extra = proj ? projectionRuns(g) : []
    if (extra.length > 0) out.push(dot(), ...extra)
    return out
  }
  const variants = [{ bar: true, left: true, proj: true }, { bar: true, left: true, proj: false }, { bar: false, left: true, proj: false }, { bar: false, left: false, proj: false }]
  for (const v of variants) {
    const rows = gauges.map(g => build(g, v))
    if (rows.every(r => width(r) <= room)) return rows
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

/** The box as rows of runs, every row exactly `columns` cells wide; empty when there is nothing to show. */
export function boxLines(input: BoxInput): Run[][] {
  const { columns, now } = input
  const inner = columns - 4
  const gauges = gaugesOf(now)
  const cur = infoData.current
  const hasContent = Boolean(cur.model) || contextData.readings.length > 0 || gauges.length > 0 || turnData.last !== null || turnData.usd !== null || input.agents.length > 0
  if (!hasContent) return []
  const body: Run[][] = []
  const session = sessionRow(input, inner)
  if (session.length > 0) body.push(session)
  body.push(...quotaRows(gauges, inner))
  const last = input.agents.length > 0 ? agentsRow(input.agents, inner, now) : receiptRow(inner)
  if (last.length > 0) body.push(last)
  const edge = (text: string): Run => run(text, BORDER)
  return [
    [edge(`╭${'─'.repeat(columns - 2)}╮`)],
    ...body.map(row => [edge('│'), run(' '), ...padRuns(row, inner), run(' '), edge('│')]),
    [edge(`╰${'─'.repeat(columns - 2)}╯`)],
  ]
}

/** The box as an element tree, or null when there is nothing to show. */
export function drawBox(elements: any, input: BoxInput): unknown {
  const lines = boxLines(input)
  if (lines.length === 0) return null
  const { Box, Text } = elements
  return Box({
    key: 'strip',
    flexDirection: 'column',
    children: lines.map((row, r) => Box({
      key: `strip-r${r}`,
      flexDirection: 'row',
      children: row.map((part, k) => Text({
        key: `t${k}`,
        ...(part.color ? { color: part.color } : {}),
        ...(part.dim ? { dimColor: true } : {}),
        ...(part.bold ? { bold: true } : {}),
        children: part.text,
      })),
    })),
  })
}
