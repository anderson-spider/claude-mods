import { expect, test } from 'claude-code/testing'
import { MAX_ENTRIES, flatten, listingOf, scrollTop, sortEntries } from '../hooks/tree'
import type { Entry } from '../hooks/tree'

const file = (name: string, mtimeMs = 0): Entry => ({ name, kind: 'file', isLink: false, size: 1, mtimeMs })
const dir = (name: string): Entry => ({ name, kind: 'dir', isLink: false, size: 0, mtimeMs: 0 })

test('folders come first, then names in natural order, by extension or newest first as configured', () => {
  const entries = [file('b10.ts', 3), file('b2.ts', 1), dir('z'), file('a.md', 2), dir('A')]
  expect(sortEntries(entries, 'name').map(one => one.name)).toEqual(['A', 'z', 'a.md', 'b2.ts', 'b10.ts'])
  expect(sortEntries(entries, 'type').map(one => one.name)).toEqual(['A', 'z', 'a.md', 'b2.ts', 'b10.ts'])
  expect(sortEntries(entries, 'modified').map(one => one.name)).toEqual(['A', 'z', 'b10.ts', 'a.md', 'b2.ts'])
})

test('a listing keeps its first entries and counts the rest', () => {
  const listing = listingOf(Array.from({ length: MAX_ENTRIES + 5 }, (_, i) => file(`f${i}`)), 7, 'name')
  expect(listing.entries).toHaveLength(MAX_ENTRIES)
  expect(listing).toMatchObject({ omitted: 5, mtimeMs: 7 })
})

test('the rows walk only the expanded folders, hide dotfiles unless asked, and wait on folders not read yet', () => {
  const dirs = {
    '/p': listingOf([dir('src'), dir('docs'), file('.env'), file('a.ts')], 1, 'name'),
    '/p/src': listingOf([file('x.ts'), dir('sub')], 1, 'name'),
  }
  const shown = flatten('/p', dirs, new Set(['/p/src', '/p/src/sub']), { showHidden: false, ignore: ['docs'] })
  expect(shown.map(row => `${row.depth}${row.kind === 'dir' ? (row.isOpen ? '-' : '+') : ' '}${row.name}${row.isIgnored ? '!' : ''}`))
    .toEqual(['0+docs!', '0-src', '1-sub', '2 loading…', '1 x.ts', '0 a.ts'])
  expect(flatten('/p', dirs, new Set(), { showHidden: true, ignore: [] }).map(row => row.name)).toContain('.env')
  expect(flatten('/p', {}, new Set(), { showHidden: false, ignore: [] }).map(row => row.kind)).toEqual(['loading'])
})

test('the window follows the cursor and never runs past the rows', () => {
  expect(scrollTop(0, 12, 10, 50)).toBe(3)
  expect(scrollTop(20, 5, 10, 50)).toBe(5)
  expect(scrollTop(45, 49, 10, 50)).toBe(40)
  expect(scrollTop(3, 2, 10, 5)).toBe(0)
  expect(scrollTop(3, 2, 0, 5)).toBe(0)
})
