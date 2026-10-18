// What the pane shows, as plain data: each tree row cut to the width as coloured segments, the header and the
// footer. The rows' surface module (rows.tsx) only paints these segments; nothing here reads the host.
import type { ActivityKind } from './activity'
import type { Config } from './config'
import type { GitCode, GitStatus } from './git'
import { iconOf } from './icons'
import type { Row } from './tree'

export type Tone =
  | 'text' | 'dim' | 'accent'
  | ActivityKind
  | 'gitM' | 'gitA' | 'gitD' | 'gitR' | 'gitU' | 'gitQ'

/**
 * One run of text in a row: its tone's colour, and bold, dim, inverse or shimmering (a light passing over it). A
 * shimmer's `g` holds its colours from the rest of the name to the light's centre; without it the light is drawn in
 * `c` by intensity alone.
 */
export type Segment = { t: string; c?: string; b?: true; d?: true; i?: true; s?: true; g?: string[] }

// `auto` follows the person's Claude Code theme through theme keys; `dark` and `light` are fixed colours.
const PALETTES: Record<Config['theme'], Record<Tone, string>> = {
  auto: {
    text: 'text', dim: 'inactive', accent: 'suggestion',
    read: 'suggestion', searched: 'permission', modified: 'warning', created: 'success', removed: 'error', committed: 'merged',
    gitM: 'warning', gitA: 'success', gitD: 'error', gitR: 'suggestion', gitU: 'error', gitQ: 'success',
  },
  dark: {
    text: '#d4d4d4', dim: '#7f848e', accent: '#61afef',
    read: '#61afef', searched: '#c678dd', modified: '#e5c07b', created: '#98c379', removed: '#e06c75', committed: '#56b6c2',
    gitM: '#e5c07b', gitA: '#98c379', gitD: '#e06c75', gitR: '#61afef', gitU: '#e06c75', gitQ: '#98c379',
  },
  light: {
    text: '#1f2328', dim: '#59636e', accent: '#0550ae',
    read: '#0550ae', searched: '#8250df', modified: '#9a6700', created: '#1a7f37', removed: '#cf222e', committed: '#0e7490',
    gitM: '#9a6700', gitA: '#1a7f37', gitD: '#cf222e', gitR: '#0550ae', gitU: '#cf222e', gitQ: '#1a7f37',
  },
}

export const colorOf = (tone: Tone, theme: Config['theme']) => PALETTES[theme][tone]

/** `a` moved `t` of the way to `b`, both `#rrggbb`. */
function mix(a: string, b: string, t: number): string {
  const channel = (hex: string, i: number) => parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16)
  return `#${[0, 1, 2].map(i => Math.round(channel(a, i) + (channel(b, i) - channel(a, i)) * t).toString(16).padStart(2, '0')).join('')}`
}

// A fixed theme's shimmer runs from the tone sunk into the background to the tone lit toward the text's extreme.
const SHIMMER_ENDS: Record<'dark' | 'light', { base: string; light: string }> = {
  dark: { base: '#282c34', light: '#ffffff' },
  light: { base: '#ffffff', light: '#000000' },
}

/**
 * A shimmer's colours in `tone`, rest of the name first, centre last. The `auto` theme names theme keys, whose colours
 * a mod cannot read, so it has none and the light is drawn by intensity.
 */
export function shimmerOf(tone: Tone, theme: Config['theme']): string[] | undefined {
  if (theme === 'auto') return undefined
  const color = PALETTES[theme][tone]
  const ends = SHIMMER_ENDS[theme]
  return [mix(color, ends.base, 0.45), color, mix(color, ends.light, 0.35), mix(color, ends.light, 0.7)]
}

const GIT_TONE: Record<GitCode, Tone> = { M: 'gitM', A: 'gitA', D: 'gitD', R: 'gitR', U: 'gitU', '?': 'gitQ' }

export const ACTIVITY_LABEL: Record<ActivityKind, string> = {
  read: 'read', searched: 'found', modified: 'edited', created: 'created', removed: 'removed', committed: 'committed',
}

/** The cells a string takes, counting each code point as one (the glyphs used here are all one cell). */
export const width = (text: string) => [...text].length

/** `text` cut to `room` cells, an ellipsis marking the cut. */
export function cut(text: string, room: number): string {
  const chars = [...text]
  if (chars.length <= room) return text
  if (room <= 0) return ''
  return `${chars.slice(0, room - 1).join('')}…`
}

/** What a row shows besides its tree position: Claude's mark on it, its git state and whether the cursor is on it. */
export type RowState = {
  mark?: { kind: ActivityKind; isFlashing: boolean }
  /** A mark somewhere under a collapsed directory. */
  hasMarkBelow: boolean
  git?: GitCode
  lines?: { added: number; removed: number }
  dirGit?: { code: GitCode; count: number }
  /** Claude is writing this file now. */
  isEditing?: boolean
  isCursor: boolean
}

export type RowContext = { columns: number; config: Config; now: number }

/** The modified column's width: its longest age, `yesterday`. */
const AGE_WIDTH = 9

