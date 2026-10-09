import { expect, test } from 'claude-code/testing'
import Rail, { railCells } from '../hooks/rail'

function fakeSurface() {
  const timers: { ms: number; fn: () => void; stopped: boolean }[] = []
  let writes = 0
  const surface = {
    elements: { Box: (props: unknown) => ({ type: 'Box', props }), Text: (props: unknown) => ({ type: 'Text', props }) },
    state: undefined as Parameters<typeof Rail>[1]['state'],
    setState(next: NonNullable<Parameters<typeof Rail>[1]['state']>) { surface.state = next; writes++ },
    every(ms: number, fn: () => void) {
      const timer = { ms, fn, stopped: false }
      timers.push(timer)
      return () => { timer.stopped = true }
    },
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
})

test('rail starts one packet timer on activation, stops it when inactive and restarts it', () => {
  const fake = fakeSurface()
  const tree = Rail({ ...props, active: false }, fake.surface as never)
  expect(fake.timers).toEqual([])
  expect(JSON.stringify(tree)).toContain('────────────────────────')
  const writes = fake.writes()
  Rail(props, fake.surface as never)
  Rail(props, fake.surface as never)
  expect(fake.timers.map(timer => timer.ms)).toEqual([110])
  fake.timers[0].fn()
  expect(fake.writes()).toBe(writes + 1)
  expect(fake.surface.state?.ref.phase).toBe(1)
  Rail({ ...props, active: false }, fake.surface as never)
  expect(fake.timers[0].stopped).toBe(true)
  expect(fake.surface.state?.ref.stop).toBeUndefined()
  Rail(props, fake.surface as never)
  expect(fake.timers.map(timer => timer.ms)).toEqual([110, 110])
  expect(fake.timers[1].stopped).toBe(false)
  fake.timers[1].fn()
  expect(fake.surface.state?.ref.phase).toBe(2)
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

test('leading state glyph stays steady in the caller color while packets advance', () => {
  const fake = fakeSurface()
  const glyph = { on: '▶', off: '■' }
  type Tree = { props: { children: { props: Record<string, unknown> }[] } }
  const first = (Rail({ ...props, glyph }, fake.surface as never) as Tree).props.children[0].props
  expect(first.children).toEqual(['▶'])
  expect(first.color).toBe('cyan')
  expect(first.bold).toBeUndefined()
  fake.timers[0].fn()
  const next = (Rail({ ...props, glyph }, fake.surface as never) as Tree).props.children[0].props
  expect(next).toEqual(first)
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

test('without the line the glyph stays steady with no timer, and hiding the line stops packets', () => {
  const fake = fakeSurface()
  const glyph = { on: '●', off: '○' }
  const tree = JSON.stringify(Rail({ ...props, width: 1, glyph, isLine: false }, fake.surface as never))
  Rail({ ...props, width: 1, glyph, isLine: false }, fake.surface as never)
  expect(fake.timers).toEqual([])
  expect(tree).toContain('●')
  expect(tree).not.toContain('─')
  Rail({ ...props, glyph }, fake.surface as never)
  expect(fake.timers.map(timer => timer.ms)).toEqual([110])
  Rail({ ...props, glyph, isLine: false }, fake.surface as never)
  expect(fake.timers[0].stopped).toBe(true)
  Rail({ ...props, glyph }, fake.surface as never)
  expect(fake.timers.map(timer => timer.ms)).toEqual([110, 110])
})

test('mapped rail runs have positional keys on every packet frame', () => {
  const fake = fakeSurface()
  type Node = { key?: number; props: { key?: number; children: Node[] } }
  for (let frame = 0; frame < 3; frame++) {
    const tree = Rail(props, fake.surface as never) as Node
    const runs = tree.props.children
    expect(runs.map(r => r.key ?? r.props.key)).toEqual(runs.map((_, index) => index))
    fake.timers[0].fn()
  }
})
