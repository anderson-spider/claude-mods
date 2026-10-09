import { expect, test } from 'claude-code/testing'
import Clawd, { frameAfter } from '../hooks/mascot.tsx'
import { FRAMES } from '../hooks/clawd.ts'

function fakeSurface() {
  const timers: { ms: number; fn: () => void; stopped: boolean }[] = []
  let writes = 0
  const surface = {
    elements: { Box: (props: unknown) => ({ type: 'Box', props }), Text: (props: unknown) => ({ type: 'Text', props }) },
    state: undefined as Parameters<typeof Clawd>[1]['state'],
    setState(next: NonNullable<Parameters<typeof Clawd>[1]['state']>) { surface.state = next; writes++ },
    every(ms: number, fn: () => void) {
      const t = { ms, fn, stopped: false }
      timers.push(t)
      return () => { t.stopped = true }
    },
    columns: 15,
    rows: 6,
  }
  return { surface, timers, writes: () => writes }
}

const props = { role: 'fixer' as const, mood: 'work' as const, size: 'large' as const }

test('frameAfter advances only when working and wraps at FRAMES', () => {
  expect(frameAfter(0, 'work')).toBe(1)
  expect(frameAfter(FRAMES - 1, 'work')).toBe(0)
  expect(frameAfter(2, 'idle')).toBe(2)
  expect(frameAfter(2, 'off')).toBe(2)
})

test('frame advances on the timer while working', () => {
  const fake = fakeSurface()
  Clawd(props, fake.surface as never)
  expect(fake.timers.map(t => t.ms)).toEqual([250])
  fake.timers[0].fn()
  expect(fake.surface.state?.ref.frame).toBe(1)
})

test('idle and off start no timer', () => {
  for (const mood of ['idle', 'off'] as const) {
    const fake = fakeSurface()
    Clawd({ ...props, mood }, fake.surface as never)
    Clawd({ ...props, mood }, fake.surface as never)
    expect(fake.timers.length).toBe(0)
    expect(fake.surface.state?.ref.frame).toBe(0)
  }
})

test('the timer starts when work begins and stops when it ends', () => {
  const fake = fakeSurface()
  Clawd({ ...props, mood: 'idle' }, fake.surface as never)
  Clawd(props, fake.surface as never)
  Clawd(props, fake.surface as never)
  expect(fake.timers.length).toBe(1)
  fake.timers[0].fn()
  expect(fake.surface.state?.ref.frame).toBe(1)
  Clawd({ ...props, mood: 'idle' }, fake.surface as never)
  expect(fake.timers[0].stopped).toBe(true)
  Clawd(props, fake.surface as never)
  expect(fake.timers.length).toBe(2)
  expect(fake.timers[1].stopped).toBe(false)
})

test('renders one row of Text runs per text row, with fg and bg colors', () => {
  const fake = fakeSurface()
  const tree = Clawd(props, fake.surface as never) as { props: { children: { props: { children: { props: Record<string, unknown> }[] } }[] } }
  expect(tree.props.children.length).toBe(6)
  const texts = tree.props.children.flatMap(r => r.props.children).map(t => t.props)
  expect(texts.some(t => typeof t.color === 'string' && t.color.startsWith('#'))).toBe(true)
  expect(texts.some(t => typeof t.backgroundColor === 'string' && t.backgroundColor.startsWith('#'))).toBe(true)
})

test('small renders three rows', () => {
  const fake = fakeSurface()
  const tree = Clawd({ ...props, size: 'small' }, fake.surface as never) as { props: { children: unknown[] } }
  expect(tree.props.children.length).toBe(3)
})

test('rows and their runs retain positional keys on each work frame', () => {
  const fake = fakeSurface()
  type Node = { key?: number; props: { key?: number; children: Node[] } }
  for (let frame = 0; frame < FRAMES; frame++) {
    const tree = Clawd(props, fake.surface as never) as Node
    const rows = tree.props.children
    expect(rows.map(row => row.key ?? row.props.key)).toEqual(rows.map((_, index) => index))
    for (const row of rows) {
      expect(row.props.children.map(run => run.key ?? run.props.key))
        .toEqual(row.props.children.map((_, index) => index))
    }
    fake.timers[0].fn()
  }
})
