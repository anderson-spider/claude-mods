// Pure visual vocabulary for the panel: role and section colors, terminal cell math, gauges, round strips and boxes.
import type { SlotName } from './roster'

export type Run = { text: string; color?: string; dim?: boolean }
export type Line = Run[]
export type StripItem = { state: 'running' | 'done' | 'failed' | 'planned'; role: SlotName }

export const ROLE_COLOR: Record<SlotName, string> = {
  lead: '#5B93E6',
  'code-reader': '#3FA57D',
  'docs-reader': '#C9A24A',
  developer: '#8F96A6',
  architect: '#A56BD8',
  qa: '#4FB3C9',
  ux: '#D870A8',
  council: '#B8B3A6',
}

export const SECTION_COLOR = {
  session: '#5B93E6',
  running: '#4CC2A0',
  idle: '#8F96A6',
  // The amber of a warning (ctx past 70%, a lost run), not a panel section.
  planned: '#D9A441',
  timeline: '#A56BD8',
  log: '#7B8190',
}

export const OK = '#4CC2A0'
export const BAD = '#E5604D'

const COMBINING = [[0x300, 0x36f], [0x483, 0x489], [0x591, 0x5bd], [0x610, 0x61a], [0x64b, 0x65f], [0x1ab0, 0x1aff], [0x1dc0, 0x1dff], [0x200b, 0x200f], [0x20d0, 0x20ff], [0xfe00, 0xfe0f], [0xfe20, 0xfe2f]] as const
const WIDE = [
  [0x1100, 0x115f], [0x231a, 0x231b], [0x2329, 0x232a], [0x23e9, 0x23ec], [0x23f0, 0x23f0], [0x23f3, 0x23f3],
  [0x25fd, 0x25fe], [0x2614, 0x2615], [0x2648, 0x2653], [0x267f, 0x267f], [0x2693, 0x2693], [0x26a1, 0x26a1],
  [0x26aa, 0x26ab], [0x26bd, 0x26be], [0x26c4, 0x26c5], [0x26ce, 0x26ce], [0x26d4, 0x26d4], [0x26ea, 0x26ea],
  [0x26f2, 0x26f3], [0x26f5, 0x26f5], [0x26fa, 0x26fa], [0x26fd, 0x26fd], [0x2705, 0x2705], [0x270a, 0x270b],
  [0x2728, 0x2728], [0x274c, 0x274c], [0x274e, 0x274e], [0x2753, 0x2755], [0x2757, 0x2757], [0x2795, 0x2797],
  [0x27b0, 0x27b0], [0x27bf, 0x27bf], [0x2b1b, 0x2b1c], [0x2b50, 0x2b50], [0x2b55, 0x2b55],
  [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf], [0x4e00, 0xa4cf], [0xa960, 0xa97f], [0xac00, 0xd7a3],
  [0xf900, 0xfaff], [0xfe30, 0xfe6f], [0xff00, 0xff60], [0xffe0, 0xffe6],
  [0x1f300, 0x1f64f], [0x1f680, 0x1f6ff], [0x1f900, 0x1f9ff], [0x1fa70, 0x1faff], [0x20000, 0x3fffd],
] as const

const within = (cp: number, table: readonly (readonly [number, number])[]) => table.some(([a, b]) => cp >= a && cp <= b)

function cpWidth(cp: number): number {
  if (cp === 0 || cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0
  if (within(cp, COMBINING)) return 0
  return within(cp, WIDE) ? 2 : 1
}

/** Width in terminal cells, counted per code point (never `.length`). */
export function cellWidth(s: string): number {
  let w = 0
  for (const ch of s) w += cpWidth(ch.codePointAt(0)!)
  return w
}

export function padCells(s: string, width: number): string {
  return s + ' '.repeat(Math.max(0, width - cellWidth(s)))
}

/** Cuts to at most `width` cells, ending in `…` when anything was removed. */
export function truncCells(s: string, width: number): string {
  if (width <= 0) return ''
  if (cellWidth(s) <= width) return s
  let out = ''
  let w = 0
  for (const ch of s) {
    const cw = cpWidth(ch.codePointAt(0)!)
    if (w + cw > width - 1) break
    out += ch
    w += cw
  }
  return out + '…'
}

export function gauge(pct: number, width: number): { on: string; off: string } {
  const full = Math.min(width, Math.max(0, Math.round((pct / 100) * width)))
  return { on: '▰'.repeat(full), off: '▱'.repeat(Math.max(0, width - full)) }
}

// One round, one cell wide: the gauge's own filled mark, so a lone bar never reads as a text cursor. Rows space them apart.
export const BLOCK = '▰'

export function strip(items: StripItem[]): Run[] {
  return items.map(it => {
    if (it.state === 'running') return { text: BLOCK, color: ROLE_COLOR[it.role] }
    if (it.state === 'done') return { text: BLOCK, color: OK }
    if (it.state === 'failed') return { text: BLOCK, color: BAD }
    return { text: BLOCK, dim: true }
  })
}

/** ╭─ title ─╮ / │ … │ / ╰─╯, every line exactly `width` cells. */
export function boxLines(title: string, color: string, lines: string[], width: number): Line[] {
  const w = Math.max(4, width)
  const inner = w - 2
  const head = truncCells(title, Math.max(0, inner - 3))
  const label = head ? ` ${head} ` : ''
  const fill = Math.max(0, inner - 1 - cellWidth(label))
  const out: Line[] = [[{ text: '╭─', color }, { text: label, color }, { text: '─'.repeat(fill) + '╮', color }]]
  for (const l of lines) {
    out.push([{ text: '│', color }, { text: padCells(truncCells(l, inner - 2), inner - 2).replace(/^/, ' ') + ' ' }, { text: '│', color }])
  }
  out.push([{ text: '╰' + '─'.repeat(inner) + '╯', color }])
  return out
}

/** A friendly model name: 'claude-opus-5-5' -> 'Opus 5.5', 'haiku' -> 'Haiku', 'gpt-5.5' -> 'GPT-5.5'; anything else as given. */
export function modelName(id: string | undefined): string {
  if (!id) return ''
  const bare = id.trim().replace(/\[[^\]]*\]$/, '').replace(/-\d{8}$/, '').replace(/^claude-/i, '')
  const cap = (s: string) => s[0].toUpperCase() + s.slice(1).toLowerCase()
  const ver = (a?: string, b?: string) => (a ? ` ${a}${b ? `.${b}` : ''}` : '')
  const family = /^(opus|sonnet|haiku|fable)(?:-(\d+)(?:-(\d+))?)?$/i.exec(bare)
  if (family) return cap(family[1]) + ver(family[2], family[3])
  const legacy = /^(\d+)(?:-(\d+))?-(opus|sonnet|haiku)$/i.exec(bare)
  if (legacy) return cap(legacy[3]) + ver(legacy[1], legacy[2])
  const gpt = /^gpt-(.+)$/i.exec(bare)
  if (gpt) return `GPT-${gpt[1]}`
  return id.trim()
}
