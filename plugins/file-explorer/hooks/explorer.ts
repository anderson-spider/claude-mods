// The pane's moves as pure steps: from the view and the rows it shows, a key to the next view and the one effect the
// hooks module carries out on the host (list a directory, open a file, write the prompt). Nothing here touches `$`.
import type { FileExplorerView as ExplorerView } from '../types'
import { marksAt } from './activity'
import type { Activity } from './activity'
import type { Config } from './config'
import type { GitStatus } from './git'
import { ancestors, isInside, join, parent } from './paths'
import { flatten, scrollTop } from './tree'
import type { Listing, Row } from './tree'
import type { RowState } from './view'

export const EMPTY_VIEW: ExplorerView = {
  root: '', isPinned: false, expanded: [], cursor: null, top: 0, showHidden: false,
  mode: 'tree', query: '', hits: [], hitCursor: 0,
}

/** A fresh view on `root`, keeping only the person's hidden-files choice. */
export const viewAt = (root: string, isPinned: boolean, showHidden: boolean): ExplorerView => ({ ...EMPTY_VIEW, root, isPinned, showHidden })

/** The rows the tree shows under the view's root. */
export function treeRows(view: ExplorerView, dirs: Readonly<Record<string, Listing>>, config: Config): Row[] {
  if (!view.root) return []
  return flatten(view.root, dirs, new Set(view.expanded), { showHidden: view.showHidden, ignore: config.ignore })
}

/** The search hits as rows: each relative path at depth 0, a directory when the index says so. */
export function hitRows(view: ExplorerView, isDir: (rel: string) => boolean): Row[] {
  return view.hits.map(rel => ({ path: join(view.root, rel), name: rel, depth: 0, kind: isDir(rel) ? 'dir' : 'file', isLink: false, isOpen: false, isIgnored: false }))
}

/** Every directory above a marked path, so a collapsed one shows that something under it was touched. */
export function markedDirs(root: string, marks: ReadonlyMap<string, unknown>): Set<string> {
  const dirs = new Set<string>()
  for (const path of marks.keys()) for (const dir of ancestors(root, path)) dirs.add(dir)
  return dirs
}

/** Each row's mark, git state and cursor, as `rowSegments` draws them. */
export function rowStates(rows: readonly Row[], cursor: number, activity: readonly Activity[], git: GitStatus | null, root: string, now: number): RowState[] {
  const marks = marksAt(activity, now)
  const below = markedDirs(root, marks)
  return rows.map((row, index) => {
    const state: RowState = { hasMarkBelow: row.kind === 'dir' && !row.isOpen && below.has(row.path), isCursor: index === cursor }
    const mark = marks.get(row.path)
    if (mark) state.mark = mark
    const code = git?.files[row.path]
    if (code) state.git = code
    const lines = git?.lines[row.path]
    if (lines) state.lines = lines
    const dir = row.kind === 'dir' ? git?.dirs[row.path] : undefined
    if (dir) state.dirGit = dir
    return state
  })
}

/** What the hooks module does after a move. */
export type Effect =
  | { kind: 'load'; dir: string }
  | { kind: 'activate' | 'preview' | 'editor' | 'mention' | 'copy' | 'reveal'; path: string }
  | { kind: 'search' | 'refresh' | 'back' }

export type Step = { view: ExplorerView; effect?: Effect }

/** The cursor's row index in the tree: the cursor's path, else the first row. */
export function cursorIndex(view: ExplorerView, rows: readonly Row[]): number {
  if (view.mode === 'search') return Math.min(view.hitCursor, Math.max(0, rows.length - 1))
  const index = rows.findIndex(row => row.path === view.cursor)
  return index < 0 ? 0 : index
}

const DOWN = ['j', 'down']
const UP = ['k', 'up']

/**
 * One key on the tree or the hits: moves (`j`/`k`, arrows, page keys, `g`/`G`), opens and closes (`l`/`h`, arrows,
 * Enter, Space), and the keys that hand an effect on (`e` editor, `a` mention, `y` copy, `/` search, `r` refresh,
 * `.` hidden files, `q` back). An unknown key changes nothing.
 */
