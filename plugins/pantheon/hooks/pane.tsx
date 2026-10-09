import type { Elements, RenderSurface } from 'claude-code'

import type { RailProps } from './rail.tsx'
import { ago } from './roster'
import type { Engine, Instance, Roster, RoundView, Slot, SlotName } from './roster'
import type { PingResult } from './ping'
import { BAD, BLOCK, OK, ROLE_COLOR, SECTION_COLOR, cellWidth, gauge, modelName, strip, truncCells } from './theme'
import type { StripItem } from './theme'
import type { ConfigResult, Job, PanelGroup, SessionInfo } from './types'

export const PANE_ID = 'pantheon'

const ACTIVE = new Set(['running', 'background'])

// Where a round ends: its end, `now` while it truly runs, unknown for a lost round with no end.
const endOf = (r: RoundView, now: number): number | undefined =>
  r.endedAt ?? (ACTIVE.has(r.status) ? now : undefined)

export function statusText(jobs: Job[]): string | undefined {
  const running = jobs.filter(job => job.status === 'running').length
  const background = jobs.filter(job => job.status === 'background').length
  if (!running && !background) return undefined
  return `pantheon: ${running} running · ${background} in background`
}

export function isResumable(job: Job): boolean {
  return !!job.sessionId && !ACTIVE.has(job.status)
}

export function configReport(state: ConfigResult): string {
  const lines = [state.ok ? 'Valid config.' : `Invalid config: ${state.error}`]
  lines.push(`Active profile: ${state.config.profile} (${state.ok ? state.origins.profile ?? 'default' : 'unknown origin'})`)
  lines.push('', 'Effective config:', JSON.stringify(state.config, null, 2))
  if (state.ok) {
    const origins = Object.entries(state.origins).filter(([, origin]) => origin !== 'default')
    lines.push('', 'Origin (fields not at their default):')
    lines.push(...(origins.length ? origins.map(([field, origin]) => `- ${field}: ${origin}`) : ['- every field at its default']))
  }
  return lines.join('\n')
}

export type DoctorFacts = {
  usesCodex: boolean
  profile: string
  codexVersion?: string
  loginStatus?: string
  loginOk: boolean
  config: ConfigResult
  root: string
  isRepo: boolean
  pings?: PingResult[]
}

export function doctorReport(facts: DoctorFacts): string {
  const mark = (ok: boolean) => (ok ? 'ok  ' : 'fail')
  const lines = [
    !facts.usesCodex && !facts.codexVersion
      ? `info codex on PATH — not needed by profile ${facts.profile}`
      : `${mark(!!facts.codexVersion)} codex on PATH${facts.codexVersion ? `: ${facts.codexVersion}` : ' — install the Codex CLI'}`,
    !facts.usesCodex && !facts.loginOk
      ? `info codex login status — not needed by profile ${facts.profile}`
      : `${mark(facts.loginOk)} codex login status${facts.loginStatus ? `: ${facts.loginStatus}` : ''}`,
    `${mark(facts.config.ok)} config${facts.config.ok ? '' : `: ${facts.config.error}`}`,
    `${mark(true)} authorized root: ${facts.root}${facts.isRepo ? '' : ' (outside a git repository: --skip-git-repo-check)'}`,
  ]
  if (facts.pings) {
    lines.push('', 'ping')
    for (const p of facts.pings) {
      const who = `${p.name} (${p.engine}${p.model ? ` ${p.model}` : ''})`
      lines.push(
        p.state === 'off' ? `info ${p.name} off`
          : p.state === 'pending' ? `pending ${who} — the session confirms`
          : p.state === 'ok' ? `${mark(true)} ${who}${p.ms === undefined ? '' : ` ${(p.ms / 1000).toFixed(1)}s`}`
          : `${mark(false)} ${who}${p.detail ? `: ${p.detail}` : ''}`,
      )
    }
  }
  return lines.join('\n')
}

// ---------------------------------------------------------------- drawing

type Base = Pick<Elements['terminal'], 'Box' | 'Text' | 'Button'>
export type RailBuild = (p: { key: string; width: number; props: RailProps }) => unknown
type ClockBuild = (p: {
  key: string
  width: number
  props: { since: number; now: number; endAt: number | null; color: string }
}) => unknown

/**
 * Box, Text and Button from `$.ui.resolve(e)`, Select and Svg where the surface draws them. The Client
 * builders live in register.tsx: the engine reads a Client's module path off the entry source.
 */
export type PanelElements = Base & {
  Select?: Elements['terminal']['Select']
  Svg?: Elements['desktop']['Svg']
  clock?: ClockBuild
  rail?: RailBuild
}

export type PanelData = {
  surface: RenderSurface
  placement?: string
  columns: number
  rows: number
  now: number
  roster: Roster
  jobs: Job[]
  session: SessionInfo
  profiles: string[]
  activeProfile: string
  profileLockedBy?: 'user' | 'project'
  onProfile?: (name: string) => void
  tab: 'agents' | 'jobs'
  /** Agent groups the person folded; absent means none. */
  collapsed?: PanelGroup[]
  hasClient: boolean
  /** The host clock failed: draw static durations from `now` and say so, with no Client. */
  clockLost?: boolean
  onTab: (tab: 'agents' | 'jobs') => void
  onToggle?: (group: PanelGroup) => void
  onClose?: () => void
  onCancel: (jobId: string) => void
  onCopy: (text: string, surface: RenderSurface) => void
}

export function layoutOf(surface: RenderSurface, placement?: string): 'docked' | 'mini' | 'desktop' {
  if (placement === 'inline') return 'mini'
  return surface !== 'terminal' ? 'desktop' : 'docked'
}

// Colors follow the engine of the slot or instance, never the role name.
const ENGINE_COLOR: Record<Engine | 'mixed', string> = { codex: 'suggestion', claude: 'merged', mixed: 'text' }
const RUN = 'success'
const ROUND = 'warning'
const ACTIVITY = 'cyan'
const FAULT = 'error'
// The Desktop panel is dark: this is the one place its palette lives. Role and section colors come from theme.ts.
const HEX = {
  codex: '#6aa3f0', claude: '#b58af0', mixed: '#9a9a94', codexSoft: '#1f3350', claudeSoft: '#35274f',
  ink: '#ebedf1', muted: '#b3b5ba', grid: 'rgba(127,127,127,0.22)', turn: '#4a4945', amber: '#e0a94a',
  card: '#242423', edge: '#333331', dot: '#5a5955', pill: '#32322f',
  bg: '#1b1b1a', tile: '#272726', green: '#4fb383', red: '#e5604f', track: '#35352f',
}

// Desktop text and chips use the panel's hex values instead of the theme names above.
const DESK: Record<string, string> = {
  suggestion: HEX.codex, merged: HEX.claude, success: HEX.green, warning: HEX.amber, error: HEX.red,
  inactive: HEX.muted, text: HEX.ink, inverseText: HEX.bg, cyan: '#8fb8d8',
}
const DESK_SOFT: Record<string, string> = {
  suggestion: HEX.codexSoft, merged: HEX.claudeSoft, success: '#1d3a2d', warning: '#3d3016', text: HEX.pill,
}
const DESK_PANEL = HEX.bg

// Copied from hud's visual tokens; the plugins remain independently loadable.
const HUD = {
  agents: ['rgba(196,80,127,0.11)', 'rgba(196,80,127,0.32)', '#c4507f'],
  model: ['rgba(204,120,92,0.12)', 'rgba(204,120,92,0.34)', '#cc785c'],
  context: ['rgba(47,104,192,0.10)', 'rgba(47,104,192,0.28)', '#2f68c0'],
  cost: ['rgba(184,140,40,0.13)', 'rgba(184,140,40,0.34)', '#b8892a'],
  calm: ['rgba(27,161,196,0.11)', 'rgba(27,161,196,0.30)', '#1b9cbe'],
  neutral: ['rgba(128,128,128,0.10)', 'rgba(128,128,128,0.30)', '#8a8f98'],
} as const
const ICON = {
  agents: '<rect x="4" y="7.5" width="16" height="12.5" rx="3.5"/><path d="M12 7.5V4M2 12.5v3M22 12.5v3"/><circle cx="12" cy="3.2" r="1.3"/><circle cx="9" cy="13" r="1"/><circle cx="15" cy="13" r="1"/><path d="M9.5 16.8h5"/>',
  jobs: '<rect x="4" y="6" width="16" height="14" rx="2"/><path d="M8 6V3h8v3M4 11h16M10 11v3h4v-3"/>',
  cost: '<circle cx="12" cy="12" r="9"/><path d="M15 8.5c-4-3-9 2-3 3.5s1 6-3 3.5M12 5v2M12 17v2"/>',
  tokens: '<path d="m12 3 9 5-9 5-9-5 9-5ZM3 12l9 5 9-5M3 16l9 5 9-5"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 6v6l4 2"/>',
}

// A hex color pulled toward `into`, for dimmed (planned) rows on a surface with no dim attribute.
function mix(hex: string, into: string, t: number): string {
  const n = (h: string, k: number) => parseInt(h.slice(1 + k * 2, 3 + k * 2), 16)
  const c = [0, 1, 2].map(k => Math.round(n(hex, k) * (1 - t) + n(into, k) * t))
  return `#${c.map(v => v.toString(16).padStart(2, '0')).join('')}`
}

// '#rrggbb' as rgba(), for card backplates.
const rgba = (hex: string, a: number) => `rgba(${[1, 3, 5].map(k => parseInt(hex.slice(k, k + 2), 16)).join(',')},${a})`

