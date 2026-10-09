import { ROLE_COLOR, OK, BAD, cellWidth, padCells, truncCells } from '../theme'
import type { Roster } from '../roster'

// The agents summary above the info row: up to three short flightdeck-style cards (round border,
// pulse and role in the top edge, clock beside it) or, below CARD_MIN_COLUMNS, one row each.
// Pure: colors come from theme.ts, the clock from the `now` the caller reads.

export type AgentView = {
  id: string
  /** A pantheon role slot name ("explorer", "council", ...) or "agent" for anything else. */
  role: string
  task: string
  startedAt: number
  status: 'running' | 'failed'
  /** When it failed: the clock stops there. */
  endedAt?: number
}

export const MAX_CARDS = 3
/** Below this width the cards become one-line rows. */
export const CARD_MIN_COLUMNS = 90
const CARD_MAX_WIDTH = 44
/** A failed agent stays in the summary this long, only while another is running. */
export const FAIL_GRACE_MS = 20_000
const NEUTRAL = '#8F96A6'
const TEXT = '#d6d9de'
const DIM = '#7B8190'
export const PULSE = '●'

type Run = { text: string; color?: string; dim?: boolean; bold?: boolean }

const roleColor = (role: string): string => (ROLE_COLOR as Record<string, string>)[role] ?? NEUTRAL

/** m:ss, or HhMM from an hour on (as the panel's clocks). */
export function fmtClock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(s / 60)
  return m < 60 ? `${m}:${String(s % 60).padStart(2, '0')}` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`
}

/**
 * The agents to show, from the roster: running ones by start, then ones that failed within the
 * grace window. Nothing at all unless something is running.
 */
export function agentsFromRoster(roster: Roster, now: number): AgentView[] {
  const running: AgentView[] = []
  const failed: AgentView[] = []
  const slots = roster.slots.filter(s => s.name !== 'orchestrator').flatMap(s => s.instances.map(i => ({ role: s.name as string, i })))
  const all = [...slots, ...roster.others.map(i => ({ role: 'agent', i }))]
  for (const { role, i } of all) {
    const task = i.task || (i.seat ? `seat ${i.seat}` : role)
    if (i.isActive) running.push({ id: i.id, role, task, startedAt: i.startedAt, status: 'running' })
    else if ((i.status === 'failed' || i.status === 'error') && now - (i.endedAt ?? i.startedAt) <= FAIL_GRACE_MS) {
      failed.push({ id: i.id, role, task, startedAt: i.startedAt, status: 'failed', endedAt: i.endedAt })
    }
  }
  if (running.length === 0) return []
  running.sort((a, b) => a.startedAt - b.startedAt)
  failed.sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))
  return [...running, ...failed]
}

/** A key that changes when the visible set does (to redraw on start and end). */
export function agentsKey(agents: AgentView[]): string {
  return agents.map(a => `${a.id}:${a.status}`).join(',')
}

const pulseOf = (a: AgentView): Run => ({ text: PULSE, color: a.status === 'failed' ? BAD : OK })
const clockOf = (a: AgentView, now: number): string => fmtClock((a.endedAt ?? now) - a.startedAt)

function cardRows(a: AgentView, width: number, now: number): Run[][] {
  const color = roleColor(a.role)
  const head: Run[] = [{ text: '╭─ ', color }, pulseOf(a), { text: ` ${truncCells(a.role, Math.max(1, width - 14))} `, color, bold: true }]
  const tail: Run[] = [{ text: ` ${clockOf(a, now)} `, color: TEXT, bold: true }, { text: '─╮', color }]
  const used = head.reduce((n, r) => n + cellWidth(r.text), 0) + tail.reduce((n, r) => n + cellWidth(r.text), 0)
  const top = [...head, { text: '─'.repeat(Math.max(0, width - used)), color }, ...tail]
  const body = width - 4
  return [
    top,
    [{ text: '│ ', color }, { text: padCells(truncCells(a.task, body), body), color: TEXT }, { text: ' │', color }],
    [{ text: `╰${'─'.repeat(width - 2)}╯`, color }],
  ]
}

/** The summary as rows of runs: 3 rows of cards, or one row per agent plus "+N more". */
export function agentLines(agents: AgentView[], columns: number, now: number): Run[][] {
  if (agents.length === 0) return []
  const shown = agents.slice(0, MAX_CARDS)
  const more = agents.length - shown.length
  const room = columns - 2
  if (columns >= CARD_MIN_COLUMNS) {
    const gap = 1
    const width = Math.min(CARD_MAX_WIDTH, Math.floor((room - gap * (shown.length - 1)) / shown.length))
    const cards = shown.map(a => cardRows(a, width, now))
    return [0, 1, 2].map(r => {
      const row: Run[] = [{ text: ' ' }]
      cards.forEach((c, i) => { if (i) row.push({ text: ' ' }); row.push(...c[r]) })
      if (r === 1 && more > 0) row.push({ text: ` +${more} more`, dim: true })
      return row
    })
  }
  const roleW = 9
  const rows = shown.map((a): Run[] => {
    const clock = clockOf(a, now)
    const taskW = Math.max(1, room - 2 - roleW - 1 - cellWidth(clock) - 1)
    return [
      { text: ' ' }, pulseOf(a), { text: ' ' },
      { text: padCells(truncCells(a.role, roleW - 1), roleW), color: roleColor(a.role), bold: true },
      { text: padCells(truncCells(a.task, taskW), taskW), color: TEXT }, { text: ' ' },
      { text: clock, color: TEXT, bold: true },
    ]
  })
  if (more > 0) rows.push([{ text: `   +${more} more`, color: DIM }])
  return rows
}

/** The summary as an element tree, or null when nothing runs. */
export function drawAgents(elements: any, agents: AgentView[], columns: number, now: number): unknown {
  const lines = agentLines(agents, columns, now)
  if (lines.length === 0) return null
  const { Box, Text } = elements
  return Box({
    key: 'agents',
    flexDirection: 'column',
    children: lines.map((row, r) => Box({
      key: `agents-r${r}`,
      flexDirection: 'row',
      children: row.map((run, k) => Text({
        key: `t${k}`,
        ...(run.color ? { color: run.color } : {}),
        ...(run.dim ? { dimColor: true } : {}),
        ...(run.bold ? { bold: true } : {}),
        children: run.text,
      })),
    })),
  })
}
