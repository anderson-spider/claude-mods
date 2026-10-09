import { expect, test } from 'claude-code/testing'
import Elapsed, { fmt } from '../hooks/elapsed'

function fakeSurface() {
  const timers: { ms: number; fn: () => void }[] = []
  let writes = 0
  const surface = {
    elements: { Box: (props: unknown) => ({ type: 'Box', props }), Text: (props: unknown) => ({ type: 'Text', props }) },
    state: undefined as Parameters<typeof Elapsed>[1]['state'],
    setState(next: NonNullable<Parameters<typeof Elapsed>[1]['state']>) { surface.state = next; writes++ },
    every(ms: number, fn: () => void) { timers.push({ ms, fn }); return () => {} },
    columns: 24,
    rows: 0,
  }
  return { surface, timers, writes: () => writes }
}

const props = { since: 0, now: 65_000, endAt: null, color: 'cyan' }

test('elapsed formats minutes, hours and negative durations', () => {
  expect(fmt(65_000)).toBe('1:05')
  expect(fmt(3_660_000)).toBe('1h01')
  expect(fmt(-1000)).toBe('0:00')
})

test('elapsed registers its timer once and does not tick after completion', () => {
  const fake = fakeSurface()
  const tree = Elapsed({ ...props, endAt: 60_000 }, fake.surface as never)
  expect(fake.timers.map(timer => timer.ms)).toEqual([1000])
  expect(JSON.stringify(tree)).toContain('1:00')
  const writes = fake.writes()
  fake.timers[0].fn()
  expect(fake.writes()).toBe(writes)
  Elapsed(props, fake.surface as never)
  fake.timers[0].fn()
  expect(fake.writes()).toBe(writes + 1)
  expect(fake.surface.state?.ref.ticks).toBe(1)
  Elapsed({ ...props, now: 66_000, endAt: 66_000 }, fake.surface as never)
  fake.timers[0].fn()
  expect(fake.writes()).toBe(writes + 1)
  expect(fake.timers.map(timer => timer.ms)).toEqual([1000])
})

test('elapsed counts local ticks and rebases on a fresh hook reading', () => {
  const fake = fakeSurface()
  Elapsed(props, fake.surface as never)
  fake.timers[0].fn()
  expect(JSON.stringify(Elapsed(props, fake.surface as never))).toContain('1:06')
  const tree = Elapsed({ ...props, now: 70_000 }, fake.surface as never)
  expect(JSON.stringify(tree)).toContain('1:10')
  expect(fake.surface.state?.ref.ticks).toBe(0)
})