/** One tree row as segments filling exactly `columns` cells. */
export function rowSegments(row: Row, state: RowState, { columns, config, now }: RowContext): Segment[] {
  const c = (tone: Tone) => colorOf(tone, config.theme)
  // A file Claude is writing carries the edited mark until the write ends and its own mark replaces it.
  const mark = state.isEditing ? { kind: 'modified' as const, isFlashing: false } : state.mark
  const flash = config.animations && mark?.isFlashing === true
  const left: Segment[] = []
  const right: Segment[] = []
  const date: Segment[] = []

  // Column 0: Claude's mark, then a space (a dot in its tone), or a dim one for a mark inside a collapsed directory.
  if (mark) left.push({ t: '●', c: c(mark.kind) })
  else if (state.hasMarkBelow) left.push({ t: '•', c: c('dim') })
  else left.push({ t: ' ' })
  left.push({ t: ' '.repeat(1 + row.depth * 2) })

  if (row.kind === 'more' || row.kind === 'loading') {
    left.push({ t: row.name, c: c('dim'), d: true })
  } else {
    const icon = iconOf(row.name, row.kind, row.isOpen, row.isLink, config.icons)
    const tone: Tone = mark ? mark.kind : row.kind === 'dir' ? 'accent' : 'dim'
    left.push({ t: `${icon} `, c: c(tone) })
    const nameTone: Tone = (flash || state.isEditing) && mark ? mark.kind
      : state.git ? GIT_TONE[state.git]
      : row.kind === 'dir' ? 'accent' : 'text'
    const name: Segment = { t: row.name + (row.kind === 'dir' ? '/' : ''), c: c(nameTone) }
    // A touch shimmers for a moment, and a write for as long as it runs, in the touch's tone.
    if (mark && (flash || (state.isEditing && config.animations))) {
      name.s = true
      const gradient = shimmerOf(mark.kind, config.theme)
      if (gradient) name.g = gradient
    }
    if (row.isIgnored || state.git === 'D') name.d = true
    left.push(name)
    if (row.isLink) left.push({ t: ' ↪', c: c('dim') })
  }

  if (config.git !== 'off') {
    if (state.git) {
      if (config.git === 'full' && state.lines && (state.lines.added > 0 || state.lines.removed > 0)) {
        right.push({ t: ` +${state.lines.added}`, c: c('gitA') }, { t: ` -${state.lines.removed}`, c: c('gitD') })
      }
      right.push({ t: ` ${state.git}`, c: c(GIT_TONE[state.git]), b: true })
    } else if (state.dirGit) {
      right.push({ t: ` ${state.dirGit.count}${state.dirGit.code}`, c: c(GIT_TONE[state.dirGit.code]) })
    }
  }

  if (config.mtime && row.kind === 'file' && row.mtimeMs > 0) date.push({ t: ` ${age(now - row.mtimeMs).padStart(AGE_WIDTH)}`, c: c('dim') })

  return fit(left, [right, date], columns, state.isCursor)
}

const widthOf = (segments: readonly Segment[]) => segments.reduce((sum, one) => sum + width(one.t), 0)

/**
 * `left` cut and padded so that the right-hand columns end at `columns`; the cursor row is drawn inverse across the
 * width. The columns are given most wanted first: the last that does not leave the name 8 cells is dropped first.
 */
function fit(left: Segment[], sides: readonly Segment[][], columns: number, isCursor: boolean): Segment[] {
  let kept = sides.length
  while (kept > 0 && columns - widthOf(sides.slice(0, kept).flat()) < 8) kept--
  const tail = sides.slice(0, kept).flat()
  let room = Math.max(0, columns - widthOf(tail))
  const shown: Segment[] = []
  for (const one of left) {
    if (room <= 0) break
    const t = cut(one.t, room)
    room -= width(t)
    shown.push({ ...one, t })
  }
  const used = widthOf(shown) + widthOf(tail)
  const line = [...shown, { t: ' '.repeat(Math.max(0, columns - used)) }, ...tail]
  return isCursor ? line.map(one => ({ ...one, i: true as const })) : line
}

/** The branch line: name, ahead and behind its upstream, and the lines changed in all. */
export function branchSegments(git: GitStatus | undefined, totals: { added: number; removed: number }, config: Config): Segment[] {
  if (!git || config.git === 'off') return []
  const c = (tone: Tone) => colorOf(tone, config.theme)
  const { branch } = git
  const parts: Segment[] = [{ t: `⎇ ${branch.name || '?'}`, c: c('accent'), b: true }]
  if (branch.ahead > 0) parts.push({ t: ` ↑${branch.ahead}`, c: c('gitA') })
  if (branch.behind > 0) parts.push({ t: ` ↓${branch.behind}`, c: c('gitD') })
  if (!branch.upstream) parts.push({ t: ' (no upstream)', c: c('dim') })
  const changed = Object.keys(git.files).length
  if (changed === 0) parts.push({ t: ' clean', c: c('dim') })
  else {
    parts.push({ t: ` ${changed} changed`, c: c('dim') })
    if (config.git === 'full' && (totals.added > 0 || totals.removed > 0)) {
      parts.push({ t: ` +${totals.added}`, c: c('gitA') }, { t: ` -${totals.removed}`, c: c('gitD') })
    }
  }
  return parts
}

/** How long ago a file was modified: `now`, `3m`, `2h`, `yesterday`, `4d`, `3w`, `5mo`, `2y`. */
export function age(ms: number): string {
  const minutes = Math.floor(ms / 60_000)
  const hours = Math.floor(ms / 3_600_000)
  const days = Math.floor(ms / 86_400_000)
  if (minutes < 1) return 'now'
  if (hours < 1) return `${minutes}m`
  if (days < 1) return `${hours}h`
  if (days < 2) return 'yesterday'
  if (days < 7) return `${days}d`
  if (days < 35) return `${Math.floor(days / 7)}w`
  if (days < 365) return `${Math.floor(days / 30)}mo`
  return `${Math.floor(days / 365)}y`
}

/** A short age: `now`, `12s`, `4m`, `2h`. */
export function ago(ms: number): string {
  if (ms < 2000) return 'now'
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`
  return `${Math.floor(ms / 3_600_000)}h`
}