export function navigate(view: ExplorerView, rows: readonly Row[], key: string, height: number): Step {
  const at = cursorIndex(view, rows)
  const row = rows[at]
  const page = Math.max(1, height - 1)
  const moveTo = (index: number): Step => {
    const target = Math.max(0, Math.min(rows.length - 1, index))
    if (view.mode === 'search') return { view: { ...view, hitCursor: target } }
    const path = rows[target]?.path ?? view.cursor
    return { view: { ...view, cursor: path, top: scrollTop(view.top, target, height, rows.length) } }
  }

  if (DOWN.includes(key)) return moveTo(at + 1)
  if (UP.includes(key)) return moveTo(at - 1)
  if (key === 'pagedown') return moveTo(at + page)
  if (key === 'pageup') return moveTo(at - page)
  if (key === 'g' || key === 'home') return moveTo(0)
  if (key === 'G' || key === 'end') return moveTo(rows.length - 1)
  if (key === '/') return { view, effect: { kind: 'search' } }
  if (key === 'r') return { view, effect: { kind: 'refresh' } }
  if (key === '.') return { view: { ...view, showHidden: !view.showHidden } }
  if (key === 'q') return { view, effect: { kind: 'back' } }
  if (!row || row.kind === 'more' || row.kind === 'loading') return { view }

  if (key === 'a') return { view, effect: { kind: 'mention', path: row.path } }
  if (key === 'y') return { view, effect: { kind: 'copy', path: row.path } }
  if (view.mode === 'search') {
    if (key === 'return' || key === 'l' || key === 'right' || key === 'o') return { view, effect: { kind: 'reveal', path: row.path } }
    return { view }
  }
  if (row.kind === 'dir') {
    if (key === 'l' || key === 'right') return row.isOpen ? moveTo(at + 1) : expand(view, row.path)
    if (key === 'h' || key === 'left') return row.isOpen ? { view: collapse(view, row.path) } : toParent(view, rows, row.path, height)
    if (key === 'return' || key === ' ' || key === 'o') return row.isOpen ? { view: collapse(view, row.path) } : expand(view, row.path)
    return { view }
  }
  if (key === 'h' || key === 'left') return toParent(view, rows, row.path, height)
  if (key === 'return' || key === 'o') return { view, effect: { kind: 'activate', path: row.path } }
  if (key === ' ') return { view, effect: { kind: 'preview', path: row.path } }
  if (key === 'e') return { view, effect: { kind: 'editor', path: row.path } }
  return { view }
}

function expand(view: ExplorerView, dir: string): Step {
  const expanded = view.expanded.includes(dir) ? view.expanded : [...view.expanded, dir]
  return { view: { ...view, expanded, cursor: dir }, effect: { kind: 'load', dir } }
}

/** The view with `dir` and every directory under it collapsed. */
export function collapse(view: ExplorerView, dir: string): ExplorerView {
  return { ...view, expanded: view.expanded.filter(one => !isInside(dir, one)), cursor: dir }
}

function toParent(view: ExplorerView, rows: readonly Row[], path: string, height: number): Step {
  const up = parent(path)
  const index = rows.findIndex(row => row.path === up)
  if (index < 0) return { view }
  return { view: { ...view, cursor: up, top: scrollTop(view.top, index, height, rows.length) } }
}

/** The view with every directory from the root down to `path` expanded and the cursor on it, back in the tree. */
export function revealed(view: ExplorerView, path: string): ExplorerView {
  if (!isInside(view.root, path)) return view
  const opened = ancestors(view.root, path).filter(dir => dir !== view.root)
  const expanded = [...view.expanded, ...opened.filter(dir => !view.expanded.includes(dir))]
  const { preview: _, ...rest } = view
  return { ...rest, expanded, cursor: path, mode: 'tree' }
}

/**
 * The view after the rows changed under it: the cursor kept in view, or, when its row went away, moved to the row now
 * standing at `previous` (where the cursor stood before), the last row when the list got shorter.
 */
export function settled(view: ExplorerView, rows: readonly Row[], height: number, previous: number): ExplorerView {
  if (view.mode !== 'tree') return view
  let index = rows.findIndex(row => row.path === view.cursor)
  let cursor = view.cursor
  if (index < 0) {
    index = Math.max(0, Math.min(previous, rows.length - 1))
    cursor = rows[index]?.path ?? null
  }
  const top = scrollTop(view.top, index, height, rows.length)
  return cursor === view.cursor && top === view.top ? view : { ...view, cursor, top }
}
