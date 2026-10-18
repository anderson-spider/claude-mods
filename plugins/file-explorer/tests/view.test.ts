import { expect, test } from 'claude-code/testing'
import { DEFAULTS } from '../hooks/config'
import { iconOf } from '../hooks/icons'
import type { Row } from '../hooks/tree'
import { ago, branchSegments, cut, rowSegments, width } from '../hooks/view'

const row = (name: string, extra: Partial<Row> = {}): Row => ({ path: `/p/${name}`, name, depth: 0, kind: 'file', isLink: false, isOpen: false, isIgnored: false, ...extra })
const text = (segments: { t: string }[]) => segments.map(one => one.t).join('')

test('a row fills its width exactly, the git side at the right edge, a long name cut with an ellipsis', () => {
  const state = { hasMarkBelow: false, isCursor: false, git: 'M' as const, lines: { added: 12, removed: 3 } }
  const drawn = text(rowSegments(row('a-very-long-file-name-indeed.ts'), state, { columns: 30, config: DEFAULTS }))
  expect(width(drawn)).toBe(30)
  expect(drawn.endsWith(' +12 -3 M')).toBe(true)
  expect(drawn).toContain('…')
  // Too narrow for both: the name keeps the room and the git side goes.
  expect(text(rowSegments(row('name.ts'), state, { columns: 12, config: DEFAULTS }))).toBe('  ◇ name.ts ')
})

test('the cursor row is inverse across the width; a flash is bold in its tone, off without animations', () => {
  const flashing = { hasMarkBelow: false, isCursor: true, mark: { kind: 'modified' as const, isFlashing: true } }
  const segments = rowSegments(row('a.ts'), flashing, { columns: 20, config: DEFAULTS })
  expect(segments.every(one => one.i)).toBe(true)
  expect(segments.find(one => one.t === 'a.ts')).toMatchObject({ c: 'warning', b: true })
  expect(segments.find(one => one.t === 'a.ts')?.b).toBe(true)
  const calm = rowSegments(row('a.ts'), flashing, { columns: 20, config: { ...DEFAULTS, animations: false } })
  expect(calm.find(one => one.t === 'a.ts')?.b).toBeUndefined()
  expect(calm[0]).toMatchObject({ t: '●', c: 'warning' })
})

test('fixed themes paint hex colours and auto paints theme keys', () => {
  const state = { hasMarkBelow: false, isCursor: false, git: 'A' as const }
  expect(rowSegments(row('a.ts'), state, { columns: 20, config: { ...DEFAULTS, theme: 'dark' } }).at(-1)?.c).toBe('#98c379')
  expect(rowSegments(row('a.ts'), state, { columns: 20, config: { ...DEFAULTS, theme: 'light' } }).at(-1)?.c).toBe('#1a7f37')
  expect(rowSegments(row('a.ts'), state, { columns: 20, config: DEFAULTS }).at(-1)?.c).toBe('success')
  expect(rowSegments(row('a.ts'), state, { columns: 20, config: { ...DEFAULTS, git: 'off' } }).some(one => one.t.includes('A'))).toBe(false)
})

test('icons follow the set: Nerd Font glyphs by name and extension, plain Unicode otherwise', () => {
  expect(iconOf('src', 'dir', false, false, 'unicode')).toBe('▸')
  expect(iconOf('src', 'dir', true, false, 'nerd')).toBe('')
  expect(iconOf('a.ts', 'file', false, false, 'nerd')).toBe('')
  expect(iconOf('Dockerfile', 'file', false, false, 'nerd')).toBe('')
  expect(iconOf('a.unknown', 'file', false, false, 'nerd')).toBe('')
  expect(iconOf('a.png', 'file', false, false, 'unicode')).toBe('▣')
  expect(iconOf('x', 'file', false, true, 'unicode')).toBe('↪')
})

test('the branch line shows ahead, behind, no upstream, clean, and the lines changed', () => {
  const git = { branch: { name: 'main', upstream: 'o/main', ahead: 1, behind: 2 }, files: {}, lines: {}, dirs: {} }
  expect(text(branchSegments(git, { added: 0, removed: 0 }, DEFAULTS))).toBe('⎇ main ↑1 ↓2 clean')
  expect(text(branchSegments({ ...git, branch: { name: 'x', ahead: 0, behind: 0 }, files: { '/a': 'M' } }, { added: 4, removed: 1 }, DEFAULTS))).toBe('⎇ x (no upstream) 1 changed +4 -1')
  expect(branchSegments(undefined, { added: 0, removed: 0 }, DEFAULTS)).toEqual([])
})

test('cuts and ages', () => {
  expect(cut('abcdef', 4)).toBe('abc…')
  expect(cut('abc', 4)).toBe('abc')
  expect(cut('abc', 0)).toBe('')
  expect([ago(500), ago(12_000), ago(240_000), ago(7_200_000)]).toEqual(['now', '12s', '4m', '2h'])
})
