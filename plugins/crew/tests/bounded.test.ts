import { expect, test } from 'claude-code/testing'
import { keepLatest, keepLatestIn } from '../hooks/bounded'

test('keepLatest writes a key as the newest entry, and a key written again moves to the newest place', () => {
  const map = new Map<string, number>()
  keepLatest(map, 'a', 1, 10)
  keepLatest(map, 'b', 2, 10)
  keepLatest(map, 'a', 3, 10)
  expect([...map]).toEqual([['b', 2], ['a', 3]])
})

test('keepLatest drops the oldest entries past the cap and keeps the newest', () => {
  const map = new Map<string, number>()
  for (let i = 0; i < 5; i++) keepLatest(map, `k${i}`, i, 3)
  expect([...map.keys()]).toEqual(['k2', 'k3', 'k4'])
})

test('keepLatestIn adds a value as the newest, moves a value added again to the newest place, and drops the oldest past the cap', () => {
  const set = new Set<string>()
  keepLatestIn(set, 'a', 3)
  keepLatestIn(set, 'b', 3)
  keepLatestIn(set, 'a', 3)
  expect([...set]).toEqual(['b', 'a'])
  for (const value of ['c', 'd', 'e']) keepLatestIn(set, value, 3)
  expect([...set]).toEqual(['c', 'd', 'e'])
})
