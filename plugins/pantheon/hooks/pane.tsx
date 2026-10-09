import type { Elements, RenderSurface } from 'claude-code'

import type { RailProps } from './rail'
import { ROLE_COLOR, clawdLines, clawdSvg } from './clawd.ts'
import type { Mood } from './clawd.ts'
import type { MascotProps } from './mascot.tsx'
import { ago } from './roster'
import type { Engine, Instance, Roster, RoundView, Slot, SlotName } from './roster'
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
}

export function doctorReport(facts: DoctorFacts): string {
  const mark = (ok: boolean) => (ok ? 'ok  ' : 'fail')
  return [
    !facts.usesCodex && !facts.codexVersion
      ? `info codex on PATH — not needed by profile ${facts.profile}`
      : `${mark(!!facts.codexVersion)} codex on PATH${facts.codexVersion ? `: ${facts.codexVersion}` : ' — install the Codex CLI'}`,
    !facts.usesCodex && !facts.loginOk
      ? `info codex login status — not needed by profile ${facts.profile}`
      : `${mark(facts.loginOk)} codex login status${facts.loginStatus ? `: ${facts.loginStatus}` : ''}`,
    `${mark(facts.config.ok)} config${facts.config.ok ? '' : `: ${facts.config.error}`}`,
    `${mark(true)} authorized root: ${facts.root}${facts.isRepo ? '' : ' (outside a git repository: --skip-git-repo-check)'}`,
  ].join('\n')
}

// ---------------------------------------------------------------- drawing

type Base = Pick<Elements['terminal'], 'Box' | 'Text' | 'Button'>
type RailBuild = (p: { key: string; width: number; props: RailProps }) => unknown
export type MascotBuild = (p: { key: string; props: MascotProps }) => unknown
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
  rail?: RailBuild
  clock?: ClockBuild
  mascot?: MascotBuild
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
// The Desktop panel is dark: this is the one place its palette lives. Role colors come from clawd.ts.
const HEX = {
  codex: '#6aa3f0', claude: '#b58af0', mixed: '#9a9a94', codexSoft: '#1f3350', claudeSoft: '#35274f',
  ink: '#f4f3ef', muted: '#8f8f8a', grid: '#333331', turn: '#4a4945', amber: '#e0a94a',
  card: '#242423', edge: '#333331', dot: '#5a5955', pill: '#32322f',
  bg: '#1b1b1a', tile: '#272726', green: '#4fb383', red: '#e5604f', track: '#35352f',
}
// The progress track is a hex on both surfaces.
const TRACK = HEX.track

// Desktop text and chips use the panel's hex values instead of the theme names above.
const DESK: Record<string, string> = {
  suggestion: HEX.codex, merged: HEX.claude, success: HEX.green, warning: HEX.amber, error: HEX.red,
  inactive: HEX.muted, text: HEX.ink, inverseText: HEX.bg, cyan: '#8fb8d8',
}
const DESK_SOFT: Record<string, string> = {
  suggestion: HEX.codexSoft, merged: HEX.claudeSoft, success: '#1d3a2d', warning: '#3d3016', text: HEX.pill,
}
const DESK_PANEL = HEX.bg

// A hex color pulled toward `into`, for dimmed (planned) rows on a surface with no dim attribute.
function mix(hex: string, into: string, t: number): string {
  const n = (h: string, k: number) => parseInt(h.slice(1 + k * 2, 3 + k * 2), 16)
  const c = [0, 1, 2].map(k => Math.round(n(hex, k) * (1 - t) + n(into, k) * t))
  return `#${c.map(v => v.toString(16).padStart(2, '0')).join('')}`
}

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
const hasTokens = (i: Instance) => i.engine !== 'codex' || i.tokens.input !== undefined || i.tokens.out > 0

const activeOf = (slot: Slot) => slot.instances.filter(i => i.isActive)

