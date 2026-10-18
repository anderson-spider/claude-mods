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

/** One run of text in a row: its tone's colour, and bold, dim or inverse. */
export type Segment = { t: string; c?: string; b?: true; d?: true; i?: true }

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
  isCursor: boolean
}

export type RowContext = { columns: number; config: Config }

/** One tree row as segments filling exactly `columns` cells. */
export function rowSegments(row: Row, state: RowState, { columns, config }: RowContext): Segment[] {
  const c = (tone: Tone) => colorOf(tone, config.theme)
  const flash = config.animations && state.mark?.isFlashing === true
  const left: Segment[] = []
  const right: Segment[] = []

  // Column 0: Claude's mark, then a space (a dot in its tone), or a dim one for a mark inside a collapsed directory.
  if (state.mark) left.push({ t: '●', c: c(state.mark.kind) })
  else if (state.hasMarkBelow) left.push({ t: '•', c: c('dim') })
  else left.push({ t: ' ' })
  left.push({ t: ' '.repeat(1 + row.depth * 2) })

  if (row.kind === 'more' || row.kind === 'loading') {
    left.push({ t: row.name, c: c('dim'), d: true })
  } else {
    const icon = iconOf(row.name, row.kind, row.isOpen, row.isLink, config.icons)
    const tone: Tone = state.mark ? state.mark.kind : row.kind === 'dir' ? 'accent' : 'dim'
    left.push({ t: `${icon} `, c: c(tone) })
    const nameTone: Tone = flash && state.mark ? state.mark.kind
      : state.git ? GIT_TONE[state.git]
      : row.kind === 'dir' ? 'accent' : 'text'
    const name: Segment = { t: row.name + (row.kind === 'dir' ? '/' : ''), c: c(nameTone) }
    if (flash) name.b = true
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

  return fit(left, right, columns, state.isCursor)
}

/** `left` cut and padded so that `right` ends at `columns`; the cursor row is drawn inverse across the width. */
function fit(left: Segment[], right: Segment[], columns: number, isCursor: boolean): Segment[] {
  // A right side that does not leave the name 8 cells is dropped rather than drawn over it.
  const fullRight = right.reduce((sum, one) => sum + width(one.t), 0)
  const tail = columns - fullRight >= 8 ? right : []
  const rightWidth = tail === right ? fullRight : 0
  let room = Math.max(0, columns - rightWidth)
  const shown: Segment[] = []
  for (const one of left) {
    if (room <= 0) break
    const t = cut(one.t, room)
    room -= width(t)
    shown.push({ ...one, t })
  }
  const used = shown.reduce((sum, one) => sum + width(one.t), 0) + tail.reduce((sum, one) => sum + width(one.t), 0)
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

/** A short age: `now`, `12s`, `4m`, `2h`. */
export function ago(ms: number): string {
  if (ms < 2000) return 'now'
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`
  return `${Math.floor(ms / 3_600_000)}h`
}
