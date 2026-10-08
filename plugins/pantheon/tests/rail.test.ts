import { expect, test } from 'claude-code/testing'
import Rail, { pulseOn, railCells } from '../hooks/rail'

function fakeSurface() {
  const timers: { ms: number; fn: () => void }[] = []
  let writes = 0
  const surface = {
    elements: { Box: (props: unknown) => ({ type: 'Box', props }), Text: (props: unknown) => ({ type: 'Text', props }) },
    state: undefined as Parameters<typeof Rail>[1]['state'],
    setState(next: NonNullable<Parameters<typeof Rail>[1]['state']>) { surface.state = next; writes++ },
    every(ms: number, fn: () => void) { timers.push({ ms, fn }); return () => {} },
    columns: 24,
    rows: 0,
  }
  return { surface, timers, writes: () => writes }
}

const props = { active: true, width: 24, color: 'cyan', dim: 'gray', marks: [], isMerge: false }

test('rail packets have lit heads spaced by 24 cells', () => {
  const short = railCells(24, 0, [], false)
  expect(short.filter(cell => cell.text === '●').length).toBe(1)
  expect(short.find(cell => cell.text === '●')?.isLit).toBe(true)
  expect(railCells(48, 5, [], false).filter(cell => cell.text === '●').length).toBe(2)
})

test('resting rail keeps branch and merge marks without packets', () => {
  expect(railCells(5, -1, [], false).map(cell => cell.text).join('')).toBe('─────')
  expect(railCells(5, -1, [-1, 1, 5], false).map(cell => cell.text).join('')).toBe('─┬───')
  expect(railCells(5, -1, [1], true).map(cell => cell.text).join('')).toBe('─┴───')
  expect(railCells(5, -1, [], false).every(cell => !cell.isLit)).toBe(true)
  expect(pulseOn(0)).not.toBe(pulseOn(1))
})

test('rail registers timers once and pauses both while inactive', () => {
  const fake = fakeSurface()
  const tree = Rail({ ...props, active: false }, fake.surface as never)
  expect(fake.timers.map(timer => timer.ms)).toEqual([110, 600])
  expect(JSON.stringify(tree)).toContain('────────────────────────')
  const writes = fake.writes()
  fake.timers.forEach(timer => timer.fn())
  expect(fake.writes()).toBe(writes)
  Rail(props, fake.surface as never)
  fake.timers.forEach(timer => timer.fn())
  expect(fake.writes()).toBe(writes + 2)
  expect(fake.surface.state?.ref.phase).toBe(1)
  expect(fake.surface.state?.ref.tick).toBe(1)
  Rail({ ...props, active: false }, fake.surface as never)
  fake.timers.forEach(timer => timer.fn())
  expect(fake.writes()).toBe(writes + 2)
  expect(fake.timers.map(timer => timer.ms)).toEqual([110, 600])
})

test('vertical rail uses width as height and packets move down', () => {
  const fake = fakeSurface()
  const initial = Rail({ ...props, width: 3, vertical: true }, fake.surface as never)
  expect(JSON.stringify(initial)).toContain('│')
  expect(JSON.stringify(initial)).not.toContain('─')
  fake.timers[0].fn()
  Rail({ ...props, width: 3, vertical: true }, fake.surface as never)
  expect(railCells(3, fake.surface.state!.ref.phase, [], false).map(cell => cell.text)).toEqual(['•', '●', '─'])
})

test('leading state glyph pulses in the caller color and settles when inactive', () => {
  const fake = fakeSurface()
  const glyph = { on: '▶', off: '■' }
  const first = JSON.stringify(Rail({ ...props, glyph }, fake.surface as never))
  expect(first).toContain('▶')
  expect(first).toContain('cyan')
  fake.timers[1].fn()
  const next = JSON.stringify(Rail({ ...props, glyph }, fake.surface as never))
  expect(next).not.toBe(first)
  const stopped = JSON.stringify(Rail({ ...props, glyph, active: false }, fake.surface as never))
  expect(stopped).toContain('■')
  expect(stopped).not.toContain('▶')
})

test('the line fills the region beside the glyph, so a fixed region stays fixed', () => {
  const fake = fakeSurface()
  fake.surface.columns = 12
  const glyph = { on: '●', off: '○' }
  for (let k = 0; k < 4; k++) {
    const tree = Rail({ ...props, width: 11, glyph, active: false }, fake.surface as never) as { props: { children: unknown } }
    const text = JSON.stringify(tree)
    expect((text.match(/─/g) ?? []).length).toBe(11)
    expect(text).toContain('○')
    fake.timers.forEach(timer => timer.fn())
  }
})

test('without the line only the pulse timer runs, without the pulse only the line timer', () => {
  const pulseOnly = fakeSurface()
  const glyph = { on: '●', off: '○' }
  const tree = JSON.stringify(Rail({ ...props, width: 1, glyph, isLine: false }, pulseOnly.surface as never))
  expect(pulseOnly.timers.map(timer => timer.ms)).toEqual([600])
  expect(tree).toContain('●')
  expect(tree).not.toContain('─')
  const lineOnly = fakeSurface()
  Rail({ ...props, glyph, isPulse: false }, lineOnly.surface as never)
  expect(lineOnly.timers.map(timer => timer.ms)).toEqual([110])
  const steady = JSON.stringify(Rail({ ...props, glyph, isPulse: false }, lineOnly.surface as never))
  expect(steady).not.toContain('"bold":true,"children":"●"')
})