export function copyText(job: Job): string {
  return `${job.id}\nresume: delegate({ agent: "${job.agent}", resume: "${job.id}", prompt: … })`
}

type Seg = { text?: string; color?: string; bold?: boolean; dim?: boolean; bg?: string; chip?: boolean; node?: unknown; w?: number }
const widthOf = (segs: Seg[]) =>
  segs.reduce((n, s, k) => n + (s.node ? s.w ?? 0 : (s.text ?? '').length) + (k ? 1 : 0), 0)

/** Keeps the segments that fit `width` cells (one cell between them), clipping the one that crosses. */
function fit(segs: Seg[], width: number): Seg[] {
  const out: Seg[] = []
  let used = 0
  for (const seg of segs) {
    const gap = out.length ? 1 : 0
    const w = seg.node ? seg.w ?? 0 : (seg.text ?? '').length
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
export function timelineSource(slots: Slot[], session: SessionInfo, now: number): { source: string; width: number; height: number } {
  const span = 900_000
  const t0 = now - span
  const SW = 490
  const x0 = 84
  const x1 = 484
  const xOf = (t: number) => x0 + ((Math.min(now, Math.max(t0, t)) - t0) / span) * (x1 - x0)
  const hex = (e: Engine | 'mixed') => HEX[e]
  const soft = (e: Engine) => (e === 'claude' ? HEX.claudeSoft : HEX.codexSoft)
  const inRange = (r: RoundView) => (endOf(r, now) ?? r.startedAt) >= t0
  const inWindow = (i: Instance) => i.rounds.some(inRange)
  const runs = (slot: Slot) => (slot.history ?? slot.instances).filter(inWindow)
  const pitch = 28
  const sub = 18
  const lanes: { top: number; slot: Slot }[] = []
  let y = 34
  for (const slot of slots) {
    lanes.push({ top: y, slot })
    y += pitch + sub * (Math.max(1, runs(slot).length) - 1)
  }
  const axisY = y + 8
  const height = axisY + 14
  let body = `<rect x="0.5" y="0.5" width="${SW - 1}" height="${height - 1}" rx="10" fill="${HEX.card}" stroke="${HEX.edge}"/>`
  body += `<text x="14" y="21" font-size="13" font-weight="600" fill="${HEX.ink}">Last 15 minutes</text>`
  body += `<text x="${SW - 14}" y="21" font-size="11" text-anchor="end" fill="${HEX.muted}">solid = running · outline = finished · ? = lost</text>`
  for (const m of [0, 5, 10]) {
    const gx = x0 + (m / 15) * (x1 - x0)
    body += `<line x1="${gx}" y1="30" x2="${gx}" y2="${axisY - 14}" stroke="${HEX.grid}"/>`
  }
  body += `<line x1="${x1}" y1="30" x2="${x1}" y2="${axisY - 14}" stroke="${HEX.ink}" stroke-dasharray="3 3"/>`
  for (const { top, slot } of lanes) {
    const cy = top + 8
    const n = activeOf(slot).length
    const labelFill = slot.name === 'orchestrator' ? HEX.ink : slot.state === 'active' ? ROLE_COLOR[slot.name] : HEX.muted
    body += `<text x="14" y="${cy + 3}" font-size="11" font-weight="${slot.state === 'active' ? 600 : 400}" fill="${labelFill}">${esc(n > 1 ? `${slot.name} ×${n}` : slot.name)}</text>`
    if (slot.name === 'orchestrator') {
      const s = session
      if (s.turnStartedAt) {
        const end = s.isRunning ? now : s.turnStartedAt + (s.lastTurnMs ?? 0)
        if (end >= t0) {
          body += `<rect x="${xOf(s.turnStartedAt)}" y="${top + 2}" width="${Math.max(3, xOf(end) - xOf(s.turnStartedAt))}" height="12" rx="3" fill="${s.isRunning ? HEX.ink : HEX.turn}"/>`
        }
      }
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
        body += `<text x="${xOf(rounds[0].startedAt) - 5}" y="${by + 10}" text-anchor="end" font-size="10" font-family="monospace" fill="${HEX.ink}">${esc(i.id)}</text>`
      }
    })
  }
  for (const [m, label] of [[0, '−15m'], [5, '−10m'], [10, '−5m']] as const) {
    body += `<text x="${x0 + (m / 15) * (x1 - x0)}" y="${axisY}" text-anchor="middle" font-size="10" fill="${HEX.muted}">${label}</text>`
  }
  body += `<text x="${x1}" y="${axisY}" text-anchor="end" font-size="10" font-weight="600" fill="${HEX.ink}">now</text>`
  const source = `<svg xmlns="http://www.w3.org/2000/svg" width="${SW}" height="${height}" viewBox="0 0 ${SW} ${height}" font-family="sans-serif">${body}</svg>`
  return { source, width: SW, height }
}

