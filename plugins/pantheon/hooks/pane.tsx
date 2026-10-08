import type { Elements, RenderSurface } from 'claude-code'

import type { RailProps } from './rail'
import { ago } from './roster'
import type { Engine, Instance, Roster, Slot } from './roster'
import type { ConfigResult, Job, SessionInfo } from './types'

export const PANE_ID = 'pantheon'

const ACTIVE = new Set(['running', 'background'])

export function statusText(jobs: Job[]): string | undefined {
  const running = jobs.filter(job => job.status === 'running').length
  const background = jobs.filter(job => job.status === 'background').length
  if (!running && !background) return undefined
  return `pantheon: ${running} rodando · ${background} em background`
}

export function isResumable(job: Job): boolean {
  return !!job.sessionId && !ACTIVE.has(job.status)
}

export function configReport(state: ConfigResult): string {
  const lines = [state.ok ? 'Config válida.' : `Config inválida: ${state.error}`]
  lines.push('', 'Config efetiva:', JSON.stringify(state.config, null, 2))
  if (state.ok) {
    const origins = Object.entries(state.origins).filter(([, origin]) => origin !== 'default')
    lines.push('', 'Origem (campos fora do padrão):')
    lines.push(...(origins.length ? origins.map(([field, origin]) => `- ${field}: ${origin}`) : ['- todos os campos no padrão']))
  }
  return lines.join('\n')
}

export type DoctorFacts = {
  codexVersion?: string
  loginStatus?: string
  loginOk: boolean
  config: ConfigResult
  root: string
  isRepo: boolean
}

export function doctorReport(facts: DoctorFacts): string {
  const mark = (ok: boolean) => (ok ? 'ok ' : 'falha')
  return [
    `${mark(!!facts.codexVersion)} codex no PATH${facts.codexVersion ? `: ${facts.codexVersion}` : ' — instale o Codex CLI'}`,
    `${mark(facts.loginOk)} codex login status${facts.loginStatus ? `: ${facts.loginStatus}` : ''}`,
    `${mark(facts.config.ok)} config${facts.config.ok ? '' : `: ${facts.config.error}`}`,
    `ok  raiz autorizada: ${facts.root}${facts.isRepo ? '' : ' (fora de repositório git: --skip-git-repo-check)'}`,
  ].join('\n')
}

// ---------------------------------------------------------------- drawing

type Base = Pick<Elements['terminal'], 'Box' | 'Text' | 'Button'>
type RailBuild = (p: { key: string; width: number; props: RailProps }) => unknown
type ClockBuild = (p: {
  key: string
  width: number
  props: { since: number; now: number; endAt: number | null; color: string }
}) => unknown

/**
 * Box, Text and Button from `$.ui.resolve(e)`, `Svg` where the surface draws it. The Client
 * builders live in register.tsx: the engine reads a Client's module path off the entry source.
 */
