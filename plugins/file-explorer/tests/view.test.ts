import { expect, test } from 'claude-code/testing'
import { DEFAULTS } from '../hooks/config'
import { iconOf } from '../hooks/icons'
import type { Row } from '../hooks/tree'
import { age, ago, branchSegments, cut, rowSegments, shimmerOf, width } from '../hooks/view'

const row = (name: string, extra: Partial<Row> = {}): Row => ({ path: `/p/${name}`, name, depth: 0, kind: 'file', isLink: false, isOpen: false, isIgnored: false, mtimeMs: 0, ...extra })
const text = (segments: { t: string }[]) => segments.map(one => one.t).join('')

test('a row fills its width exactly, the git side at the right edge, a long name cut with an ellipsis', () => {
  const state = { hasMarkBelow: false, isCursor: false, git: 'M' as const, lines: { added: 12, removed: 3 } }
  const drawn = text(rowSegments(row('a-very-long-file-name-indeed.ts'), state, { columns: 30, config: DEFAULTS, now: 0 }))
  expect(width(drawn)).toBe(30)
  expect(drawn.endsWith(' +12 -3 M')).toBe(true)
  expect(drawn).toContain('…')
  // Too narrow for both: the name keeps the room and the git side goes.
  expect(text(rowSegments(row('name.ts'), state, { columns: 12, config: DEFAULTS, now: 0 }))).toBe('  ◇ name.ts ')
})

test('the cursor row gets a soft background across the width; a touch shimmers in its tone, off without animations', () => {
  const flashing = { hasMarkBelow: false, isCursor: true, mark: { kind: 'modified' as const, isFlashing: true } }
  const segments = rowSegments(row('a.ts'), flashing, { columns: 20, config: DEFAULTS, now: 0 })
  expect(segments.every(one => one.bg === 'subtle')).toBe(true)
  expect(rowSegments(row('a.ts'), flashing, { columns: 20, config: { ...DEFAULTS, theme: 'dark' }, now: 0 })[0]?.bg).toBe('#2c313a')
  expect(rowSegments(row('a.ts'), { ...flashing, isCursor: false }, { columns: 20, config: DEFAULTS, now: 0 }).some(one => one.bg)).toBe(false)
  // The auto theme names theme keys, so its light is drawn by intensity: no colour steps.
  expect(segments.find(one => one.t === 'a.ts')).toMatchObject({ c: 'warning', s: true })
  expect(segments.find(one => one.t === 'a.ts')?.g).toBeUndefined()
  const calm = rowSegments(row('a.ts'), flashing, { columns: 20, config: { ...DEFAULTS, animations: false }, now: 0 })
  expect(calm.find(one => one.t === 'a.ts')?.s).toBeUndefined()
  expect(calm[0]).toMatchObject({ t: '●', c: 'warning' })
})

test('fixed themes paint hex colours and auto paints theme keys', () => {
  const state = { hasMarkBelow: false, isCursor: false, git: 'A' as const }
  expect(rowSegments(row('a.ts'), state, { columns: 20, config: { ...DEFAULTS, theme: 'dark' }, now: 0 }).at(-1)?.c).toBe('#98c379')
  expect(rowSegments(row('a.ts'), state, { columns: 20, config: { ...DEFAULTS, theme: 'light' }, now: 0 }).at(-1)?.c).toBe('#1a7f37')
  expect(rowSegments(row('a.ts'), state, { columns: 20, config: DEFAULTS, now: 0 }).at(-1)?.c).toBe('success')
  expect(rowSegments(row('a.ts'), state, { columns: 20, config: { ...DEFAULTS, git: 'off' }, now: 0 }).some(one => one.t.includes('A'))).toBe(false)
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

test('a file shows how long ago it was modified at the right edge, dropped before git when the row is narrow', () => {
  const now = 10 * 86_400_000
  const recent = row('a.ts', { mtimeMs: now - 3 * 60_000 })
  const plain = { hasMarkBelow: false, isCursor: false }
  const changed = { ...plain, git: 'M' as const }
  expect(text(rowSegments(recent, plain, { columns: 30, config: DEFAULTS, now })).endsWith('        3m')).toBe(true)
  expect(text(rowSegments(recent, changed, { columns: 30, config: DEFAULTS, now })).endsWith(' M        3m')).toBe(true)
  expect(text(rowSegments(recent, changed, { columns: 18, config: DEFAULTS, now }))).toMatch(/a\.ts +M$/)
  expect(text(rowSegments(recent, plain, { columns: 30, config: { ...DEFAULTS, mtime: false }, now })).trimEnd()).toBe('  ◇ a.ts')
  expect(text(rowSegments(row('src', { kind: 'dir', mtimeMs: now }), plain, { columns: 30, config: DEFAULTS, now })).trimEnd()).toBe('  ▸ src/')
})

test('ages read now, minutes, hours, yesterday, days, weeks, months and years', () => {
  const minute = 60_000
  const day = 1440 * minute
  expect([0, 3 * minute, 2 * 60 * minute, day + minute, 4 * day, 21 * day, 150 * day, 800 * day].map(age))
    .toEqual(['now', '3m', '2h', 'yesterday', '4d', '3w', '5mo', '2y'])
})

test('a file Claude is writing carries the edited mark and shimmers, a still name without animations', () => {
  const writing = { hasMarkBelow: false, isCursor: false, isEditing: true }
  const lit = rowSegments(row('a.ts'), writing, { columns: 20, config: DEFAULTS, now: 0 })
  expect(lit[0]).toMatchObject({ t: '●', c: 'warning' })
  expect(lit.find(one => one.t === 'a.ts')).toMatchObject({ c: 'warning', s: true })
  const still = rowSegments(row('a.ts'), writing, { columns: 20, config: { ...DEFAULTS, animations: false }, now: 0 })
  expect(still[0]).toMatchObject({ t: '●', c: 'warning' })
  expect(still.find(one => one.t === 'a.ts')?.s).toBeUndefined()
})

test('a fixed theme shimmers in four steps of the tone, from sunk in the background to lit toward the text', () => {
  expect(shimmerOf('modified', 'dark')).toEqual(['#907d5b', '#e5c07b', '#eed6a9', '#f7ecd7'])
  expect(shimmerOf('read', 'light')).toEqual(['#769fd2', '#0550ae', '#033471', '#021834'])
  expect(shimmerOf('read', 'auto')).toBeUndefined()
  const lit = rowSegments(row('a.ts'), { hasMarkBelow: false, isCursor: false, mark: { kind: 'read', isFlashing: true } }, { columns: 20, config: { ...DEFAULTS, theme: 'dark' }, now: 0 })
  expect(lit.find(one => one.t === 'a.ts')?.g).toEqual(shimmerOf('read', 'dark'))
})
