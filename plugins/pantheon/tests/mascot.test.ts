import { expect, test } from 'claude-code/testing'
import Clawd, { frameAfter } from '../hooks/mascot.tsx'
import { FRAMES } from '../hooks/clawd.ts'

function fakeSurface() {
  const timers: { ms: number; fn: () => void }[] = []
  let writes = 0
  const surface = {
    elements: { Box: (props: unknown) => ({ type: 'Box', props }), Text: (props: unknown) => ({ type: 'Text', props }) },
    state: undefined as Parameters<typeof Clawd>[1]['state'],
    setState(next: NonNullable<Parameters<typeof Clawd>[1]['state']>) { surface.state = next; writes++ },
    every(ms: number, fn: () => void) { timers.push({ ms, fn }); return () => {} },
    columns: 13,
    rows: 4,
  }
  return { surface, timers, writes: () => writes }
}

const props = { role: 'fixer' as const, mood: 'work' as const, size: 'large' as const, color: 'orange' }

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

test('idle never advances or redraws on the timer', () => {
  const fake = fakeSurface()
  Clawd({ ...props, mood: 'idle' }, fake.surface as never)
  const writes = fake.writes()
  for (const t of fake.timers) t.fn()
  expect(fake.writes()).toBe(writes)
  expect(fake.surface.state?.ref.frame).toBe(0)
})

test('a mood change is picked up by the same timer', () => {
  const fake = fakeSurface()
  Clawd({ ...props, mood: 'idle' }, fake.surface as never)
  fake.timers[0].fn()
  expect(fake.surface.state?.ref.frame).toBe(0)
  Clawd(props, fake.surface as never)
  fake.timers[0].fn()
  expect(fake.surface.state?.ref.frame).toBe(1)
})

test('renders one Text row per line, the prop in propColor', () => {
  const fake = fakeSurface()
  const out = JSON.stringify(Clawd({ ...props, propColor: 'blue' }, fake.surface as never))
  expect(out).toContain('orange')
  expect(out).toContain('blue')
})