export function drawPanel(el: PanelElements, data: PanelData): unknown {
  const { Box, Button } = el
  const layout = layoutOf(data.surface, data.placement)
  const isDesk = layout === 'desktop'
  const isMini = layout === 'mini'
  // The real width, with no floor: content degrades to fit it. Below 12 columns the cards give up
  // their border and padding, the header its title and tabs, so nothing is wider than the body.
  const W = Math.max(1, data.columns)
  const isTiny = W < 12
  const IW = isTiny ? W : W - 4
  const { now, roster } = data
  const canClient = data.hasClient && !data.clockLost
  const hasRail = canClient && !!el.rail
  const hasClock = canClient && !!el.clock
  const [orch, ...roles] = roster.slots

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

  // A pulsing state dot, one cell wide: an Svg with a SMIL pulse on desktop, a one-cell rail on the
  // terminal (no line, no 110 ms timer), a plain dot where there is no Client.
  const pulseSeg = (key: string): Seg => {
    if (isDesk && el.Svg) {
      const Svg = el.Svg
      const source = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" width="10" height="10"><circle cx="5" cy="5" r="4.5" fill="${HEX.green}"><animate attributeName="opacity" values="1;.35;1" dur="1.6s" repeatCount="indefinite"/></circle></svg>`
      return { node: <Svg key={key} source={source} alt="running" width={10} height={10} isInteractive />, w: 1 }
    }
    if (isDesk || !hasRail) return { text: '●', color: RUN }
    return {
      node: el.rail!({
        key, width: 1,
        props: {
          active: true, width: 1, color: RUN, dim: 'inactive', marks: [], isMerge: false,
          glyph: { on: '●', off: '○' }, isLine: false,
        },
      }),
      w: 1,
    }
  }

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
  const headerH = data.rows >= 2 ? 2 : 1
  const tabButton = (tab: 'agents' | 'jobs', label: string) => (
    <Button
      key={`tab-${tab}`}
      label={data.tab === tab ? `● ${label}` : label}
      hotkey={tab === 'agents' ? '1' : '2'}
      onPress={() => data.onTab(tab)}
    />
  )
  const header = () => {
    const running = roles.reduce((n, r) => n + activeOf(r).length, 0) + roster.others.filter(i => i.isActive).length
    const right: Seg[] = data.tab === 'agents'
      ? W >= 30
        ? running ? [pulseSeg('hdr-dot'), { text: `${running} running`, color: RUN, bold: true }] : [{ text: 'idle', dim: true }]
        : []
      : W >= 60 ? [{ text: 'Codex jobs · Claude rounds', dim: true }] : []
    if (data.onClose && W >= 58) right.push({ node: <Button key="close" label="✕" onPress={() => data.onClose?.()} />, w: 5 })
    // Too narrow for both tabs: one button switches to the other tab.
    const other = data.tab === 'agents' ? 'jobs' : 'agents'
    const tabs = W >= 30
      ? [tabButton('agents', 'Agents'), tabButton('jobs', `Jobs ${data.jobs.length + claudeRuns().length}`)]
      : [<Button key={`tab-${other}`} label={other === 'jobs' ? 'J' : 'A'} hotkey={other === 'jobs' ? '2' : '1'} onPress={() => data.onTab(other)} />]
    return (
      <Box key="header" flexDirection="column" width={W}>
        {headerH > 1 ? (
          <Box justifyContent="space-between" gap={1} width={W}>
            <Box gap={1} flexShrink={1}>
              {W >= 14 ? text({ text: isDesk ? 'Pantheon' : 'PANTHEON', bold: true, color: ROUND }) : null}
              {tabs}
            </Box>
            {right.length ? <Box gap={1} flexShrink={0}>{render(right)}</Box> : null}
          </Box>
        ) : null}
        {profileRow(W)}
      </Box>
    )
  }
  // 7: the warning gets its own row under the header, ahead of everything optional.
  const clockWarning = () => data.clockLost ? note('clock-lost', { text: 'clock unavailable', color: ROUND, bold: true }) : null
  const footer = () => note('footer', {
    dim: true,
    text: [
      data.tab === 'agents' ? '1 agents · 2 jobs · esc close' : '1 agents · 2 jobs · ↻ resumable · Copy = id + resume hint',
    ].join(' · '),
  })

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

  // ------- art
  const MW = 8
  const LW = 15
  const canArt = isDesk ? !!el.Svg : true
  // A mascot: an Svg on desktop, the Client on the terminal, static colorless rows with no Client.
  const art = (key: string, role: SlotName, mood: Mood, size: 'small' | 'large'): unknown => {
    const w = size === 'large' ? LW : MW
    if (isDesk) {
      const Svg = el.Svg!
      const px = size === 'large' ? 92 : 48
      return (
        <Box key={key} width={w} flexShrink={0}>
          <Svg source={clawdSvg(role, mood, px)} alt={`${role} mascot, ${mood}`} width={Math.round((px * 30) / 26)} height={px} isInteractive={mood === 'work'} />
        </Box>
      )
    }
    if (canClient && el.mascot) return <Box key={key} width={w} flexShrink={0}>{el.mascot({ key: `${key}-c`, props: { role, mood, size } })}</Box>
    return (
      <Box key={key} width={w} flexShrink={0} flexDirection="column">
        {clawdLines(role, mood, 0, size).map((row, k) => <Box key={k}>{text({ text: row })}</Box>)}
      </Box>
    )
  }

  // ------- agent rows
  type Group = PanelGroup
  type AgentRow = { key: string; slot: Slot; inst?: Instance; group: Group }
  type Block = { node: unknown; h: number }
  const LABEL: Record<Group, string> = { running: 'Running', finished: 'Finished', planned: 'Planned' }
  const collapsedSet = new Set<string>(data.collapsed ?? [])
  const engineName = (e: Engine | 'mixed' | undefined) => (e && e !== 'mixed' ? ENGINE_COLOR[e] : 'inactive')

  const agentRows = (): Record<Group, AgentRow[]> => {
    const out: Record<Group, AgentRow[]> = { running: [], finished: [], planned: [] }
    for (const slot of roles) {
      for (const inst of slot.instances) {
        const group: Group = inst.isActive ? 'running' : 'finished'
        out[group].push({ key: inst.id, slot, inst, group })
      }
      if (!slot.instances.length) out.planned.push({ key: `plan-${slot.name}`, slot, group: 'planned' })
    }
    return out
  }

  const tokenTotal = (i: Instance) => (i.engine === 'codex' ? (i.tokens.input ?? 0) : (i.tokens.ctx ?? 0)) + i.tokens.out
  const ctxPercent = (i: Instance) => {
    const window = data.session.context?.window
    return i.engine === 'claude' && i.tokens.ctx != null && window ? Math.min(100, Math.round((i.tokens.ctx / window) * 100)) : undefined
  }
  const durationSeg = (key: string, i: Instance, running: boolean): Seg => {
    if (running) return clockSeg(`clk-${i.id}`, i.startedAt, null, 'inactive')
    const end = i.endedAt ?? endOf(i.rounds[i.rounds.length - 1] ?? { startedAt: i.startedAt, status: i.status }, now)
    return { text: end === undefined ? '—' : fmtClock(end - i.startedAt), dim: true }
  }

  // One agent: mascot, bold task, role and model, stats, a thin progress bar in the role color and the
  // state mark. `compact` is the one-line form for short panes.
  const rowBlock = (r: AgentRow, withSep: boolean, compact: boolean): Block => {
    const { slot, inst: i } = r
    const role = slot.name
    const rc = ROLE_COLOR[role]
    const isPlanned = r.group === 'planned'
    const isOff = slot.state === 'off'
    const running = r.group === 'running'
    const mood: Mood = isPlanned ? 'off' : running ? 'work' : 'idle'
    const engine = i?.engine ?? slot.engine
    const model = i?.model ?? slot.model ?? ''
    const g = i ? GLYPH[i.status] ?? GLYPH.done : undefined
    const state: Seg = running ? pulseSeg(`dot-${i!.id}`)
      : isPlanned ? { text: isOff ? '⊘' : '◷', dim: true }
        : { text: g!.text, color: g!.color }
    const task = isPlanned ? (isOff ? 'Disabled' : 'Waiting for work') : clip(i!.task || '(no description)', 200)
    const tag = (i && i.status === 'background' ? [{ text: 'bg', dim: true } as Seg] : [])
    if (compact) {
      const left: Seg[] = [state, { text: role, color: rc, bold: true, dim: isPlanned }, { text: task, dim: isPlanned }, ...tag]
      return { node: <Box key={r.key} width={IW}>{line(`${r.key}-l`, left, i ? [durationSeg(r.key, i, running)] : undefined, IW, keepOf(left, 2))}</Box>, h: 1 }
    }
    const showArt = canArt && IW >= 30
    const CW = showArt ? IW - (MW + 3) : IW
    const pct = i ? ctxPercent(i) : undefined
    const stats: Seg[] = !i ? [] : [
      ...(pct !== undefined || hasTokens(i) ? [{ text: [pct !== undefined ? `ctx ${pct}%` : '', hasTokens(i) ? kilo(tokenTotal(i)) : ''].filter(Boolean).join(' · '), dim: true } as Seg] : []),
      durationSeg(r.key, i, running),
    ]
    const rounds = i?.rounds.length ?? 0
    const l2: Seg[] = [
      { text: role, color: rc, bold: true, dim: isPlanned },
      ...(i?.seat ? [{ text: i.seat, color: engineName(engine) }] : []),
      ...(model ? [{ text: model, dim: true }] : []),
      ...(isOff ? [{ text: slot.offReason ?? 'disabledAgents', dim: true }] : []),
      ...(rounds > 1 ? [chip(`↻ round ${rounds}`, ROUND, true)] : []),
      ...tag,
      ...(i ? [{ text: i.id, dim: true }] : []),
      ...(i?.resumeId ? [{ text: '↻', color: ROUND }] : []),
    ]
    const cells = Math.max(1, CW)
    const ratio = running ? Math.max(0.06, pct !== undefined ? pct / 100 : 0.25) : 1
    const filled = Math.max(1, Math.min(cells, Math.round(ratio * cells)))
    const body: unknown[] = [
      line(`${r.key}-a`, [{ text: task, bold: true, dim: isPlanned }], [state], CW, 1),
      line(`${r.key}-b`, l2, stats, CW, keepOf(l2, 1)),
      isPlanned
        ? <Box key={`${r.key}-c`}>{text({ text: ' ' })}</Box>
        : <Box key={`${r.key}-c`} width={CW}>{render([{ text: '━'.repeat(filled), color: rc }, ...(cells > filled ? [{ text: '─'.repeat(cells - filled), color: TRACK }] : [])]).map(n => n)}</Box>,
    ]
    if (i && running && i.activity) body.push(line(`${r.key}-d`, [{ text: '↳', dim: true }, { text: i.activity, color: ACTIVITY }], undefined, CW))
    if (i && rounds > 1) {
      body.push(line(`${r.key}-e`, [
        { text: 'rounds', dim: true },
        ...i.rounds.slice(-4).map((rd): Seg => {
          const end = endOf(rd, now)
          if (end === undefined) return { text: '■ ?', color: ROUND, dim: true }
          return rd.endedAt === undefined ? { text: '■ now', color: ROUND } : { text: `■ ${fmtClock(end - rd.startedAt)}`, dim: true }
        }),
      ], undefined, CW))
    }
    const lines = body.length
    const stripe = (
      <Box key="stripe" flexDirection="column" flexShrink={0}>
        {Array.from({ length: lines }, (_, k) => <Box key={k}>{text({ text: '▎', color: engineName(engine), dim: isPlanned })}</Box>)}
      </Box>
    )
    const sep = isDesk ? text({ text: '─'.repeat(Math.max(1, IW)), color: HEX.grid }) : text({ text: ' ' })
    return {
      node: (
        <Box key={r.key} flexDirection="column" width={IW}>
          <Box gap={1} width={IW}>
            {showArt ? stripe : null}
            {showArt ? art(`art-${r.key}`, role, mood, 'small') : null}
            <Box flexDirection="column" width={CW} flexShrink={1}>{body}</Box>
          </Box>
          {withSep ? <Box key="sep">{sep}</Box> : null}
        </Box>
      ),
      h: lines + (withSep ? 1 : 0),
    }
  }

  // A group: its heading (fold arrow, name, count, Collapse/Expand) and, unless folded, its rows.
  const groupBlocks = (g: Group, rows: AgentRow[], mode: 'full' | 'compact' | 'head'): Block[] => {
    if (!rows.length) return []
    const isFolded = collapsedSet.has(g)
    const eff = isFolded ? 'head' : mode
    const hw = isTiny ? W : W - 2
    const toggle = W >= 30 && data.onToggle && (isFolded || mode !== 'head')
      ? [{
        node: <Button key={`toggle-${g}`} label={isFolded ? 'Expand' : 'Collapse'} onPress={() => data.onToggle?.(g)} />,
        w: (isFolded ? 'Expand' : 'Collapse').length + 4,
      } as Seg]
      : undefined
    const head: Block = {
      node: (
        <Box key={`${g}-head`} paddingX={isTiny ? 0 : 1} width={W}>
          {line(`${g}-hl`, [
            { text: eff === 'head' ? '▸' : '▾', dim: true },
            { text: LABEL[g], bold: true, dim: g === 'planned' },
            { text: `· ${rows.length}`, dim: true },
          ], toggle, hw)}
        </Box>
      ),
      h: 1,
    }
    if (eff === 'head') return [head]
    const compact = eff === 'compact'
    const built = rows.map((r, k) => rowBlock(r, !compact && k < rows.length - 1, compact))
    const inner = built.map(b => b.node)
    const frame = isDesk
      ? <Box key={`${g}-rows`} flexDirection="column" width={W} paddingX={isTiny ? 0 : 2}>{inner}</Box>
      : card(`${g}-rows`, inner, { dim: true })
    return [head, { node: frame, h: built.reduce((n, b) => n + b.h, 0) + (isDesk || isTiny ? 0 : 2) }]
  }

  // ------- session
  const sumTokens = (): number => {
    const all = [...roles.flatMap(s => s.history ?? s.instances), ...roster.others]
    return all.reduce((n, i) => n + tokenTotal(i), 0) + (data.session.context?.tokens ?? 0)
  }
  const sessionBlocks = (compact: boolean): Block[] => {
    const s = data.session
    const running = s.isRunning
    const model = [s.model, s.effort].filter(Boolean).join(' · ')
    const ctx = s.context?.percent
    const timeSeg = (): Seg => running && s.turnStartedAt
      ? clockSeg('clk-orchestrator', s.turnStartedAt, null, 'text', true)
      : s.lastTurnMs !== undefined ? { text: fmtClock(s.lastTurnMs), bold: true } : { text: '—', dim: true }
    const dot: Seg = running ? pulseSeg('s-dot') : { text: '○', dim: true }
    const orchName: Seg = { text: 'orchestrator', bold: true, color: ROLE_COLOR.orchestrator }
    if (compact) {
      const left: Seg[] = [dot, orchName, ...(model ? [{ text: clip(model, 20), dim: true }] : [])]
      return [{ node: line('o-c', left, running && s.turnStartedAt ? [timeSeg()] : undefined, W, keepOf(left, 2)), h: 1 }]
    }
    const status: Seg[] = [
      dot,
      { text: running ? 'working' : 'idle', color: running ? RUN : undefined, dim: !running },
      ...(ctx != null ? [{ text: `· ctx ${Math.round(ctx)}%`, dim: true } as Seg] : []),
      ...(!running && s.lastTurnMs !== undefined ? [{ text: `· last turn ${fmtClock(s.lastTurnMs)}`, dim: true } as Seg] : []),
    ]
    const cost: Seg = s.costUsd !== undefined ? { text: `≈$${s.costUsd.toFixed(2)}`, bold: true } : { text: '—', dim: true }
    const tokens: Seg = { text: kilo(sumTokens()), bold: true }
    const hasTiles = isDesk && W >= 36
    const showArt = canArt && IW >= 36
    // The terminal draws the session's mascot at the original Claude Code size; the app keeps the large one.
    const sessionSize = isDesk ? 'large' : 'small'
    const TW = showArt ? IW - ((isDesk ? LW : MW) + 2) : IW
    const lines: unknown[] = [
      line('o1', [{ text: 'Main session', bold: true }], undefined, TW),
      line('o2', [orchName, ...(model ? [{ text: clip(model, 28), dim: true } as Seg] : [])], undefined, TW, 1),
      line('o3', status, undefined, TW),
    ]
    if (!hasTiles) {
      if (showArt) lines.push(<Box key="o4"><el.Text> </el.Text></Box>)
      lines.push(line('o5', [{ text: 'Cost', dim: true }, cost, { text: 'Tokens', dim: true }, tokens, { text: 'Time', dim: true }, timeSeg()], undefined, TW))
    }
    if (roster.delegating.length) lines.push(line('o6', [{ text: 'delegating →', dim: true }, ...delegatingSegs()], undefined, TW))
    const content = Math.max(showArt ? (isDesk ? 6 : 3) : 0, lines.length)
    const inner = showArt
      ? <Box key="o-row" gap={2} width={IW}>{art('art-orchestrator', 'orchestrator', running ? 'work' : 'idle', sessionSize)}<Box flexDirection="column" width={TW}>{lines}</Box></Box>
      : <Box key="o-col" flexDirection="column" width={IW}>{lines}</Box>
    const blocks: Block[] = [{
      node: card('session', [inner], { dim: true, color: isDesk ? HEX.card : 'inactive' }),
      h: content + (isTiny ? 0 : 2),
    }]
    if (hasTiles) {
      const tw = Math.floor((W - 2) / 3)
      const tile = (k: string, label: string, value: Seg) => (
        <Box key={k} flexDirection="column" borderStyle="round" borderColor={HEX.edge} backgroundColor={HEX.tile} paddingX={1} width={tw}>
          {text({ text: label, dim: true })}
          <Box>{render([value])}</Box>
        </Box>
      )
      blocks.push({
        node: <Box key="tiles" gap={1} width={W}>{tile('tile-cost', 'Cost', cost)}{tile('tile-tokens', 'Tokens', tokens)}{tile('tile-time', 'Time', timeSeg())}</Box>,
        h: 4,
      })
    }
    return blocks
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
  // 0 everything, 1 the timeline, 2 the planned rows, 3 the finished rows, 4 the session card and the
  // running rows to one line each, 5 the optional lines. Whatever still does not fit is cut from the bottom.
  const buildAgents = (level: number): Block[] => {
    const rows = agentRows()
    const mode = (g: Group): 'full' | 'compact' | 'head' =>
      g === 'planned' ? (level >= 2 ? 'head' : 'full')
        : g === 'finished' ? (level >= 3 ? 'head' : 'full')
          : level >= 4 ? 'compact' : 'full'
    const blocks: Block[] = [{ node: header(), h: headerH }]
    if (data.clockLost) blocks.push({ node: clockWarning(), h: 1 })
    blocks.push(...sessionBlocks(level >= 4))
    for (const g of ['running', 'finished', 'planned'] as const) blocks.push(...groupBlocks(g, rows[g], mode(g)))
    if (level < 5) {
      const off = roles.filter(s => s.seatsOff?.length).flatMap(s => s.seatsOff!)
      if (off.length) blocks.push({ node: line('seats-off', [{ text: '⊘', dim: true }, { text: `${off.join(', ')} off`, dim: true }], undefined, W), h: 1 })
      if (roster.others.length) blocks.push({ node: othersLine(), h: 1 })
    }
    if (level === 0 && isDesk && el.Svg) {
      const t = timelineSource(roster.slots, data.session, now)
      blocks.push({ node: timelineCard(), h: Math.ceil(t.height / 20) })
    }
    if (level < 5) blocks.push({ node: footer(), h: 1 })
    return blocks
  }

  const agentsTab = () => {
    let blocks: Block[] = []
    for (let level = 0; level <= 5; level++) {
      blocks = buildAgents(level)
      if (blocks.reduce((n, b) => n + b.h, 0) <= data.rows) break
    }
    let total = blocks.reduce((n, b) => n + b.h, 0)
    while (total > data.rows && blocks.length > 1) total -= blocks.pop()!.h
    return blocks.map(b => b.node)
  }

  // ------------------------------------------------------------ timeline (desktop)
  function timelineCard() {
    const Svg = el.Svg!
    const { source, width, height } = timelineSource(roster.slots, data.session, now)
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
      ...(i.model ? [{ text: i.model, dim: true } as Seg] : []),
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
    const fixed = headerH + 1 + (data.clockLost ? 1 : 0)
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
      data.jobs.length === 0 && runs.length === 0 ? note('empty', { dim: true, text: 'No Pantheon jobs in this session.' }) : null,
      shownLive.length ? group('active', shownLive.map(jobRows), live.length) : null,
      shownDone.length ? group('finished', shownDone.map(jobRows), done.length) : null,
      shownRuns.length ? group('Claude agent rounds', shownRuns.map(runRows), runs.length, [chip('read-only', 'inactive')]) : null,
      hiddenJobs + hiddenRuns ? note('more', {
        dim: true,
        text: hiddenJobs === 0 ? `+${hiddenRuns} Claude rounds hidden`
          : hiddenLive ? `+${hiddenJobs + hiddenRuns} jobs hidden` : `+${hiddenDone + hiddenRuns} older jobs hidden`,
      }) : null,
      footer(),
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
        ...(s.model ? [{ text: `${s.model}${s.effort ? ` ${s.effort}` : ''}`, dim: true }] : []),
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
  return <Box flexDirection="column" width={W} backgroundColor={isDesk ? DESK_PANEL : undefined}>{children}</Box>
}