const GLYPH: Record<string, { text: string; color: string; label: string }> = {
  running: { text: '●', color: RUN, label: 'running' },
  background: { text: '◐', color: ACTIVITY, label: 'background' },
  done: { text: '✓', color: RUN, label: 'done' },
  error: { text: '✗', color: FAULT, label: 'error' },
  cancelled: { text: '⊘', color: 'inactive', label: 'cancelled' },
  failed: { text: '✗', color: FAULT, label: 'failed' },
  stopped: { text: '⊘', color: 'inactive', label: 'stopped' },
  lost: { text: '?', color: ROUND, label: 'lost' },
}

function fmtClock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(s / 60)
  return m < 60 ? `${m}:${String(s % 60).padStart(2, '0')}` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`
}

const squash = (s: string) => s.replace(/\s+/g, ' ').trim()
const clip = (s: string, n: number) => {
  const t = squash(s)
  return n <= 0 ? '' : t.length > n ? `${t.slice(0, Math.max(0, n - 1)).trimEnd()}…` : t
}
const kilo = (n: number | undefined | null) => (n == null ? '—' : n < 1000 ? String(n) : `${(n / 1000).toFixed(1)}k`)
const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)

// A Codex job reports usage only once it has some; until then the line would be all dashes.

const activeOf = (slot: Slot) => slot.instances.filter(i => i.isActive)

export function copyText(job: Job): string {
  return `${job.id}\nresume: delegate({ agent: "${job.agent}", resume: "${job.id}", prompt: … })`
}

type Seg = { text?: string; color?: string; bold?: boolean; dim?: boolean; bg?: string; chip?: boolean; node?: unknown; w?: number }
const widthOf = (segs: Seg[]) =>
  segs.reduce((n, s, k) => n + (s.node ? s.w ?? 0 : cellWidth(s.text ?? '')) + (k ? 1 : 0), 0)

/** Keeps the segments that fit `width` cells (one cell between them), clipping the one that crosses. */
function fit(segs: Seg[], width: number): Seg[] {
  const out: Seg[] = []
  let used = 0
  for (const seg of segs) {
    const gap = out.length ? 1 : 0
    const w = seg.node ? seg.w ?? 0 : cellWidth(seg.text ?? '')
    if (used + gap + w <= width) { out.push(seg); used += gap + w; continue }
    const left = width - used - gap
    if (!seg.node && left >= 2) out.push({ ...seg, text: clip(seg.text ?? '', left) })
    break
  }
  return out
}

/**
 * The "Last 15 minutes" card: one lane per slot, solid bars for running work, outlines for finished
 * work, and every run of the role that overlaps the window (its history, not just the cards' lines).
 * A lost round with no known end is a tick at its start, never a bar.
 */
export function timelineSource(slots: Slot[], session: SessionInfo, now: number, columns = 86): { source: string; width: number; height: number } {
  // Keep the image source steady between timeline ticks, including running bar ends.
  now = Math.floor(now / 15_000) * 15_000
  const span = 900_000
  const t0 = now - span
  const SW = Math.max(8, Math.round(columns * 8))
  const x0 = Math.min(136, SW * 0.4)
  const x1 = SW - 24
  const xOf = (t: number) => x0 + ((Math.min(now, Math.max(t0, t)) - t0) / span) * (x1 - x0)
  const hex = (e: Engine | 'mixed') => HEX[e]
  const soft = (e: Engine) => (e === 'claude' ? HEX.claudeSoft : HEX.codexSoft)
  const inRange = (r: RoundView) => (endOf(r, now) ?? r.startedAt) >= t0
  const inWindow = (i: Instance) => i.rounds.some(inRange)
  const runs = (slot: Slot) => (slot.history ?? slot.instances).filter(inWindow)
  const pitch = 28
  const sub = 18
  const lanes: { top: number; slot: Slot }[] = []
  let y = 46
  for (const slot of slots) {
    lanes.push({ top: y, slot })
    y += pitch + sub * (Math.max(1, runs(slot).length) - 1)
  }
  const axisY = y + 8
  const height = axisY + 54
  let body = `<rect x="0.5" y="0.5" width="${SW - 1}" height="${height - 1}" rx="12" fill="${rgba(SECTION_COLOR.timeline, 0.06)}" stroke="${rgba(SECTION_COLOR.timeline, 0.75)}" stroke-width="1.4"/>`
  body += `<text x="16" y="26" font-size="13" font-weight="600" fill="${SECTION_COLOR.timeline}">Last 15 minutes</text>`
  for (const m of [0, 5, 10]) {
    const gx = x0 + (m / 15) * (x1 - x0)
    body += `<line x1="${gx}" y1="40" x2="${gx}" y2="${axisY - 14}" stroke="${HEX.grid}"/>`
  }
  body += `<line x1="${x1}" y1="40" x2="${x1}" y2="${axisY - 14}" stroke="#8a8f98"/>`
  for (const { top, slot } of lanes) {
    const cy = top + 8
    const n = activeOf(slot).length
    const labelFill = slot.name === 'orchestrator' ? HEX.ink : slot.state === 'active' ? ROLE_COLOR[slot.name] : HEX.muted
    body += `<text x="16" y="${cy + 3}" font-size="12" font-weight="${slot.state === 'active' ? 600 : 400}" fill="${labelFill}">${esc(n > 1 ? `${slot.name} ×${n}` : slot.name)}</text>`
    if (slot.name === 'orchestrator') {
      const s = session
      const turns = s.turns ?? []
      for (const turn of turns) {
        if (turn.endedAt >= t0 && turn.startedAt <= now) body += `<rect x="${xOf(turn.startedAt)}" y="${top + 2}" width="${Math.max(3, xOf(turn.endedAt) - xOf(turn.startedAt))}" height="12" rx="3" fill="${HEX.turn}"/>`
      }
      if (s.isRunning && s.turnStartedAt !== undefined && s.turnStartedAt <= now) body += `<rect x="${xOf(s.turnStartedAt)}" y="${top + 2}" width="${Math.max(3, xOf(now) - xOf(s.turnStartedAt))}" height="12" rx="3" fill="${HEX.ink}"/>`
      if (!s.isRunning && !turns.length) body += `<text x="${x0 + 6}" y="${cy + 3}" font-size="11" fill="${HEX.muted}">Idle</text>`
      continue
    }
    if (slot.state === 'off') {
      body += `<line x1="${x0}" y1="${cy}" x2="${x1}" y2="${cy}" stroke="${HEX.dot}" stroke-dasharray="1 4"/>`
      body += `<rect x="${x0 + 6}" y="${cy - 8}" width="28" height="15" rx="7" fill="${HEX.pill}"/><text x="${x0 + 20}" y="${cy + 3}" text-anchor="middle" font-size="10" font-weight="600" fill="${HEX.muted}">off</text>`
      continue
    }
    const seen = runs(slot)
    if (!seen.length) {
      body += `<text x="${x0 + 6}" y="${cy + 3}" font-size="10" fill="${HEX.muted}">${slot.lastEndedAt !== undefined ? `last run ${ago(now - slot.lastEndedAt)} ago` : 'idle'}</text>`
      continue
    }
    seen.forEach((i, k) => {
      const by = top + 2 + k * sub
      const rounds = i.rounds.filter(inRange)
      rounds.forEach((r, m) => {
        const end = endOf(r, now)
        const sx = xOf(r.startedAt)
        const w = end === undefined ? 3 : Math.max(3, xOf(end) - sx)
        const ex = sx + w
        body += end === undefined
          ? `<rect x="${sx}" y="${by}" width="3" height="12" fill="${HEX.amber}"/><text x="${sx + 6}" y="${by + 10}" font-size="10" font-weight="600" fill="${HEX.amber}">?</text>`
          : r.endedAt === undefined
            ? `<rect x="${sx}" y="${by}" width="${w}" height="12" rx="3" fill="${hex(i.engine)}"/>`
            : `<rect x="${sx}" y="${by}" width="${w}" height="12" rx="3" fill="${soft(i.engine)}" stroke="${hex(i.engine)}"/>`
        if (i.rounds.length > 1) {
          body += `<text x="${sx + w / 2}" y="${by - 2}" text-anchor="middle" font-size="9" font-weight="600" fill="${HEX.amber}">r${i.rounds.indexOf(r) + 1}</text>`
        }
        const next = rounds[m + 1]
        if (next) body += `<line x1="${ex}" y1="${by + 6}" x2="${xOf(next.startedAt)}" y2="${by + 6}" stroke="${hex(i.engine)}" stroke-dasharray="2 3"/>`
      })
      if (seen.length > 1) {
        body += `<text x="${xOf(rounds[0].startedAt) - 5}" y="${by + 10}" text-anchor="end" font-size="10" fill="${HEX.ink}">${esc(i.id)}</text>`
      }
    })
  }
  for (const [m, label] of [[0, '−15m'], [5, '−10m'], [10, '−5m']] as const) {
    body += `<text x="${x0 + (m / 15) * (x1 - x0)}" y="${axisY}" text-anchor="middle" font-size="10" fill="${HEX.muted}">${label}</text>`
  }
  body += `<text x="${x1}" y="${axisY}" text-anchor="end" font-size="10" font-weight="600" fill="${HEX.ink}">now</text>`
  body += `<path d="M16 ${axisY + 16}H${SW - 16}" stroke="${HEX.grid}"/><rect x="16" y="${axisY + 30}" width="8" height="8" rx="2" fill="${HEX.codex}"/><text x="30" y="${axisY + 38}" font-size="11" fill="${HEX.muted}">Running</text><rect x="110" y="${axisY + 30}" width="8" height="8" rx="2" fill="none" stroke="#8a8f98"/><text x="124" y="${axisY + 38}" font-size="11" fill="${HEX.muted}">Finished</text><text x="210" y="${axisY + 38}" font-size="11" fill="${HEX.amber}">?</text><text x="224" y="${axisY + 38}" font-size="11" fill="${HEX.muted}">Lost</text>`
  const source = `<svg xmlns="http://www.w3.org/2000/svg" width="${SW}" height="${height}" viewBox="0 0 ${SW} ${height}" font-family="Avenir Next,Trebuchet MS,sans-serif">${body}</svg>`
  return { source, width: SW, height }
}

export function drawPanel(el: PanelElements, data: PanelData): unknown {
  const { Box, Button } = el
  const layout = layoutOf(data.surface, data.placement)
  const isDesk = layout === 'desktop'
  const isMini = layout === 'mini'
  // The real width, with no floor: content degrades to fit it. Below 12 columns the cards give up
  // their border and padding, the header its title and tabs, so nothing is wider than the body.
  const outerW = Math.max(1, data.columns)
  const inset = isDesk && outerW >= 36 ? 3 : 0
  const W = Math.max(1, outerW - inset * 2)
  const isTiny = W < 12
  const IW = isTiny ? W : W - 4
  const { now, roster } = data
  const canClient = data.hasClient && !data.clockLost
  const hasClock = canClient && !!el.clock
  const [orch, ...roles] = roster.slots

  const image = (key: string, source: string, width: number, height: number, alt: string) => {
    const Svg = el.Svg!
    return <Svg key={key} source={source} width={width} height={height} alt={alt} />
  }
  const icon = (key: string, name: keyof typeof ICON, color: string, size = 16) => image(key,
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${ICON[name]}</svg>`, size, size, name)
  // The backplate supplies the exact 6px radius; native text and buttons remain selectable/actionable.
  const plate = (key: string, width: number, height: number, tint: readonly string[], children: unknown[], padding = 1.25, gap = 1) => (
    <Box key={key} width={width} height={height} position="relative" alignItems="center" paddingX={padding} gap={gap}>
      <Box key={`${key}-back`} position="absolute" top={0} left={0}>
        {image(`${key}-back-svg`, `<svg xmlns="http://www.w3.org/2000/svg" width="${width * 8}" height="${height * 20}"><rect x=".5" y=".5" width="${width * 8 - 1}" height="${height * 20 - 1}" rx="6" fill="${tint[0]}" stroke="${tint[1]}"/></svg>`, width * 8, height * 20, 'segment background')}
      </Box>
      {children}
    </Box>
  )
  const rule = (key: string, width = W) => isDesk && el.Svg
    ? image(key, `<svg xmlns="http://www.w3.org/2000/svg" width="${width * 8}" height="1"><path d="M0 .5H${width * 8}" stroke="${HEX.grid}"/></svg>`, width * 8, 1, 'divider')
    : <Box key={key} width={width}><el.Text dimColor>{'─'.repeat(width)}</el.Text></Box>
  const numeric = (key: string, value: Seg, width: number): Seg => ({
    node: <Box key={key} width={width} flexShrink={0} justifyContent="flex-end">{value.node ?? text(value)}</Box>, w: width,
  })

  // Desktop paints with the artboard's hex values; the dim mark becomes its muted gray.
  const paint = (name: string | undefined) => (isDesk && name ? DESK[name] ?? name : name)
  const text = (s: Seg) => {
    const code = isDesk && s.color === 'cyan'
    let color = code ? DESK.cyan : isDesk ? (s.dim && !s.color ? HEX.muted : paint(s.color) ?? HEX.ink) : s.color
    // No dim attribute on desktop: a dimmed hex is pulled toward the panel.
    if (isDesk && s.dim && s.color && color?.startsWith('#')) color = mix(color, HEX.bg, 0.5)
    const bg = s.bg ?? (code ? '#2b2f33' : isDesk && s.chip && s.color ? DESK_SOFT[s.color] : undefined)
    return (
      <el.Text color={color} bold={s.bold} dimColor={isDesk ? undefined : s.dim} backgroundColor={bg} wrap="truncate">{s.text}</el.Text>
    )
  }
  const chip = (t: string, color: string, bold = false): Seg =>
    isDesk ? { text: ` ${t} `, color, chip: true, bold } : { text: t, color, bold }
  const render = (segs: Seg[]) => segs.map(s => (s.node ? s.node : text(s)))
  const note = (key: string, s: Seg) => <Box key={key}>{text({ ...s, text: clip(s.text ?? '', W) })}</Box>

  // One line. `keep` cells of the left side (glyph and name) are never given to the right side,
  // which is cut first; the left side is cut to what the right one leaves.
  const keepOf = (left: Seg[], n: number) => widthOf(left.slice(0, n))
  const line = (key: string, left: Seg[], right: Seg[] | undefined, width: number, keep = 0) => {
    const rightFit = right ? fit(right, Math.max(0, width - keep - 1)) : undefined
    const leftFit = fit(left, rightFit?.length ? width - widthOf(rightFit) - 1 : width)
    return (
      <Box key={key} justifyContent="space-between" gap={1} width={width}>
        <Box gap={1} flexShrink={1}>{render(leftFit)}</Box>
        {rightFit?.length ? <Box gap={1} flexShrink={0}>{render(rightFit)}</Box> : null}
      </Box>
    )
  }

  const clockSeg = (key: string, since: number, endAt: number | null, color: string, bold = false): Seg => {
    if (since <= 0) return { text: '—', color }
    if (hasClock) return { node: el.clock!({ key, width: 6, props: { since, now, endAt, color: paint(color)! } }), w: 6 }
    return { text: fmtClock((endAt ?? now) - since), color, bold }
  }

  // A steady state dot: an image on desktop, one text cell on the terminal.
  const pulseSeg = (key: string): Seg => {
    if (isDesk && el.Svg) {
      const Svg = el.Svg
      const source = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" width="10" height="10"><circle cx="5" cy="5" r="4.5" fill="${HEX.green}"/></svg>`
      return { node: <Svg key={key} source={source} alt="running" width={10} height={10} />, w: 1 }
    }
    return { text: '●', color: RUN }
  }
  const idleSeg = (key: string): Seg => isDesk && el.Svg ? {
    node: image(key, `<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><circle cx="4" cy="4" r="3" fill="none" stroke="${HEX.muted}" stroke-width="1.5"/></svg>`, 8, 8, 'idle'), w: 1,
  } : { text: '○', dim: true }

  const card = (key: string, children: unknown[], style: { border?: string; dim?: boolean; color?: string } = {}) => (
    <Box
      key={key}
      flexDirection="column"
      borderStyle={isTiny ? undefined : style.border ?? (isDesk ? 'round' : 'single')}
      borderColor={isDesk ? paint(style.color) ?? HEX.edge : style.color}
      borderDimColor={isDesk ? undefined : style.dim}
      backgroundColor={isDesk ? HEX.card : undefined}
      paddingX={isTiny ? 0 : 1}
      width={W}
    >
      {children}
    </Box>
  )

  // ------------------------------------------------------------ header and footer
  const profileRow = (width: number) => {
    const locked = data.profileLockedBy
    const label = width >= 48 ? 'Profile' : undefined
    const choose = (name: string) => {
      if (!locked && data.profiles.includes(name)) data.onProfile?.(name)
    }
    const note = locked ? width >= 48 ? `set by ${locked} pantheon.json` : `${locked} JSON` : undefined
    const prefixW = label ? label.length + 1 : 0
    const noteW = note ? Math.min(note.length, Math.max(0, width - prefixW - (width >= 48 ? 12 : 4))) : 0
    const namesW = Math.max(1, width - prefixW - (noteW ? noteW + 1 : 0))
    const names = locked && namesW < 24 ? [data.activeProfile] : data.profiles
    const nameW = Math.max(1, Math.floor((namesW - Math.max(0, names.length - 1)) / Math.max(1, names.length)))
    return (
      <Box key="profile-row" width={width} gap={1} overflow="hidden">
        {!locked && el.Select && data.profiles.length ? (
          <el.Select key="profile" label={label} value={data.activeProfile}
            options={data.profiles.map(name => ({ value: name, label: clip(name, Math.max(1, width - prefixW - 4)) }))}
            onSelect={choose} />
        ) : (
          <Box gap={1} width={namesW + prefixW} overflow="hidden">
            {label ? text({ text: label, dim: true }) : null}
            {names.map(name => {
              const active = name === data.activeProfile
              const shown = clip(`${active ? '● ' : ''}${name}`, nameW)
              return locked
                ? <el.Text key={`profile-${name}`} color={active ? paint(ENGINE_COLOR[orch.engine]) : undefined}
                    bold={active} dimColor={!isDesk && !active ? true : undefined} wrap="truncate">{shown}</el.Text>
                : <Button key={`profile-${name}`} plain label={shown} dimColor={!active} onPress={() => choose(name)} />
            })}
          </Box>
        )}
        {noteW ? text({ text: clip(note!, noteW), dim: true }) : null}
      </Box>
    )
  }
  // The desktop header row is a pill row (1.7 rows tall at full width); the profile row sits under it.
  const headerTopH = isDesk && W >= 60 ? 1.7 : 1
  const headerH = data.rows >= 2 ? headerTopH + 1 : 1
  const tabButton = (tab: 'agents' | 'jobs', label: string) => {
    if (!isDesk) return <Button key={`tab-${tab}`} label={data.tab === tab ? `● ${label}` : label} hotkey={tab === 'agents' ? '1' : '2'} onPress={() => data.onTab(tab)} />
    const active = data.tab === tab
    const button = <Button key={`tab-${tab}`} plain label={W < 60 ? label : tab === 'agents' ? 'Agents' : 'Jobs'} hotkey={tab === 'agents' ? '1' : '2'} onPress={() => data.onTab(tab)} />
    if (!isDesk || !el.Svg || W < 60) return button
    const tint = active ? HUD.agents : HUD.neutral
    return plate(`pill-${tab}`, tab === 'agents' ? 14.25 : 17.5, 1.7, tint, [
      icon(`icon-${tab}`, tab, active ? HUD.agents[2] : HUD.neutral[2]), button,
      ...(tab === 'jobs' ? [text({ text: '·', dim: true }), numeric('jobs-count', { text: String(data.jobs.length + claudeRuns().length), bold: true }, 3).node] : []),
    ])
  }
  const header = () => {
    const running = roles.reduce((n, r) => n + activeOf(r).length, 0) + roster.others.filter(i => i.isActive).length
    const right: Seg[] = data.tab === 'agents'
      ? W >= (isDesk ? 58 : 30)
        ? running ? isDesk
          ? [pulseSeg('hdr-dot'), numeric('header-running-count', { text: String(running), color: RUN, bold: true }, 3), { text: 'running', color: RUN, bold: true }]
          : [pulseSeg('hdr-dot'), { text: `${running} running`, color: RUN, bold: true }]
          : data.session.isRunning ? [pulseSeg('hdr-dot'), { text: 'working', color: RUN, bold: true }] : [...(isDesk ? [idleSeg('hdr-idle')] : []), { text: 'idle', dim: true }]
        : []
      : W >= 60 ? [{ text: 'Codex jobs · Claude rounds', dim: true }] : []
    if (data.onClose && W >= 58) right.push({ node: isDesk ? <Button key="close" plain label="✕" onPress={() => data.onClose?.()} /> : <Button key="close" label="✕" onPress={() => data.onClose?.()} />, w: isDesk ? 3 : 5 })
    // Too narrow for both tabs: one button switches to the other tab.
    const other = data.tab === 'agents' ? 'jobs' : 'agents'
    const tabs = W >= 30
      ? [tabButton('agents', 'Agents'), tabButton('jobs', `Jobs · ${data.jobs.length + claudeRuns().length}`)]
      : [<Button key={`tab-${other}`} label={other === 'jobs' ? 'J' : 'A'} hotkey={other === 'jobs' ? '2' : '1'} onPress={() => data.onTab(other)} />]
    if (!isDesk) return (
      <Box key="header" flexDirection="column" width={W}>
        {headerH > 1 ? (
          <Box justifyContent="space-between" gap={1} width={W}>
            <Box gap={1} flexShrink={1}>
              {W >= 14 ? text({ text: 'PANTHEON', bold: true, color: ROUND }) : null}
              {tabs}
            </Box>
            {right.length ? <Box gap={1} flexShrink={0}>{render(right)}</Box> : null}
          </Box>
        ) : null}
        {profileRow(W)}
      </Box>
    )
    return (
      <Box key="header" flexDirection="column" width={W}>
        {headerH > 1 ? (
          <Box key="header-top" justifyContent="space-between" alignItems="center" gap={1} width={W} height={W >= 60 ? 1.7 : 1}>
            <Box gap={isDesk ? 2 : 1} alignItems="center" flexShrink={1}>
              {W >= 14 ? text({ text: isDesk ? 'Pantheon' : 'PANTHEON', bold: true, color: ROUND }) : null}
              <Box key="tabs" gap={1} alignItems="center">{tabs}</Box>
            </Box>
            {right.length ? <Box key="header-state" width={isDesk ? 16 : undefined} alignItems="center" justifyContent="flex-end" gap={1} flexShrink={0}>{render(right)}</Box> : null}
          </Box>
        ) : null}
        {profileRow(W)}
      </Box>
    )
  }
  // 7: the warning gets its own row under the header, ahead of everything optional.
  const clockWarning = () => data.clockLost ? note('clock-lost', { text: 'clock unavailable', color: ROUND, bold: true }) : null
  const footer = () => !isDesk || !el.Svg || W < 60 ? note('footer', {
    dim: true,
    text: [data.tab === 'agents' ? 'keys: 1 agents · 2 jobs · esc close' : 'keys: 1 agents · 2 jobs · ↻ resumable · Copy = id + resume hint'].join(' · '),
  }) : (
    <Box key="footer" flexDirection="column" width={W} gap={isDesk ? 0.5 : 0}>
      {rule('footer-rule')}
      <Box key="footer-row" width={W} alignItems="center" justifyContent="space-between" gap={1}>
        <Box key="totals" gap={1} alignItems="center">
          {render([numeric('agents-total', { text: String(1 + roles.reduce((n, s) => n + s.instances.length, 0) + roster.others.length), dim: true }, 3), { text: 'agents', dim: true }, { text: '|', dim: true }, numeric('jobs-total', { text: String(data.jobs.length + claudeRuns().length), dim: true }, 3), { text: 'jobs', dim: true }])}
        </Box>
        <Box key="keys" alignItems="center" gap={1} flexShrink={0}>
          {text({ text: 'keys:', dim: true })}
          {(['agents', 'jobs'] as const).map((tab, index) => <Box key={`key-${tab}`} alignItems="center" gap={0.6}>
            {image(`hint-${tab}`, `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect x=".5" y=".5" width="15" height="15" rx="3" fill="none" stroke="#57585b"/><text x="8" y="11.5" text-anchor="middle" font-family="Avenir Next,Trebuchet MS,sans-serif" font-size="10" fill="#c9cbd0">${index + 1}</text></svg>`, 16, 16, `${tab} shortcut ${index + 1}`)}
            {text({ text: tab, dim: true })}
          </Box>)}
          {data.onClose ? text({ text: 'esc close', dim: true }) : null}
        </Box>
      </Box>
      {data.tab === 'jobs' ? text({ text: '↻ resumable · Copy = id + resume hint', dim: true }) : null}
    </Box>
  )

  // ------------------------------------------------------------ agents tab
  const bar = (percent: number, cells: number): [Seg, Seg] => {
    const filled = Math.max(0, Math.min(cells, Math.round((percent / 100) * cells)))
    return [{ text: '█'.repeat(filled), color: percent >= 80 ? ROUND : ACTIVITY }, { text: '░'.repeat(cells - filled), dim: true }]
  }
  const delegatingSegs = (): Seg[] =>
    roster.delegating.map(name => {
      const slot = roles.find(s => s.name === name)!
      const n = activeOf(slot).length
      return { text: n > 1 ? `${name} ×${n}` : name, color: ENGINE_COLOR[slot.engine] }
    })

  // ------- cells and cards
  // Terminal rows are exact in cells (cellWidth, never .length); each column sits in a fixed-width Box.
  const segCells = (s: Seg) => (s.node ? s.w ?? 0 : cellWidth(s.text ?? ''))
  /** Segments side by side with no gap, cut to `width` cells; the one that crosses is truncated. */
  const clipRun = (segs: Seg[], width: number): Seg[] => {
    const out: Seg[] = []
    let used = 0
    for (const s of segs) {
      const w = segCells(s)
      if (used + w <= width) { out.push(s); used += w; continue }
      const left = width - used
      if (!s.node && left >= 1) out.push({ ...s, text: truncCells(s.text ?? '', left) })
      break
    }
    return out
  }
  type Col = { w: number; segs: Seg[]; end?: boolean }
  const cols = (key: string, list: Col[], width: number, height?: number) => (
    <Box key={key} width={width} height={height} overflow="hidden" alignItems={height ? 'center' : undefined}>
      {list.reduce<{ left: number; out: unknown[] }>((acc, c, k) => {
        // A column never takes more than the row has left, so nothing is wider than the row.
        const w = Math.min(c.w, acc.left)
        if (w > 0) {
          acc.out.push(
            <Box key={k} width={w} flexShrink={0} overflow="hidden" justifyContent={c.end ? 'flex-end' : undefined}>
              {render(clipRun(c.segs, w))}
            </Box>,
          )
        }
        return { left: acc.left - w, out: acc.out }
      }, { left: width, out: [] }).out}
    </Box>
  )
  const plain = (key: string, segs: Seg[], width: number, height?: number) => cols(key, [{ w: width, segs }], width, height)

  type Group = PanelGroup
  // A Running row is one live instance. An Idle row is a whole role (or council seat): `inst` is its latest
  // ended run and `rounds` every round the role ran, oldest first.
  type AgentRow = { key: string; slot: Slot; inst?: Instance; group: Group; name: string; rounds?: RoundView[]; isOff?: boolean }
  type RowBlock = { node: unknown; h: number }
  type Block = RowBlock & { color?: string }
  type Title = { label: string; count?: number }
  type Toggle = { group: Group; label: string }
  const LABEL: Record<Group, string> = { running: 'Agents · running', idle: 'Agents · idle' }
  const collapsedSet = new Set<string>(data.collapsed ?? [])
  const rowH = isDesk ? 1.4 : 1

  // A card. Terminal: round box lines with the title in the top border, every line exactly W cells.
  // Desktop: a native column over an SVG backplate; the title sits on its top edge.
  const frame = (key: string, color: string, title: Title, rows: RowBlock[], toggle?: Toggle): Block => {
    const toggleBtn = toggle && data.onToggle ? (): unknown => {
      const press = () => data.onToggle?.(toggle.group)
      return isDesk && el.Svg
        ? plate(`pill-toggle-${toggle.group}`, 10.5, 1.3, HUD.neutral, [<Button key={`toggle-${toggle.group}`} plain label={toggle.label} onPress={press} />])
        : <Button key={`toggle-${toggle.group}`} label={toggle.label} onPress={press} />
    } : undefined
    const sum = rows.reduce((n, r) => n + r.h, 0)
    if (isTiny) {
      return {
        node: <Box key={key} flexDirection="column" width={W}>{[plain(`${key}-t`, [{ text: title.label, bold: true, color }], W), ...rows.map(r => r.node)]}</Box>,
        h: sum + 1, color,
      }
    }
    if (isDesk) {
      const total = 1.5 + sum + 0.6
      const px = Math.round(total * 20)
      const back = el.Svg ? (
        <Box key={`${key}-back`} position="absolute" top={0} left={0}>
          {image(`${key}-back-svg`, `<svg xmlns="http://www.w3.org/2000/svg" width="${W * 8}" height="${px}"><rect x="1" y="10.5" width="${W * 8 - 2}" height="${px - 12}" rx="12" fill="${rgba(color, 0.06)}" stroke="${rgba(color, 0.75)}" stroke-width="1.4"/></svg>`, W * 8, px, 'card background')}
        </Box>
      ) : null
      return {
        node: (
          <Box key={key} position="relative" flexDirection="column" width={W} paddingX={2} paddingTop={1.5} paddingBottom={0.6}>
            {back}
            <Box key={`${key}-title`} position="absolute" top={0} left={2} backgroundColor={HEX.bg} paddingX={0.5}>
              {text({ text: title.label, bold: true, color })}
              {title.count === undefined ? null : text({ text: ` ${title.count}`, dim: true })}
            </Box>
            {toggleBtn ? <Box key={`${key}-toggle`} position="absolute" top={0} right={2} backgroundColor={HEX.bg}>{toggleBtn()}</Box> : null}
            {rows.map(r => r.node)}
          </Box>
        ),
        h: total, color,
      }
    }
    const tag = title.count === undefined ? '' : ` ${title.count}`
    const label = truncCells(title.label, Math.max(1, W - 6 - cellWidth(tag)))
    const leftW = 3 + cellWidth(label) + cellWidth(tag) + 1
    const bw = toggle && toggleBtn ? cellWidth(toggle.label) + 4 : 0
    const hasToggle = bw > 0 && W - leftW - (bw + 2) >= 1
    const fill = Math.max(0, W - leftW - (hasToggle ? bw + 2 : 1))
    const top = (
      <Box key={`${key}-top`} width={W}>
        {text({ text: '╭─ ', color })}
        {text({ text: label, color, bold: true })}
        {tag ? text({ text: tag, dim: true }) : null}
        {text({ text: ` ${'─'.repeat(fill)}`, color })}
        {hasToggle ? toggleBtn!() : null}
        {text({ text: hasToggle ? '─╮' : '╮', color })}
      </Box>
    )
    const bottom = <Box key={`${key}-bottom`} width={W}>{text({ text: `╰${'─'.repeat(W - 2)}╯`, color })}</Box>
    return {
      node: (
        <Box key={key} flexDirection="column" width={W}>
          {top}
          {rows.map((r, k) => (
            <Box key={`${key}-r${k}`} width={W}>
              {text({ text: '│ ', color })}
              <Box width={IW} flexShrink={0}>{r.node}</Box>
              {text({ text: ' │', color })}
            </Box>
          ))}
          {bottom}
        </Box>
      ),
      h: sum + 2, color,
    }
  }

  // The connector between two cards, in the next card's color. It moves only while something works.
  const isWorking = data.session.isRunning || roles.some(r => activeOf(r).length > 0) || roster.others.some(i => i.isActive)
  const railBlock = (key: string, color: string): Block => {
    const width = W - 4
    const dim = isWorking ? '#4b5468' : '#3b4354'
    const node = canClient && el.rail
      ? <Box key={key} width={W}>{text({ text: '  ' })}{el.rail({ key: `${key}-c`, width, props: { active: isWorking, width, color, dim, marks: [], isMerge: false } })}</Box>
      : <Box key={key} width={W}>{text({ text: `  ${'─'.repeat(width)}`, color: dim })}</Box>
    return { node, h: 1 }
  }

  // ------- agent rows
  const SEATS: Record<string, string> = { alpha: 'α', beta: 'β' }
  const stateOf = (status: string): StripItem['state'] =>
    status === 'running' || status === 'background' ? 'running'
      : status === 'done' ? 'done'
        : status === 'failed' || status === 'error' ? 'failed' : 'planned'
  // One thin bar per round; `extra` rounds beyond the shown ones read as +N.
  const stripSegs = (key: string, items: StripItem[], extra = 0): Seg[] => {
    const runs = strip(items)
    const more: Seg[] = extra > 0 ? [{ text: `+${extra}`, dim: true }] : []
    if (!runs.length) return more
    if (isDesk && el.Svg) {
      const px = runs.length * 8 + 1
      const rects = runs.map((r, k) => `<rect x="${k * 8 + 1}" y="1" width="4" height="12" rx="1.5" ${r.color ? `fill="${r.color}"` : `fill="none" stroke="${HEX.dot}" stroke-width="1.2"`}/>`).join('')
      const cellsW = Math.ceil(px / 8) + (extra > 0 ? 1 : 0)
      return [{ node: <Box key={`${key}-box`} width={cellsW} flexShrink={0}>{image(key, `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="14">${rects}</svg>`, px, 14, 'jobs')}</Box>, w: cellsW }, ...more]
    }
    return [...runs.map(r => ({ text: r.text, color: r.color, dim: r.dim })), ...(extra > 0 ? [{ text: ' ' }, ...more] : [])]
  }

  // What an instance read (Codex input, Claude context) and wrote.
  const tokensIn = (i: Instance) => (i.engine === 'codex' ? i.tokens.input : i.tokens.ctx) ?? 0
  // A running Claude agent's context use: its ctx over the window the session reports. Without the
  // window nothing is guessed and the column stays out.
  const agentCtx = (i: Instance | undefined): number | undefined => {
    const window = data.session.context?.window
    return i && i.isActive && i.engine === 'claude' && i.tokens.ctx != null && window
      ? Math.min(100, Math.round((i.tokens.ctx / window) * 100)) : undefined
  }
  const durationSeg = (key: string, i: Instance, running: boolean): Seg => {
    if (running) return clockSeg(`clk-${i.id}`, i.startedAt, null, 'inactive')
    const end = i.endedAt ?? endOf(i.rounds[i.rounds.length - 1] ?? { startedAt: i.startedAt, status: i.status }, now)
    return { text: end === undefined ? '—' : fmtClock(end - i.startedAt), dim: true }
  }
  const nameOf = (slot: Slot, seat?: string) => `${slot.name}${seat ? ` ${SEATS[seat] ?? seat}` : ''}`
  // Running: one row per live instance (parallel runs and council seats each get theirs). Idle: exactly one
  // row per role and per council seat that has nothing live, summing up every run it ever had.
  const agentRows = (): Record<Group, AgentRow[]> => {
    const out: Record<Group, AgentRow[]> = { running: [], idle: [] }
    for (const slot of roles) {
      for (const inst of slot.instances.filter(i => i.isActive)) {
        out.running.push({ key: inst.id, slot, inst, group: 'running', name: nameOf(slot, inst.seat) })
      }
      const all = slot.history ?? slot.instances
      const isCouncil = slot.name === 'council'
      const seats = isCouncil && slot.state !== 'off'
        ? [...new Set([...(slot.seats ?? []), ...all.map(i => i.seat).filter((x): x is string => !!x)])].sort() : []
      for (const seat of seats.length ? seats : [undefined]) {
        const mine = isCouncil && seats.length ? all.filter(i => i.seat === seat) : all
        if (mine.some(i => i.isActive)) continue
        const isOff = slot.state === 'off' || (seat !== undefined && !!slot.seatsOff?.includes(seat))
        const last = slot.instances.filter(i => !i.isActive && mine.includes(i))[0]
        const rounds = mine.flatMap(i => i.rounds).sort((a, b) => a.startedAt - b.startedAt)
        out.idle.push({ key: `idle-${slot.name}${seat ? `-${seat}` : ''}`, slot, inst: last, group: 'idle', name: nameOf(slot, seat), rounds, isOff })
      }
    }
    return out
  }
  const dotOf = (r: AgentRow): Seg => {
    const { slot, inst: i } = r
    if (r.isOff) return { text: '⊘', dim: true }
    if (!i) return { text: '●', dim: true }
    if (i.isActive) return { text: '●', color: ROLE_COLOR[slot.name] }
    if (i.status === 'done') return { text: '●', color: OK }
    if (i.status === 'error' || i.status === 'failed') return { text: '●', color: BAD }
    if (i.status === 'lost') return { text: '●', color: SECTION_COLOR.planned }
    return { text: '●', dim: true }
  }

  const NAME_W = 10
  const MODEL_W = 11
  const TIME_W = 6
  const CTX_W = 9
  const STRIP_W = 8
  const agentRowBlock = (r: AgentRow, compact: boolean, withCtxCol: boolean): RowBlock => {
    const { slot, inst: i } = r
    const role = slot.name
    const isIdle = r.group === 'idle'
    const isOff = !!r.isOff
    const running = !isIdle
    const mixed = isIdle && slot.engine === 'mixed'
    const model = modelName(i?.model ?? slot.model)
    const task = isOff ? (isIdle && slot.state !== 'off' ? 'Disabled' : `Disabled · ${slot.offReason ?? 'disabledAgents'}`)
      : i ? squash(i.task || '(no description)') : '—'
    let withModel = !compact
    let withStrip = !compact
    let withCtx = !compact && withCtxCol
    const fixedW = () => 2 + NAME_W + TIME_W + (withCtx ? CTX_W : 0) + (withModel ? MODEL_W : 0) + (withStrip ? STRIP_W : 0)
    // The ctx column is the first to go, then the model, then the strip.
    if (IW - fixedW() < 12) withCtx = false
    if (IW - fixedW() < 12) withModel = false
    if (IW - fixedW() < 12) withStrip = false
    const taskW = Math.max(0, IW - fixedW())
    // Running: this instance's rounds in the role's color. Idle: the role's last four rounds, green or red.
    const shown = isIdle ? (r.rounds ?? []).slice(-4) : (i?.rounds ?? []).slice(-4)
    const items: StripItem[] = shown.map(rd => ({ state: stateOf(rd.status), role }))
    const extra = isIdle ? Math.max(0, (r.rounds?.length ?? 0) - 4) : 0
    const pct = agentCtx(i)
    const time: Seg = i ? durationSeg(r.key, i, running) : { text: '—', dim: true }
    const faded = isIdle && (!i || isOff)
    const list: Col[] = [
      { w: 2, segs: [dotOf(r)] },
      { w: NAME_W, segs: [{ text: truncCells(r.name, NAME_W - 1), color: ROLE_COLOR[role], bold: true, dim: faded }] },
      ...(withModel ? [{ w: MODEL_W, segs: [{ text: truncCells(`${mixed ? '⇄ ' : ''}${model}`, MODEL_W - 1), dim: true }] }] : []),
      ...(withStrip ? [{ w: STRIP_W, segs: stripSegs(`strip-${r.key}`, items, extra) }] : []),
      { w: TIME_W, segs: [time] },
      ...(withCtx ? [{ w: CTX_W, segs: pct === undefined ? [] : [{ text: `ctx ${pct}%`, dim: true }] }] : []),
      { w: taskW, segs: [{ text: task, dim: !running }] },
    ]
    const main = cols(r.key, list, IW, isDesk ? rowH : undefined)
    if (i && running && i.activity && !compact) {
      return {
        node: (
          <Box key={`${r.key}-rows`} flexDirection="column" width={IW}>
            {main}
            <Box key={`${r.key}-d`} width={IW} paddingLeft={2}>{plain(`${r.key}-dl`, [{ text: '↳ ', dim: true }, { text: i.activity, color: ACTIVITY }], IW - 2)}</Box>
          </Box>
        ),
        h: rowH + 1,
      }
    }
    return { node: main, h: rowH }
  }

  // A group card: its rows, or only the title and the fold button when folded or cut to a head.
  const groupBlock = (g: Group, rows: AgentRow[], mode: 'full' | 'compact' | 'head'): Block[] => {
    if (!rows.length) return []
    const isFolded = collapsedSet.has(g)
    const eff = isFolded ? 'head' : mode
    const toggle: Toggle | undefined = W >= 30 && data.onToggle && (isFolded || mode !== 'head')
      ? { group: g, label: isFolded ? 'Expand' : 'Collapse' } : undefined
    const withCtxCol = rows.some(r => agentCtx(r.inst) !== undefined)
    const built = eff === 'head' ? [] : rows.map(r => agentRowBlock(r, eff === 'compact', withCtxCol))
    return [frame(`${g}-rows`, SECTION_COLOR[g], { label: LABEL[g], count: rows.length }, built, toggle)]
  }

  // ------- timeline (terminal): one lane per slot, one cell run per minute of the last 15
  const timelineBlock = (): Block | undefined => {
    const span = 900_000
    const t0 = now - span
    const labelW = 13
    const per = Math.floor((IW - labelW) / 15)
    if (per < 1) return undefined
    const hit = (s: number, e: number, b: number) => s < t0 + (b + 1) * 60_000 && e >= t0 + b * 60_000
    const busy = (slot: Slot, b: number): boolean => {
      if (slot.name === 'orchestrator') {
        const ses = data.session
        return (ses.turns ?? []).some(t => hit(t.startedAt, t.endedAt, b)) ||
          (ses.isRunning && ses.turnStartedAt !== undefined && hit(ses.turnStartedAt, now, b))
      }
      return (slot.history ?? slot.instances).some(i => i.rounds.some(rd => hit(rd.startedAt, endOf(rd, now) ?? rd.startedAt, b)))
    }
    const rows: RowBlock[] = roster.slots.map(slot => {
      const n = activeOf(slot).length
      const color = ROLE_COLOR[slot.name]
      const bars: Seg[] = Array.from({ length: 15 }, (_, b): Seg =>
        slot.state !== 'off' && busy(slot, b) ? { text: '━'.repeat(per), color } : { text: '·'.repeat(per), dim: true })
      return { node: cols(`tl-${slot.name}`, [
        { w: labelW, segs: [{ text: n > 1 ? `${slot.name} ×${n}` : slot.name, color, dim: slot.state === 'off' }] },
        { w: 15 * per, segs: bars },
      ], IW, isDesk ? rowH : undefined), h: rowH }
    })
    rows.push({
      node: cols('tl-axis', [
        { w: labelW, segs: [] },
        { w: 15 * per, segs: [{ text: '-15m', dim: true }, { text: ' '.repeat(15 * per - 7), dim: true }, { text: 'now', dim: true }] },
      ], IW), h: 1,
    })
    return frame('timeline', SECTION_COLOR.timeline, { label: 'Last 15 minutes' }, rows)
  }

  // ------- session
  // Entrance and exit over every run plus the session's own context as input; a side nobody reported is left out.
  const tokenText = (): string => {
    const all = [...roles.flatMap(r => r.history ?? r.instances), ...roster.others]
    const input = all.reduce((n, i) => n + tokensIn(i), 0) + (data.session.context?.tokens ?? 0)
    const output = all.reduce((n, i) => n + i.tokens.out, 0)
    const sides = [...(input > 0 ? [`${kilo(input)}↑`] : []), ...(output > 0 ? [`${kilo(output)}↓`] : [])]
    return sides.length ? sides.join(' ') : '—'
  }
  const ctxColor = (pct: number) => (pct > 85 ? BAD : pct > 70 ? SECTION_COLOR.planned : SECTION_COLOR.session)
  const gaugeSegs = (key: string, pct: number, n: number): Seg[] => {
    const color = ctxColor(pct)
    if (isDesk && el.Svg) {
      const on = Math.min(n, Math.max(0, Math.round((pct / 100) * n)))
      const rects = Array.from({ length: n }, (_, k) => `<rect x="${k * 11 + 1}" y="1" width="8" height="12" rx="2" fill="${k < on ? color : HEX.track}"/>`).join('')
      // The Box is a whole number of cells wider than the image, so the percentage never touches the bar.
      // The image carries 8 empty pixels on its right and the Box is another whole cell wider.
      const px = n * 11 + 9
      const cellsW = Math.ceil(px / 8) + 1
      return [{ node: <Box key={`${key}-box`} width={cellsW} flexShrink={0}>{image(key, `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="14">${rects}</svg>`, px, 14, `context ${Math.round(pct)}%`)}</Box>, w: cellsW }]
    }
    const g = gauge(pct, n)
    return [...(g.on ? [{ text: g.on, color }] : []), ...(g.off ? [{ text: g.off, dim: true }] : [])]
  }
  const sessionBlocks = (compact: boolean): Block[] => {
    const s = data.session
    const running = s.isRunning
    const ctx = s.context?.percent
    const timeSeg = (): Seg => running && s.turnStartedAt
      ? clockSeg('clk-orchestrator', s.turnStartedAt, null, 'text', true)
      : s.lastTurnMs !== undefined ? { text: fmtClock(s.lastTurnMs), bold: true } : { text: '—', dim: true }
    const dot: Seg = running ? pulseSeg('s-dot') : idleSeg('s-idle')
    if (compact) {
      const model = [modelName(s.model), s.effort].filter(Boolean).join(' · ')
      const left: Seg[] = [dot, { text: 'orchestrator', bold: true, color: ROLE_COLOR.orchestrator }, ...(model ? [{ text: clip(model, 20), dim: true }] : [])]
      return [{ node: line('o-c', left, running && s.turnStartedAt ? [timeSeg()] : undefined, W, keepOf(left, 2)), h: 1 }]
    }
    const cost: Seg = s.costUsd !== undefined ? { text: `≈$${s.costUsd.toFixed(2)}`, bold: true } : { text: '—', dim: true }
    const tokens: Seg = tokenText() === '—' ? { text: '—', dim: true } : { text: tokenText(), bold: true }
    const stateTexts: Seg[] = [dot, { text: running ? 'working' : 'idle', color: running ? RUN : undefined, dim: !running }]
    const state: Seg[] = isDesk && el.Svg && IW >= 30
      ? [{ node: plate('s-pill', 11.5, 1.3, running ? [rgba(OK, 0.16), rgba(OK, 0.7)] : HUD.neutral, render(stateTexts), 1.25, 0.6), w: 11.5 }]
      : [dot, { text: ' ', dim: true }, stateTexts[1]]
    const identity: Seg[] = [
      { text: modelName(s.model) || 'orchestrator', bold: true, color: ROLE_COLOR.orchestrator },
      ...(s.effort ? [{ text: ` · ${s.effort} effort`, dim: true }] : []),
    ]
    const rows: RowBlock[] = []
    const space = (key: string, left: Seg[], right: Seg[], h?: number) => {
      const rw = right.reduce((n, x) => n + segCells(x), 0)
      return cols(key, [{ w: Math.max(0, IW - rw - 1), segs: left }, { w: IW - Math.max(0, IW - rw - 1), segs: right, end: true }], IW, h)
    }
    const ctxLabel: Seg = { text: 'ctx ', dim: true }
    // 'ctx ' and ' 100%' take 9 cells; the gauge takes the rest up to 30 blocks, or none when under 3.
    const gaugeN = Math.min(30, isDesk ? Math.floor(((IW - 13) * 8 - 9) / 11) : IW - 9)
    rows.push({ node: space('s1', identity, state, isDesk ? 1.6 : undefined), h: isDesk ? 1.6 : 1 })
    rows.push({
      node: plain('s-ctx', ctx != null
        ? [ctxLabel, ...(gaugeN >= 3 ? gaugeSegs('s-gauge', ctx, gaugeN) : []), { text: `${gaugeN >= 3 && !(isDesk && el.Svg) ? ' ' : ''}${Math.round(ctx)}%`, bold: true }]
        : [ctxLabel, { text: '—', dim: true }], IW, isDesk ? rowH : undefined),
      h: rowH,
    })
    const metric = (label: string, value: Seg): Seg[] => [{ text: `${label} `, dim: true }, value]
    const metrics = [metric('cost', cost), metric('tokens', tokens), metric('time', timeSeg())]
    const metricW = (m: Seg[]) => m.reduce((n, x) => n + segCells(x), 0)
    const joined = metrics.flatMap((m, k) => (k ? [{ text: '  ' } as Seg, ...m] : m))
    if (metrics.reduce((n, m) => n + metricW(m), 0) + 4 <= IW) {
      rows.push({ node: plain('s-metrics', joined, IW, isDesk ? rowH : undefined), h: rowH })
    } else {
      metrics.forEach((m, k) => rows.push({ node: plain(`s-metric-${k}`, m, IW, isDesk ? rowH : undefined), h: rowH }))
    }
    if (roster.delegating.length) {
      rows.push({ node: plain('s-delegating', [{ text: 'delegating → ', dim: true }, ...delegatingSegs().flatMap((x, k) => (k ? [{ text: ' ' } as Seg, x] : [x]))], IW, isDesk ? rowH : undefined), h: rowH })
    }
    return [frame('session', SECTION_COLOR.session, { label: 'Session' }, rows)]
  }

  const othersLine = () => {
    const list = [...roster.others].sort((a, b) => Number(b.isActive) - Number(a.isActive))
    return line('others', [
      { text: 'other agents', dim: true },
      ...list.slice(0, 3).map((i): Seg => ({ text: `${i.id} ${clip(i.task, 18)}`, color: ENGINE_COLOR[i.engine] })),
      ...(list.length > 3 ? [{ text: `+${list.length - 3}`, dim: true }] : []),
    ], undefined, W)
  }

  // The panel is built at the fullest level that fits `rows`; each step down drops something optional:
  // 0 everything, 1 the timeline, 2 the Idle rows (the card keeps its heading), 3 the session card and the
  // running rows to one line each, 4 the optional lines. Whatever still does not fit is cut from the bottom.
  const buildAgents = (level: number): Block[] => {
    const rows = agentRows()
    const mode = (g: Group): 'full' | 'compact' | 'head' =>
      g === 'idle' ? (level >= 2 ? 'head' : 'full') : level >= 3 ? 'compact' : 'full'
    const blocks: Block[] = [{ node: header(), h: headerH }]
    if (data.clockLost) blocks.push({ node: clockWarning(), h: 1 })
    blocks.push(...sessionBlocks(level >= 3))
    for (const g of ['running', 'idle'] as const) blocks.push(...groupBlock(g, rows[g], mode(g)))
    if (level < 4 && roster.others.length) blocks.push({ node: othersLine(), h: 1 })
    if (level === 0 && isDesk && el.Svg) {
      const t = timelineSource(roster.slots, data.session, now, W)
      blocks.push({ node: timelineCard(t), h: t.height / 20, color: SECTION_COLOR.timeline })
    } else if (level === 0 && !isDesk && !isTiny) {
      const t = timelineBlock()
      if (t) blocks.push(t)
    }
    // Rails link neighbouring cards, in the next card's color; the tight levels have no room for them.
    const linked: Block[] = []
    blocks.forEach((b, k) => {
      linked.push(b)
      const next = blocks[k + 1]
      if (level < 3 && !isTiny && b.color && next?.color) linked.push(railBlock(`rail-${k}`, next.color))
    })
    if (level < 4) linked.push({ node: footer(), h: isDesk ? (W >= 60 ? 2.05 : 3.05) : 1 })
    return linked
  }

  const agentsTab = () => {
    let blocks: Block[] = []
    for (let level = 0; level <= 4; level++) {
      blocks = buildAgents(level)
      if (blocks.reduce((n, b) => n + b.h, 0) <= data.rows) break
    }
    let total = blocks.reduce((n, b) => n + b.h, 0)
    while (total > data.rows && blocks.length > 1) total -= blocks.pop()!.h
    return blocks.map(b => b.node)
  }

  // ------------------------------------------------------------ timeline (desktop)
  function timelineCard({ source, width, height }: ReturnType<typeof timelineSource>) {
    const Svg = el.Svg!
    return <Svg key="timeline" source={source} alt="Last 15 minutes: one lane per role, a bar for each run" width={width} height={height} />
  }

  // ------------------------------------------------------------ jobs tab
  // One layout for drawing and for the row budget, so what is budgeted is what is drawn.
  // Cancel and Copy sit beside the id line when both fit with it; otherwise they drop under it,
  // and they stack in a column (no gap) when side by side would be wider than the body.
  const jobLayout = (job: Job) => {
    const isLive = ACTIVE.has(job.status)
    const cancelLabel = W < 24 ? 'x' : 'Cancel'
    const copyLabel = W < 24 ? 'c' : 'Copy'
    const actionsW = (isLive ? cancelLabel.length + 4 + 1 : 0) + copyLabel.length + 4
    const isStacked = actionsW > IW - 12
    const isColumn = isStacked && actionsW > IW
    const actionsH = !isStacked ? 0 : isColumn ? (isLive ? 2 : 1) : 1
    const height = 1 + actionsH + 1 + (isLive ? (job.lastActivity ? 1 : 0) + (job.tokens ? 1 : 0) : 0)
    return { cancelLabel, copyLabel, actionsW, isStacked, isColumn, height }
  }
  const jobHeight = (job: Job) => jobLayout(job).height

  const jobRows = (job: Job) => {
    const isLive = ACTIVE.has(job.status)
    const g = GLYPH[job.status] ?? GLYPH.lost
    const left: Seg[] = [
      { text: job.id, bold: true },
      { text: `${g.text} ${g.label}`, color: g.color, dim: job.status === 'cancelled' },
      { text: job.agent, color: ENGINE_COLOR.codex },
      ...(isResumable(job) ? [{ text: '↻', color: ROUND }] : []),
    ]
    const after = job.status === 'error' && job.error ? clip(job.error, 24)
      : job.endedAt !== undefined ? `${ago(now - job.endedAt)} ago` : ''
    const detail: Seg[] = [
      { text: clip(job.description ?? '(no description)', Math.max(8, IW - 26)), dim: true },
      ...(isLive ? [clockSeg(`jclk-${job.id}`, job.startedAt, null, 'text')] : after ? [{ text: `· ${after}`, dim: true }] : []),
    ]
    const { cancelLabel, copyLabel, actionsW, isStacked, isColumn } = jobLayout(job)
    const actions = (
      <Box key="actions" gap={isColumn ? 0 : 1} flexShrink={0} flexDirection={isColumn ? 'column' : 'row'}>
        {isLive && <Button key={`cancel-${job.id}`} label={cancelLabel} onPress={() => data.onCancel(job.id)} />}
        <Button key={`copy-${job.id}`} label={copyLabel} onPress={press => data.onCopy(copyText(job), press.surface)} />
      </Box>
    )
    return (
      <Box key={job.id} flexDirection="column" width={IW}>
        {isStacked ? (
          <Box flexDirection="column" width={IW}>
            <Box gap={1}>{render(fit(left, IW))}</Box>
            {actions}
          </Box>
        ) : (
          <Box justifyContent="space-between" gap={1} width={IW}>
            <Box gap={1} flexShrink={1}>{render(fit(left, IW - actionsW - 1))}</Box>
            {actions}
          </Box>
        )}
        <Box gap={1} width={IW}>{render(fit(detail, IW))}</Box>
        {isLive && job.lastActivity && note('act', { text: clip(`↳ ${job.lastActivity}`, IW), color: ACTIVITY })}
        {isLive && job.tokens && note('tok', {
          dim: true,
          text: clip(`in ${kilo(job.tokens.input)} · cached ${kilo(job.tokens.cached)} · out ${kilo(job.tokens.output)}`, IW),
        })}
      </Box>
    )
  }

  // Claude's own agent rounds, read-only: the natives and their rounds, as the roster holds them.
  type Run = { inst: Instance; role: string }
  const claudeRuns = (): Run[] =>
    [
      ...roles.flatMap(s => (s.history ?? s.instances).filter(i => i.engine === 'claude').map(inst => ({ inst, role: s.name as string }))),
      ...roster.others.filter(i => i.engine === 'claude').map(inst => ({ inst, role: 'other' })),
    ].sort((a, b) => Number(b.inst.isActive) - Number(a.inst.isActive) || b.inst.startedAt - a.inst.startedAt)
  const RUN_H = 3

  const runRows = ({ inst: i, role }: Run) => {
    const g = GLYPH[i.status] ?? GLYPH.lost
    const rc = (ROLE_COLOR as Record<string, string>)[role]
    const left: Seg[] = [
      { text: i.id, bold: true },
      { text: `${g.text} ${g.label}`, color: g.color, dim: i.status === 'cancelled' || i.status === 'stopped' },
      { text: role, color: rc, bold: true },
      ...(i.model ? [{ text: modelName(i.model), dim: true } as Seg] : []),
    ]
    const chips: Seg[] = [{ text: 'rounds', dim: true }]
    i.rounds.slice(-4).forEach((r, k, shown) => {
      const n = i.rounds.length - shown.length + k + 1
      const rg = GLYPH[r.status] ?? GLYPH.lost
      const end = endOf(r, now)
      const live = r.endedAt === undefined && ACTIVE.has(r.status)
      chips.push({ text: `${live ? '●' : rg.text} r${n}`, color: live ? RUN : rg.color })
      chips.push(live ? clockSeg(`rclk-${i.id}-${n}`, r.startedAt, null, 'inactive') : { text: end === undefined ? '?' : fmtClock(end - r.startedAt), dim: true })
    })
    return (
      <Box key={i.id} flexDirection="column" width={IW}>
        {line(`${i.id}-a`, left, undefined, IW, keepOf(left, 1))}
        {line(`${i.id}-b`, [{ text: i.task || '(no description)' }], undefined, IW)}
        {line(`${i.id}-c`, chips, undefined, IW)}
      </Box>
    )
  }

  const jobsTab = () => {
    const recent = [...data.jobs].sort((a, b) => b.startedAt - a.startedAt)
    const live = recent.filter(j => ACTIVE.has(j.status))
    const done = recent.filter(j => !ACTIVE.has(j.status))
    const runs = claudeRuns()
    // Rows outside the jobs: header, footer, the clock warning; each group adds its title and,
    // when not tiny, the card's two border rows. Items are taken in order (active jobs, finished
    // jobs, Claude rounds) while they fit; when some do not, one row goes to the "+N hidden" note.
    const groupH = 1 + (isTiny ? 0 : 2)
    // The header (with its profile row) plus the footer, which is taller on the full-width desktop.
    const footerH = isDesk && el.Svg && W >= 60 ? 3.05 : 1
    const warningH = data.clockLost ? 1 : 0
    const showFooter = !isDesk || data.rows >= headerH + footerH + warningH + 1
    const fixed = headerH + (showFooter ? footerH : 0) + warningH
    const showSummary = !isDesk || data.rows >= fixed + 1
    const sum = (list: Job[]) => list.reduce((n, j) => n + jobHeight(j), 0)
    const need = fixed + (live.length ? groupH + sum(live) : 0) + (done.length ? groupH + sum(done) : 0) +
      (runs.length ? groupH + runs.length * RUN_H : 0)
    const shownLive: Job[] = []
    const shownDone: Job[] = []
    const shownRuns: Run[] = []
    if (need <= data.rows) {
      shownLive.push(...live)
      shownDone.push(...done)
      shownRuns.push(...runs)
    } else {
      let room = data.rows - fixed - 1
      const take = <T,>(list: T[], into: T[], height: (item: T) => number) => {
        for (const item of list) {
          const cost = height(item) + (into.length ? 0 : groupH)
          if (cost > room) return false
          into.push(item)
          room -= cost
        }
        return true
      }
      if (take(live, shownLive, jobHeight) && take(done, shownDone, jobHeight)) take(runs, shownRuns, () => RUN_H)
    }
    const hiddenLive = live.length - shownLive.length
    const hiddenDone = done.length - shownDone.length
    const hiddenRuns = runs.length - shownRuns.length
    const group = (key: string, list: unknown[], total: number, extra: Seg[] = []) => (
      <Box key={key} flexDirection="column">
        <Box paddingX={isTiny ? 0 : 1} width={W}>
          {line(`${key}-h`, [{ text: key, bold: true }, { text: String(total), dim: true }, ...extra], undefined, isTiny ? W : W - 2)}
        </Box>
        {card(`${key}-card`, list, { dim: true })}
      </Box>
    )
    const hiddenJobs = hiddenLive + hiddenDone
    return [
      header(),
      clockWarning(),
      showSummary && data.jobs.length === 0 && runs.length === 0 ? note('empty', { dim: true, text: 'No Pantheon jobs in this session.' }) : null,
      shownLive.length ? group('active', shownLive.map(jobRows), live.length) : null,
      shownDone.length ? group('finished', shownDone.map(jobRows), done.length) : null,
      shownRuns.length ? group('Claude agent rounds', shownRuns.map(runRows), runs.length, [chip('read-only', 'inactive')]) : null,
      showSummary && hiddenJobs + hiddenRuns ? note('more', {
        dim: true,
        text: hiddenJobs === 0 ? `+${hiddenRuns} Claude rounds hidden`
          : hiddenLive ? `+${hiddenJobs + hiddenRuns} jobs hidden` : `+${hiddenDone + hiddenRuns} older jobs hidden`,
      }) : null,
      showFooter ? footer() : null,
    ]
  }

  // ------------------------------------------------------------ mini
  const mini = () => {
    const s = data.session
    const live = roles.filter(r => r.state === 'active')
    const quiet = roles.filter(r => r.state !== 'active')
    // At most 8 lines: the orchestrator, the active roles and a last line. The orchestrator counts
    // among the active, so six lines at most are active ones and the rest collapse into "+N".
    const avail = Math.max(1, Math.min(8, data.rows))
    const capacity = Math.max(0, Math.min(5, avail - 2))
    const shown = live.slice(0, capacity)
    const delegating = delegatingSegs()
    const lines: unknown[] = []
    const ctx = s.context
    const ctxSegs: Seg[] = ctx && ctx.percent !== null
      ? [{ text: 'ctx', dim: true }, ...bar(ctx.percent, 6), { text: `${Math.round(ctx.percent)}%`, dim: true }] : []

    // Keep the clock failure visible before giving space to optional session details.
    const profileW = data.clockLost ? Math.max(1, Math.min(W - 18, data.profileLockedBy ? 64 : 28))
      : W < (data.profileLockedBy ? 48 : 24) ? W : Math.min(W - 16, data.profileLockedBy ? 64 : 28)
    lines.push(<Box key="m-o" width={W} gap={profileW < W ? 1 : 0} overflow="hidden">
      {profileRow(profileW)}
      {profileW < W ? line('m-session', [
        ...(data.clockLost ? [{ text: 'clock unavailable', bold: true, color: ROUND }] : []),
        { text: 'pantheon', bold: true, color: ROUND },
        { text: s.isRunning ? '●' : '○', color: s.isRunning ? RUN : undefined, dim: !s.isRunning },
        { text: 'orchestrator' },
        ...(s.model ? [{ text: `${modelName(s.model)}${s.effort ? ` ${s.effort}` : ''}`, dim: true }] : []),
        ...(s.isRunning && s.turnStartedAt ? [clockSeg('clk-orchestrator', s.turnStartedAt, null, 'text', true)] : []),
        ...ctxSegs,
        ...(delegating.length ? [{ text: '→', dim: true }, ...delegating] : []),
      ], undefined, W - profileW - 1) : null}
    </Box>)

    for (const slot of shown) {
      const act = activeOf(slot)
      const per = Math.floor((W - 14) / act.length)
      const segs: Seg[] = [pulseSeg(`mpulse-${slot.name}`), { text: slot.name.padEnd(9), color: ENGINE_COLOR[slot.engine] }]
      act.forEach((i, k) => {
        if (k) segs.push({ text: '│', dim: true })
        const tags = (i.status === 'background' ? 3 : 0) + (i.rounds.length > 1 ? 6 : 0)
        segs.push({ text: i.id, bold: true })
        if (i.rounds.length > 1) segs.push({ text: `↻ r${i.rounds.length}`, color: ROUND })
        if (i.activity) segs.push({ text: clip(i.activity, Math.max(0, per - i.id.length - 8 - tags)), color: ACTIVITY })
        if (i.status === 'background') segs.push({ text: 'bg', dim: true })
        segs.push(clockSeg(`clk-${i.id}`, i.startedAt, null, 'text', true))
      })
      if (slot.seatsOff?.length) segs.push({ text: `⊘ ${slot.seatsOff.join(', ')} off`, dim: true })
      lines.push(line(`m-${slot.name}`, segs, undefined, W))
    }

    // With one or no spare line the last line goes first, and with a single line the orchestrator's alone.
    const more = live.length - shown.length
    // Other subagents get one summary ahead of the quiet roles, so active work outside the roles shows.
    const others = roster.others
    const othersOn = others.filter(i => i.isActive).length
    const othersSeg: Seg[] = others.length
      ? [othersOn
        ? { text: `● ${othersOn} other agent${othersOn > 1 ? 's' : ''}`, color: ENGINE_COLOR.claude }
        : { text: `○ ${others.length} other agent${others.length > 1 ? 's' : ''}`, dim: true }]
      : []
    if (avail >= 2) {
      lines.push(line('m-last', [
        ...(more > 0 ? [{ text: `+${more} active`, color: RUN }] : []),
        ...othersSeg,
        ...quiet.map((r): Seg => r.state === 'off'
          ? { text: `⊘ ${r.name} off`, dim: true }
          : { text: `○ ${r.name}${r.lastEndedAt !== undefined ? ` ${ago(now - r.lastEndedAt)} ago` : ''}`, dim: true }),
      ], [{ text: '/pantheon for details', dim: true }], W, 0))
    }
    return lines
  }

  const children = layout === 'mini' ? mini() : data.tab === 'jobs' ? jobsTab() : agentsTab()
  return isDesk
    ? <Box key="pantheon-desktop" flexDirection="column" width={outerW} paddingX={inset} backgroundColor={DESK_PANEL}>{children}</Box>
    : <Box flexDirection="column" width={W} backgroundColor={undefined}>{children}</Box>
}
