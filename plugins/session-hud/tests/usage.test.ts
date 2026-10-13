import { expect, test } from 'claude-code/testing'
import { cacheShare, money, paceOf, span } from '../hooks/usage'

const now = Date.parse('2026-10-13T12:00:00Z')
const at = (ms: number) => new Date(now + ms).toISOString()
const HOUR = 3_600_000

test('a window half passed at 74% is 24 points ahead and reaches 100% before its reset', () => {
  const pace = paceOf({ kind: 'five_hour', percentUsed: 74, resetsAt: at(2.5 * HOUR) }, now)!
  expect(pace).toMatchObject({ used: 74, elapsed: 0.5, left: 2.5 * HOUR, ahead: 24, atReset: 148 })
  // 74% in 2.5 h is 29.6 points an hour: the last 26 take about 52.7 minutes.
  expect(Math.round(pace.fullIn! / 60_000)).toBe(53)
})

test('a window behind its pace is not ahead, projects under 100% and has no time to full', () => {
  const pace = paceOf({ kind: 'seven_day', percentUsed: 20, resetsAt: at(3.5 * 24 * HOUR) }, now)!
  expect(pace).toEqual({ used: 20, elapsed: 0.5, left: 3.5 * 24 * HOUR, ahead: 0, atReset: 40 })
})

test('a window that just began projects nothing past what is used', () => {
  const pace = paceOf({ kind: 'five_hour', percentUsed: 3, resetsAt: at(5 * HOUR - 60_000) }, now)!
  expect(pace.atReset).toBe(3)
  expect(pace.fullIn).toBeUndefined()
})

test('an unknown window, a missing or malformed reset and a non-finite reading have no pace', () => {
  expect(paceOf({ kind: 'spend_limit', percentUsed: 10, resetsAt: at(HOUR) }, now)).toBeUndefined()
  expect(paceOf({ kind: 'five_hour', percentUsed: 10 }, now)).toBeUndefined()
  expect(paceOf({ kind: 'five_hour', percentUsed: 10, resetsAt: 'soon' }, now)).toBeUndefined()
  expect(paceOf({ kind: 'five_hour', percentUsed: Number.NaN, resetsAt: at(HOUR) }, now)).toBeUndefined()
})

test('the cache share is the read part of the whole input', () => {
  expect(cacheShare({ input_tokens: 10, cache_read_input_tokens: 950, cache_creation_input_tokens: 40 })).toBe(95)
  expect(cacheShare({ input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })).toBeUndefined()
  expect(cacheShare({ input_tokens: -1, cache_read_input_tokens: 5, cache_creation_input_tokens: 0 })).toBeUndefined()
})

test('spans and money read as the card writes them', () => {
  expect([span(5_000), span(38 * 60_000), span(296 * 60_000), span(84 * HOUR), span(-1)]).toEqual(['5s', '38m', '4h 56m', '3d 12h', '?'])
  expect([money(4.594), money(0.16), money(Number.NaN)]).toEqual(['$4.59', '$0.16', '?'])
})
