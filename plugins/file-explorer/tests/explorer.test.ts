import { expect, test } from 'claude-code/testing'
import type { FileExplorerView } from '../types'
import { DEFAULTS } from '../hooks/config'
import { EMPTY_VIEW, navigate, revealed, rowStates, settled, treeRows, viewAt } from '../hooks/explorer'
import { listingOf } from '../hooks/tree'
import type { Entry } from '../hooks/tree'

const file = (name: string): Entry => ({ name, kind: 'file', isLink: false, size: 1, mtimeMs: 0 })
const dir = (name: string): Entry => ({ name, kind: 'dir', isLink: false, size: 0, mtimeMs: 0 })
const DIRS = { '/p': listingOf([dir('src'), file('a.ts')], 1, 'name'), '/p/src': listingOf([file('x.ts')], 1, 'name') }
const at = (cursor: string, expanded: string[] = []) => ({ ...viewAt('/p', false, false), cursor, expanded })
const rowsOf = (view: FileExplorerView) => treeRows(view, DIRS, DEFAULTS)

test('moves stop at the ends; page keys move a window at a time', () => {
  const view = at('/p/src')
  expect(navigate(view, rowsOf(view), 'k', 10).view.cursor).toBe('/p/src')
  expect(navigate(view, rowsOf(view), 'j', 10).view.cursor).toBe('/p/a.ts')
  expect(navigate(view, rowsOf(view), 'pagedown', 10).view.cursor).toBe('/p/a.ts')
  expect(navigate(view, rowsOf(view), 'end', 10).view.cursor).toBe('/p/a.ts')
  expect(navigate(view, rowsOf(view), 'nope', 10).view).toBe(view)
})

test('l opens a folder and asks for its listing; h closes it, then goes to the parent', () => {
  const closed = at('/p/src')
  const opened = navigate(closed, rowsOf(closed), 'l', 10)
  expect(opened.view.expanded).toEqual(['/p/src'])
  expect(opened.effect).toEqual({ kind: 'load', dir: '/p/src' })
  expect(navigate(opened.view, rowsOf(opened.view), 'l', 10).view.cursor).toBe('/p/src/x.ts')
  const inside = at('/p/src/x.ts', ['/p/src'])
  expect(navigate(inside, rowsOf(inside), 'h', 10).view.cursor).toBe('/p/src')
  expect(navigate(opened.view, rowsOf(opened.view), 'h', 10).view.expanded).toEqual([])
})

test('a file hands its effect on: Enter activates, Space previews, e edits, a mentions, y copies', () => {
  const view = at('/p/a.ts')
  const effect = (key: string) => navigate(view, rowsOf(view), key, 10).effect
  expect(effect('return')).toEqual({ kind: 'activate', path: '/p/a.ts' })
  expect(effect(' ')).toEqual({ kind: 'preview', path: '/p/a.ts' })
  expect(effect('e')).toEqual({ kind: 'editor', path: '/p/a.ts' })
  expect(effect('a')).toEqual({ kind: 'mention', path: '/p/a.ts' })
  expect(effect('y')).toEqual({ kind: 'copy', path: '/p/a.ts' })
  expect(effect('/')).toEqual({ kind: 'search' })
  expect(navigate(view, rowsOf(view), '.', 10).view.showHidden).toBe(true)
})

test('a hit in search reveals; revealing expands every folder down to the file and leaves search', () => {
  const searching = { ...at('/p/a.ts'), mode: 'search' as const, hits: ['src/x.ts'], hitCursor: 0 }
  expect(navigate(searching, [{ path: '/p/src/x.ts', name: 'src/x.ts', depth: 0, kind: 'file', isLink: false, isOpen: false, isIgnored: false }], 'return', 10).effect)
    .toEqual({ kind: 'reveal', path: '/p/src/x.ts' })
  expect(revealed(searching, '/p/src/x.ts')).toMatchObject({ mode: 'tree', cursor: '/p/src/x.ts', expanded: ['/p/src'] })
  expect(revealed(searching, '/elsewhere/x.ts')).toBe(searching)
})

test('a cursor whose file went away moves to the row now in its place, the last one past the end', () => {
  // Rows: src/, src/x.ts, a.ts. The gone file stood second.
  const view = at('/p/src/gone.ts', ['/p/src'])
  expect(settled(view, rowsOf(view), 10, 1).cursor).toBe('/p/src/x.ts')
  expect(settled(view, rowsOf(view), 10, 9).cursor).toBe('/p/a.ts')
  expect(settled({ ...EMPTY_VIEW, root: '/p', cursor: '/p/a.ts' }, rowsOf(at('/p')), 10, 0).cursor).toBe('/p/a.ts')
  expect(settled({ ...EMPTY_VIEW, root: '/p', cursor: null }, [], 10, 3).cursor).toBeNull()
})

test('row states carry marks, git letters and the dot of a collapsed folder with a mark inside', () => {
  const view = at('/p/a.ts')
  const states = rowStates(rowsOf(view), 1, [{ path: '/p/src/x.ts', kind: 'read', at: 0 }], {
    branch: { name: 'main', ahead: 0, behind: 0 }, files: { '/p/a.ts': 'M' }, lines: { '/p/a.ts': { added: 1, removed: 0 } }, dirs: {},
  }, '/p', 10)
  expect(states[0]).toEqual({ hasMarkBelow: true, isCursor: false })
  expect(states[1]).toEqual({ hasMarkBelow: false, isCursor: true, git: 'M', lines: { added: 1, removed: 0 } })
})
