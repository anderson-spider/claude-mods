import { expect, test } from 'claude-code/testing'
import { limitMs } from '../hooks/settings'

test('limitMs reads minutes, falls back and caps', () => {
  expect(limitMs(undefined, 6)).toBe(360_000)
  expect(limitMs('abc', 6)).toBe(360_000)
  expect(limitMs(0, 6)).toBe(360_000)
  expect(limitMs(-3, 6)).toBe(360_000)
  expect(limitMs(NaN, 6)).toBe(360_000)
  expect(limitMs(0.5, 6)).toBe(30_000)
  expect(limitMs('12', 6)).toBe(720_000)
  expect(limitMs(1e9, 6)).toBe(86_400_000)
})
