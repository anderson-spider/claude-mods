// The tree as data: directory listings kept as read, and the rows they flatten to under the expanded directories.
// Nothing here reads the disk; register.tsx lists a directory only when it is shown expanded.
import type { FileExplorerEntry, FileExplorerListing } from '../types'
import type { Config } from './config'
import { join } from './paths'

export type Entry = FileExplorerEntry
export type Listing = FileExplorerListing

/** One row of the drawn tree. `kind: 'more'` stands for entries a listing left out, `'loading'` for one not read yet. */
export type Row = {
  path: string
  name: string
  depth: number
  kind: Entry['kind'] | 'more' | 'loading'
  isLink: boolean
  isOpen: boolean
  isIgnored: boolean
}

/** The most entries one listing keeps; a directory larger than this shows a `… N more` row. */
export const MAX_ENTRIES = 2000
/** The most rows the tree flattens to, and how deep it goes, whatever is expanded. */
export const MAX_ROWS = 20_000
export const MAX_DEPTH = 32

export const isHiddenName = (name: string) => name.startsWith('.')

// Case-insensitive with digit runs compared as numbers (`file2` before `file10`); written out because the hooks
// environment promises no `Intl`.
const collator = {
  compare(a: string, b: string): number {
    const x = a.toLowerCase().match(/\d+|\D+/g) ?? []
    const y = b.toLowerCase().match(/\d+|\D+/g) ?? []
    for (let i = 0; i < Math.min(x.length, y.length); i++) {
      const p = x[i] ?? ''
      const q = y[i] ?? ''
      if (p === q) continue
      const isNumber = /^\d/.test(p) && /^\d/.test(q)
      if (isNumber && Number(p) !== Number(q)) return Number(p) - Number(q)
      return p < q ? -1 : 1
    }
    return x.length - y.length || (a < b ? -1 : a > b ? 1 : 0)
  },
}
const extension = (name: string) => {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

/** Directories first, then by the configured order; names break ties so the order never jitters. */
export function sortEntries(entries: readonly Entry[], sort: Config['sort']): Entry[] {
  return [...entries].sort((a, b) => {
    const dirs = Number(b.kind === 'dir') - Number(a.kind === 'dir')
    if (dirs !== 0) return dirs
    if (sort === 'type') {
      const byType = collator.compare(extension(a.name), extension(b.name))
      if (byType !== 0) return byType
    }
    if (sort === 'modified' && a.mtimeMs !== b.mtimeMs) return b.mtimeMs - a.mtimeMs
    return collator.compare(a.name, b.name)
  })
}

/** A listing from what the host listed: sorted, cut to `MAX_ENTRIES`. */
export function listingOf(entries: readonly Entry[], mtimeMs: number, sort: Config['sort']): Listing {
  const sorted = sortEntries(entries, sort)
  return { entries: sorted.slice(0, MAX_ENTRIES), omitted: Math.max(0, sorted.length - MAX_ENTRIES), mtimeMs }
}

export type FlattenOptions = { showHidden: boolean; ignore: readonly string[] }

/** The rows under `root`: each listed entry, and below every expanded directory its own rows, depth-first. */
export function flatten(root: string, dirs: Readonly<Record<string, Listing>>, expanded: ReadonlySet<string>, options: FlattenOptions): Row[] {
  const rows: Row[] = []
  const ignored = new Set(options.ignore)
  const walk = (dir: string, depth: number) => {
    const listing = dirs[dir]
    if (!listing) {
      rows.push({ path: `${dir}/…`, name: 'loading…', depth, kind: 'loading', isLink: false, isOpen: false, isIgnored: false })
      return
    }
    for (const entry of listing.entries) {
      if (rows.length >= MAX_ROWS) return
      if (!options.showHidden && isHiddenName(entry.name)) continue
      const path = join(dir, entry.name)
      const isOpen = entry.kind === 'dir' && expanded.has(path)
      rows.push({ path, name: entry.name, depth, kind: entry.kind, isLink: entry.isLink, isOpen, isIgnored: ignored.has(entry.name) })
      if (isOpen && depth + 1 < MAX_DEPTH) walk(path, depth + 1)
    }
    if (listing.omitted > 0 && rows.length < MAX_ROWS) {
      rows.push({ path: `${dir}/…more`, name: `… ${listing.omitted} more`, depth, kind: 'more', isLink: false, isOpen: false, isIgnored: false })
    }
  }
  walk(root, 0)
  return rows
}

/** The first row to show so that `cursor` stays inside a window of `height` rows starting near `top`. */
export function scrollTop(top: number, cursor: number, height: number, total: number): number {
  if (height <= 0) return 0
  let next = top
  if (cursor < next) next = cursor
  if (cursor >= next + height) next = cursor - height + 1
  return Math.max(0, Math.min(next, Math.max(0, total - height)))
}
