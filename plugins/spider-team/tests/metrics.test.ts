import { expect, test } from 'claude-code/testing'
import type { SpiderAgent, SpiderMain } from '../types'
import { ZERO, addUsage, costOf, formatCost, formatDuration, formatTokens, hasTokens, mainBusy, mainIdle, mainUsed, totalsOf, usageOf } from '../hooks/metrics'
import { priceOf } from '../hooks/prices'

const near = (v: number | undefined) => (v === undefined ? v : Math.round(v * 1e6) / 1e6)
const U = (input: number, output: number, cacheRead = 0, cacheWrite = 0) => ({ input, output, cacheRead, cacheWrite })

test('an unknown model has no cost, never a default price', () => {
  expect(priceOf('gpt-9')).toBeUndefined()
  expect(costOf('gpt-9', U(1_000, 1_000))).toBeUndefined()
  expect(costOf(undefined, U(1_000, 1_000))).toBeUndefined()
})

test('cost applies input, output, cache read and cache write rates separately', () => {
  // Opus 5.5: $4 in, $20 out, $0.20 cache read, $5 cache write (5-minute) per million tokens.
  expect(near(costOf('claude-opus-5-5', U(1_000_000, 0)))).toBe(near(4))
  expect(near(costOf('claude-opus-5-5', U(0, 1_000_000)))).toBe(near(20))
  expect(near(costOf('claude-opus-5-5', U(0, 0, 1_000_000)))).toBe(near(0.2))
  expect(near(costOf('claude-opus-5-5', U(0, 0, 0, 1_000_000)))).toBe(near(5))
  expect(near(costOf('claude-opus-5-5[1m]', U(500_000, 100_000, 2_000_000, 0)))).toBe(near(2 + 2 + 0.4))
  expect(near(costOf('claude-haiku-5-5', U(100_000, 100_000)))).toBe(near(0.06))
  expect(near(costOf('claude-sonnet-5-5', U(1_000_000, 0)))).toBe(near(2))
  expect(near(costOf('claude-fable-5-1', U(0, 0, 1_000_000)))).toBe(near(0.25))
})

test('hasTokens is true when any count is positive', () => {
  expect(hasTokens(ZERO)).toBe(false)
  expect(hasTokens(U(0, 0, 0, 1))).toBe(true)
})

test('malformed usage is null and adds nothing', () => {
  expect(usageOf({ input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 1, cache_creation_input_tokens: 2 })).toEqual(U(10, 5, 1, 2))
  expect(usageOf({ input_tokens: 10 })).toEqual(U(10, 0, 0, 0))
  expect(usageOf({ input_tokens: -1, output_tokens: 5 })).toBeNull()
  expect(usageOf({ input_tokens: 'ten' })).toBeNull()
  expect(usageOf(null)).toBeNull()
  expect(addUsage(U(1, 2, 3, 4), U(10, 20, 30, 40))).toEqual(U(11, 22, 33, 44))
})

test('totals split main, agents and session; a partly unknown total is marked partial', () => {
  const main: SpiderMain = { usage: U(100, 10), costUsd: 1 }
  const agent = (costUsd?: number, costPartial?: true): SpiderAgent => ({ agentId: 'a', status: 'done', startedAt: 0, lastUpdate: 0, usage: U(50, 5), requests: 1, ...(costUsd !== undefined ? { costUsd } : {}), ...(costPartial ? { costPartial } : {}) })
  const t = totalsOf(main, [agent(0.5), agent(undefined)])
  expect(t.main).toEqual({ usage: U(100, 10), costUsd: 1, costPartial: false })
  expect(t.agents).toEqual({ usage: U(100, 10), costUsd: 0.5, costPartial: true })
  expect(t.session).toEqual({ usage: U(200, 20), costUsd: 1.5, costPartial: true })
  expect(totalsOf({ usage: U(0, 0) }, []).session.costUsd).toBeUndefined()
})

test('formatting: tokens, estimated cost and N/A, durations', () => {
  expect(formatTokens(950)).toBe('950')
  expect(formatTokens(183_400)).toBe('183.4K')
  expect(formatTokens(1_200_000)).toBe('1.2M')
  expect(formatTokens(999_949)).toBe('999.9K')
  expect(formatTokens(999_950)).toBe('1.0M')
  expect(formatTokens(999_999)).toBe('1.0M')
  expect(formatCost({ usage: U(0, 0), costPartial: false }, 'n/d')).toBe('n/d')
  expect(formatCost({ usage: U(0, 0), costUsd: 2.144, costPartial: false })).toBe('~$2.14')
  expect(formatCost({ usage: U(0, 0), costUsd: 2.144, costPartial: true })).toBe('~$2.14+')
  expect(formatCost({ usage: U(0, 0), costPartial: true })).toBe('N/A')
  expect(formatDuration(272_000)).toBe('04:32')
  expect(formatDuration(3_723_000)).toBe('1:02:03')
  expect(formatDuration(-5)).toBe('00:00')
})

test('Haiku 5.5 above a 100K-token prompt uses its long-prompt rates', () => {
  // $0.10 / $0.50 up to a 100K-token prompt (input plus cache), $0.50 / $2.50 above it.
  expect(near(costOf('claude-haiku-5-5', U(100_000, 1_000_000)))).toBe(near(0.01 + 0.5))
  expect(near(costOf('claude-haiku-5-5', U(200_000, 1_000_000)))).toBe(near(0.1 + 2.5))
  expect(near(costOf('claude-haiku-5-5', U(50_000, 0, 60_000)))).toBe(near(0.025 + 0.003))
  // Summed over several requests, the usage is priced on the base card however large the sum.
  expect(near(costOf('claude-haiku-5-5', U(200_000, 1_000_000), false))).toBe(near(0.02 + 0.5))
})

test("Main's request adds usage and cost; an unpriced request with no tokens leaves the cost whole", () => {
  const priced = mainUsed({ usage: ZERO }, 'claude-opus-5-5', { input_tokens: 1_000_000 })
  expect(priced).toMatchObject({ model: 'claude-opus-5-5', costUsd: 4, contextTokens: 1_000_000 })
  const empty = mainUsed(priced, 'gpt-9', { input_tokens: 0, output_tokens: 0 })
  expect(empty.costPartial).toBeUndefined()
  expect(mainUsed(priced, 'gpt-9', { input_tokens: 10 }).costPartial).toBe(true)
  expect(mainUsed(priced, 'claude-sonnet-5-5', null)).toEqual({ ...priced, model: 'claude-sonnet-5-5' })
})

test("Main is busy from its turn's first request, and its ended turns are kept for the timeline's window", () => {
  const busy = mainBusy(mainBusy({ usage: ZERO }, 10, 'high'), 20)
  expect(busy).toEqual({ usage: ZERO, effort: 'high', busySince: 10 })
  const idle = mainIdle({ ...busy, turns: [[0, 4], [5, 8]] }, 30, 6)
  expect(idle).toEqual({ usage: ZERO, effort: 'high', turns: [[5, 8], [10, 30]] })
  expect(mainIdle(idle, 40, 0)).toBe(idle)
})