export type PanelElements = Base & {
  Svg?: Elements['desktop']['Svg']
  rail?: RailBuild
  clock?: ClockBuild
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
  tab: 'agents' | 'jobs'
  hasClient: boolean
  onTab: (tab: 'agents' | 'jobs') => void
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
// Hex values of the Desktop artboard, for the SVG timeline (which draws its own card).
const HEX = {
  codex: '#1d4f9e', claude: '#6b37b3', mixed: '#5b6270', codexSoft: '#c7d6ef', claudeSoft: '#e1d4f4',
  ink: '#1d1f23', muted: '#5b6270', grid: '#ece9e2', turn: '#dcd8cf', amber: '#7a4f00',
  card: '#ffffff', edge: '#e1ded6', dot: '#b9b4a8', pill: '#f0eee9',
}

const GLYPH: Record<string, { text: string; color: string; label: string }> = {
  running: { text: '●', color: RUN, label: 'running' },
  background: { text: '◐', color: ACTIVITY, label: 'background' },
  done: { text: '✓', color: RUN, label: 'done' },
  error: { text: '✗', color: FAULT, label: 'error' },
  cancelled: { text: '⊘', color: 'inactive', label: 'cancelled' },
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

function tokensText(i: Instance): string {
  return i.engine === 'codex'
    ? `in ${kilo(i.tokens.input)} · cached ${kilo(i.tokens.cached)} · out ${kilo(i.tokens.out)}`
    : `ctx ${kilo(i.tokens.ctx)} · out ${kilo(i.tokens.out)} · ${i.tokens.steps ?? 0} steps`
}

const engineLabel = (slot: Slot) => (slot.engine === 'mixed' ? 'codex + claude' : slot.engine)
const activeOf = (slot: Slot) => slot.instances.filter(i => i.isActive)
const resumeOf = (slot: Slot) => slot.instances.find(i => i.resumeId)?.resumeId

export function copyText(job: Job): string {
  return `${job.id}\nresume: delegate({ agent: "${job.agent}", resume: "${job.id}", prompt: … })`
}

type Seg = { text?: string; color?: string; bold?: boolean; dim?: boolean; bg?: string; node?: unknown; w?: number }
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

export function drawPanel(el: PanelElements, data: PanelData): unknown {
  const { Box, Text, Button } = el
  const layout = layoutOf(data.surface, data.placement)
  const isDesk = layout === 'desktop'
  const W = Math.max(30, data.columns)
  const IW = W - 4
  const { now, roster } = data
  const hasRail = data.hasClient && !!el.rail
  const hasClock = data.hasClient && !!el.clock
  const [orch, ...roles] = roster.slots

  const text = (s: Seg) => (
    <Text color={s.color} bold={s.bold} dimColor={s.dim} backgroundColor={s.bg} wrap="truncate">{s.text}</Text>
  )
  const render = (segs: Seg[]) => segs.map(s => (s.node ? s.node : text(s)))
  const note = (key: string, s: Seg) => <Box key={key}>{text({ ...s, text: clip(s.text ?? '', W) })}</Box>

  // One line: the left segments are cut to what the right ones leave.
  const line = (key: string, left: Seg[], right: Seg[] | undefined, width: number) => (
    <Box key={key} justifyContent="space-between" gap={1} width={width}>
      <Box gap={1} flexShrink={1}>{render(fit(left, right ? width - widthOf(right) - 1 : width))}</Box>
      {right && <Box gap={1} flexShrink={0}>{render(right)}</Box>}
    </Box>
  )

  const clockSeg = (key: string, since: number, endAt: number | null, color: string, bold = false): Seg => {
    if (since <= 0) return { text: '—', color }
    if (hasClock) return { node: el.clock!({ key, width: 6, props: { since, now, endAt, color } }), w: 6 }
    return { text: fmtClock((endAt ?? now) - since), color, bold }
  }

  // An active role gets the animated connector with the pulsing mark; the others a static mark.
  const leadSeg = (key: string, slot: Slot, width: number): Seg => {
    const color = ENGINE_COLOR[slot.engine]
    if (slot.state === 'active' && hasRail) {
      return {
        node: el.rail!({
          key, width,
          props: { active: true, width, color, dim: 'inactive', marks: [], isMerge: false, glyph: { on: '●', off: '○' } },
        }),
        w: width + 1,
      }
    }
    return slot.state === 'active' ? { text: '●', color: RUN }
      : slot.state === 'off' ? { text: '⊘', dim: true } : { text: '○', dim: true }
  }

  const card = (key: string, children: unknown[], style: { border?: string; dim?: boolean; color?: string } = {}) => (
    <Box
      key={key}
      flexDirection="column"
      borderStyle={style.border ?? (isDesk ? 'round' : 'single')}
      borderColor={style.color}
      borderDimColor={style.dim}
      paddingX={1}
      width={W}
    >
      {children}
    </Box>
  )

  // ------------------------------------------------------------ header and footer
  const tabButton = (tab: 'agents' | 'jobs', label: string) => (
    <Button
      key={`tab-${tab}`}
      label={data.tab === tab ? `● ${label}` : label}
      hotkey={tab === 'agents' ? '1' : '2'}
      onPress={() => data.onTab(tab)}
    />
  )
  const header = () => {
    const c = roster.counts
    return (
      <Box key="header" justifyContent="space-between" gap={1} width={W}>
        <Box gap={1} flexShrink={1}>
          <Text bold color={ROUND}>{isDesk ? 'Pantheon' : 'PANTHEON'}</Text>
          {tabButton('agents', 'Agents')}
          {tabButton('jobs', `Jobs ${data.jobs.length}`)}
        </Box>
        {data.tab === 'agents' ? (
          <Box flexShrink={0}>
            <Text color={RUN} wrap="truncate">{`${c.active} active`}</Text>
            <Text dimColor wrap="truncate">{` · ${c.idle} idle · ${c.off} off`}</Text>
          </Box>
        ) : (
          <Text dimColor wrap="truncate">codex jobs · this session</Text>
        )}
      </Box>
    )
  }
  const footer = () => note('footer', {
    dim: true,
    text: data.tab === 'agents' ? '1 agents · 2 jobs · esc close' : '1 agents · 2 jobs · ↻ resumable · Copy = id + resume hint',
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

  const orchestratorCard = () => {
    const s = data.session
    const running = s.isRunning
    const model = [s.model, s.effort ? `effort ${s.effort}` : ''].filter(Boolean).join(' · ')
    const rows: unknown[] = [
      line('o1', [
        { text: running ? '●' : '○', color: running ? RUN : undefined, dim: !running },
        { text: 'orchestrator', bold: true },
        { text: 'main session', dim: true },
      ], model ? [{ text: clip(model, 28), dim: true }] : undefined, IW),
      line('o2', [
        { text: 'turn', dim: true },
        { text: running ? 'running' : 'idle', color: running ? RUN : undefined, dim: !running },
        ...(running && s.turnStartedAt ? [clockSeg('clk-orchestrator', s.turnStartedAt, null, 'text', true)] : []),
      ], !running && s.lastTurnMs !== undefined ? [{ text: `last turn ${fmtClock(s.lastTurnMs)}`, dim: true }] : undefined, IW),
    ]
    const ctx = s.context
    if (ctx && ctx.percent !== null) {
      const [on, off] = bar(ctx.percent, Math.max(6, Math.min(20, IW - 24)))
      rows.push(line('o3', [
        { text: 'ctx', dim: true }, on, off,
        { text: kilo(ctx.tokens), bold: true },
        { text: `/${kilo(ctx.window)} ${Math.round(ctx.percent)}%`, dim: true },
      ], undefined, IW))
    }
    if (roster.delegating.length) {
      rows.push(line('o4', [{ text: 'delegating →', dim: true }, ...delegatingSegs()], undefined, IW))
    }
    return card('orchestrator', rows, { color: 'inactive' })
  }

  const instanceRows = (i: Instance, index: number, count: number): unknown[] => {
    const isLast = index === count - 1
    const stem = isDesk ? '' : count > 1 && !isLast ? '│' : ' '
    const branch = isDesk ? '' : count > 1 && !isLast ? '├' : '└'
    const rounds = i.rounds.length
    const tags: Seg[] = [
      ...(i.status === 'background' ? [{ text: 'bg', dim: true }] : []),
      ...(rounds > 1 ? [{ text: `↻ round ${rounds}`, color: ROUND, bold: true }] : []),
    ]
    const pad = isDesk ? '' : `${stem}   `
    const out: unknown[] = [
      line(`${i.id}-a`, [
        ...(branch ? [{ text: branch, dim: true }] : []),
        { text: i.id, bold: true },
        ...(i.seat ? [{ text: i.seat, color: ENGINE_COLOR[i.engine] }] : []),
        { text: clip(i.task || '(no description)', Math.max(4, IW - 22)) },
        ...tags,
      ], [clockSeg(`clk-${i.id}`, i.startedAt, null, 'text', true)], IW),
    ]
    if (i.activity) {
      out.push(line(`${i.id}-b`, [{ text: `${pad}↳`, dim: true }, { text: i.activity, color: ACTIVITY }], undefined, IW))
    }
    if (hasTokens(i)) out.push(line(`${i.id}-c`, [{ text: `${pad}  ${tokensText(i)}`.trimEnd(), dim: true }], undefined, IW))
    if (rounds > 1) {
      const shown = i.rounds.slice(-4)
      out.push(line(`${i.id}-d`, [
        { text: `${pad}  rounds`.trimEnd(), dim: true },
        ...shown.map((r, k): Seg => (r.endedAt === undefined && i.isActive && k === shown.length - 1)
          ? { text: '■ now', color: ROUND }
          : { text: `■ ${fmtClock((r.endedAt ?? now) - r.startedAt)}`, dim: true }),
      ], undefined, IW))
    }
    return out
  }
  const instanceHeight = (i: Instance) => 1 + (hasTokens(i) ? 1 : 0) + (i.activity ? 1 : 0) + (i.rounds.length > 1 ? 1 : 0)

  const activeCard = (slot: Slot) => {
    const live = activeOf(slot)
    const color = ENGINE_COLOR[slot.engine]
    const label = `${engineLabel(slot)}${slot.model ? ` · ${slot.model}` : ''}`
    return card(`role-${slot.name}`, [
      line(`${slot.name}-h`, [
        leadSeg(`rail-${slot.name}`, slot, 3),
        { text: slot.name, bold: true, color },
        ...(live.length > 1 ? [{ text: `×${live.length}`, bold: true }] : []),
        isDesk ? { text: ` ${label} `, color: 'inverseText', bg: color } : { text: label, dim: true },
      ], [{ text: `${live.length} running`, color: RUN }], IW),
      ...live.flatMap((i, k) => instanceRows(i, k, live.length)),
    ], { dim: true })
  }

  const idleCard = (slot: Slot) => {
    const isOff = slot.state === 'off'
    const resume = resumeOf(slot)
    const right: Seg[] = isOff
      ? [{ text: 'off', dim: true }, { text: slot.offReason ?? 'disabledAgents', dim: true }]
      : [{
        text: [
          'idle',
          slot.lastEndedAt !== undefined ? `last ${ago(now - slot.lastEndedAt)} ago` : undefined,
          slot.seatsOff?.length ? `${slot.seatsOff.join(', ')} off` : undefined,
          resume ? `${resume} ↻` : undefined,
        ].filter(Boolean).join(' · '),
        dim: true,
      }]
    return card(`role-${slot.name}`, [
      line(`${slot.name}-h`, [
        { text: isOff ? '⊘' : '○', dim: true },
        { text: slot.name, color: isOff ? undefined : ENGINE_COLOR[slot.engine], dim: isOff },
        ...(isOff ? [] : [{ text: engineLabel(slot), dim: true }]),
      ], right, IW),
    ], { dim: true, border: isOff ? 'dashed' : undefined })
  }

  const othersLine = () => {
    const list = [...roster.others].sort((a, b) => Number(b.isActive) - Number(a.isActive))
    return line('others', [
      { text: 'other agents', dim: true },
      ...list.slice(0, 3).map((i): Seg => ({ text: `${i.id} ${clip(i.task, 18)}`, color: ENGINE_COLOR[i.engine] })),
      ...(list.length > 3 ? [{ text: `+${list.length - 3}`, dim: true }] : []),
    ], undefined, W)
  }

  const agentsTab = () => {
    const live = roles.filter(s => s.state === 'active')
    const tail = roles.filter(s => s.state !== 'active')
    // Rows the always-shown part takes; idle and off lines (3 rows each) fill what is left, from the top.
    const orchH = 4 + (data.session.context?.percent != null ? 1 : 0) + (roster.delegating.length ? 1 : 0)
    const liveH = live.reduce((n, s) => n + 3 + activeOf(s).reduce((m, i) => m + instanceHeight(i), 0), 0)
    const used = 1 + orchH + liveH + (roster.others.length ? 1 : 0) + 1 + 2
    let room = Math.floor((data.rows - used) / 3)
    let shown = tail
    let hidden = 0
    if (room < tail.length) {
      room = Math.max(0, Math.floor((data.rows - used - 1) / 3))
      shown = tail.slice(0, room)
      hidden = tail.length - room
    }
    return [
      header(),
      isDesk && el.Svg ? timelineCard() : null,
      orchestratorCard(),
      ...live.map(activeCard),
      ...shown.map(idleCard),
      hidden ? note('hidden', { dim: true, text: `+${hidden} idle or off · /pantheon to see all` }) : null,
      roster.others.length ? othersLine() : null,
      footer(),
    ]
  }

  // ------------------------------------------------------------ timeline (desktop)
  function timelineCard() {
    const Svg = el.Svg!
    const span = 900_000
    const t0 = now - span
    const SW = 490
    const x0 = 84
    const x1 = 484
    const xOf = (t: number) => x0 + ((Math.min(now, Math.max(t0, t)) - t0) / span) * (x1 - x0)
    const hex = (e: Engine | 'mixed') => HEX[e]
    const soft = (e: Engine) => (e === 'claude' ? HEX.claudeSoft : HEX.codexSoft)
    const inWindow = (i: Instance) => i.rounds.some(r => (r.endedAt ?? now) >= t0)
    const pitch = 28
    const sub = 18
    const lanes: { top: number; slot: Slot }[] = []
    let y = 34
    for (const slot of [orch, ...roles]) {
      lanes.push({ top: y, slot })
      y += pitch + sub * (Math.max(1, slot.instances.filter(inWindow).length) - 1)
    }
    const axisY = y + 8
    const height = axisY + 14
    let body = `<rect x="0.5" y="0.5" width="${SW - 1}" height="${height - 1}" rx="10" fill="${HEX.card}" stroke="${HEX.edge}"/>`
    body += `<text x="14" y="21" font-size="13" font-weight="600" fill="${HEX.ink}">Last 15 minutes</text>`
    body += `<text x="${SW - 14}" y="21" font-size="11" text-anchor="end" fill="${HEX.muted}">solid = running · outline = finished</text>`
    for (const m of [0, 5, 10]) {
      const gx = x0 + (m / 15) * (x1 - x0)
      body += `<line x1="${gx}" y1="30" x2="${gx}" y2="${axisY - 14}" stroke="${HEX.grid}"/>`
    }
    body += `<line x1="${x1}" y1="30" x2="${x1}" y2="${axisY - 14}" stroke="${HEX.ink}" stroke-dasharray="3 3"/>`
    for (const { top, slot } of lanes) {
      const cy = top + 8
      const n = activeOf(slot).length
      const labelFill = slot.name === 'orchestrator' ? HEX.ink : slot.state === 'active' ? hex(slot.engine) : HEX.muted
      body += `<text x="14" y="${cy + 3}" font-size="11" font-weight="${slot.state === 'active' ? 600 : 400}" fill="${labelFill}">${esc(n > 1 ? `${slot.name} ×${n}` : slot.name)}</text>`
      if (slot.name === 'orchestrator') {
        const s = data.session
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
      const seen = slot.instances.filter(inWindow)
      if (!seen.length) {
        body += `<text x="${x0 + 6}" y="${cy + 3}" font-size="10" fill="${HEX.muted}">${slot.lastEndedAt !== undefined ? `last run ${ago(now - slot.lastEndedAt)} ago` : 'idle'}</text>`
        continue
      }
      seen.forEach((i, k) => {
        const by = top + 2 + k * sub
        const rounds = i.rounds.filter(r => (r.endedAt ?? now) >= t0)
        rounds.forEach((r, m) => {
          const ex = xOf(r.endedAt ?? now)
          const sx = xOf(r.startedAt)
          const w = Math.max(3, ex - sx)
          body += r.endedAt === undefined && i.isActive
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
    return <Svg key="timeline" source={source} alt="Last 15 minutes: one lane per role, a bar for each run" width={SW} height={height} />
  }

  // ------------------------------------------------------------ jobs tab
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
    return (
      <Box key={job.id} flexDirection="column" width={IW}>
        <Box justifyContent="space-between" gap={1} width={IW}>
          <Box gap={1} flexShrink={1}>{render(fit(left, IW - 18))}</Box>
          <Box gap={1} flexShrink={0}>
            {isLive && <Button key={`cancel-${job.id}`} label="Cancel" onPress={() => data.onCancel(job.id)} />}
            <Button key={`copy-${job.id}`} label="Copy" onPress={press => data.onCopy(copyText(job), press.surface)} />
          </Box>
        </Box>
        <Box gap={1} width={IW}>{render(fit(detail, IW))}</Box>
        {isLive && job.lastActivity && note('act', { text: clip(`↳ ${job.lastActivity}`, IW), color: ACTIVITY })}
        {isLive && job.tokens && note('tok', {
          dim: true,
          text: `in ${kilo(job.tokens.input)} · cached ${kilo(job.tokens.cached)} · out ${kilo(job.tokens.output)}`,
        })}
      </Box>
    )
  }
  const jobHeight = (job: Job) => 2 + (ACTIVE.has(job.status) ? (job.lastActivity ? 1 : 0) + (job.tokens ? 1 : 0) : 0)

  const jobsTab = () => {
    const recent = [...data.jobs].sort((a, b) => b.startedAt - a.startedAt)
    const live = recent.filter(j => ACTIVE.has(j.status))
    const done = recent.filter(j => !ACTIVE.has(j.status))
    let room = data.rows - 8 - live.reduce((n, j) => n + jobHeight(j), 0)
    const shownDone: Job[] = []
    for (const j of done) {
      if (room < jobHeight(j) && shownDone.length) break
      shownDone.push(j)
      room -= jobHeight(j)
    }
    const group = (key: string, list: Job[], total: number) => (
      <Box key={key} flexDirection="column">
        <Box gap={1} paddingX={1}><Text bold>{key}</Text><Text dimColor>{String(total)}</Text></Box>
        {card(`${key}-card`, list.map(jobRows), { dim: true })}
      </Box>
    )
    return [
      header(),
      data.jobs.length === 0 ? note('empty', { dim: true, text: 'No Pantheon jobs in this session.' }) : null,
      live.length ? group('active', live, live.length) : null,
      shownDone.length ? group('finished', shownDone, done.length) : null,
      shownDone.length < done.length ? note('more', { dim: true, text: `+${done.length - shownDone.length} older jobs hidden` }) : null,
      footer(),
    ]
  }

  // ------------------------------------------------------------ mini
  const mini = () => {
    const s = data.session
    const live = roles.filter(r => r.state === 'active')
    const quiet = roles.filter(r => r.state !== 'active')
    const capacity = Math.max(1, Math.min(8, data.rows) - 2)
    const shown = live.slice(0, capacity)
    const delegating = delegatingSegs()
    const lines: unknown[] = []
    const ctx = s.context
    const ctxSegs: Seg[] = ctx && ctx.percent !== null
      ? [{ text: 'ctx', dim: true }, ...bar(ctx.percent, 6), { text: `${Math.round(ctx.percent)}%`, dim: true }] : []

    lines.push(line('m-o', [
      { text: 'pantheon', bold: true, color: ROUND },
      { text: s.isRunning ? '●' : '○', color: s.isRunning ? RUN : undefined, dim: !s.isRunning },
      { text: 'orchestrator' },
      ...(s.model ? [{ text: `${s.model}${s.effort ? ` ${s.effort}` : ''}`, dim: true }] : []),
      ...(s.isRunning && s.turnStartedAt ? [clockSeg('clk-orchestrator', s.turnStartedAt, null, 'text', true)] : []),
      ...ctxSegs,
      ...(delegating.length ? [{ text: '→', dim: true }, ...delegating] : []),
    ], undefined, W))

    for (const slot of shown) {
      const act = activeOf(slot)
      const color = ENGINE_COLOR[slot.engine]
      const per = Math.floor((W - 14) / act.length)
      const segs: Seg[] = [
        hasRail
          ? {
            node: el.rail!({
              key: `mrail-${slot.name}`, width: 1,
              props: { active: true, width: 1, color, dim: 'inactive', marks: [], isMerge: false, glyph: { on: '●', off: '○' } },
            }),
            w: 2,
          }
          : { text: '●', color: RUN },
        { text: slot.name.padEnd(9), color },
      ]
      act.forEach((i, k) => {
        if (k) segs.push({ text: '│', dim: true })
        const tags = (i.status === 'background' ? 3 : 0) + (i.rounds.length > 1 ? 6 : 0)
        segs.push({ text: i.id, bold: true })
        if (i.rounds.length > 1) segs.push({ text: `↻ r${i.rounds.length}`, color: ROUND })
        if (i.activity) segs.push({ text: clip(i.activity, Math.max(0, per - i.id.length - 8 - tags)), color: ACTIVITY })
        if (i.status === 'background') segs.push({ text: 'bg', dim: true })
        segs.push(clockSeg(`clk-${i.id}`, i.startedAt, null, 'text', true))
      })
      lines.push(line(`m-${slot.name}`, segs, undefined, W))
    }

    const more = live.length - shown.length
    lines.push(line('m-last', [
      ...(more > 0 ? [{ text: `+${more} active`, color: RUN }] : []),
      ...quiet.map((r): Seg => r.state === 'off'
        ? { text: `⊘ ${r.name} off`, dim: true }
        : { text: `○ ${r.name}${r.lastEndedAt !== undefined ? ` ${ago(now - r.lastEndedAt)} ago` : ''}`, dim: true }),
    ], [{ text: '/pantheon for details', dim: true }], W))
    return lines
  }

  const children = layout === 'mini' ? mini() : data.tab === 'jobs' ? jobsTab() : agentsTab()
  return <Box flexDirection="column" width={W}>{children}</Box>
}
