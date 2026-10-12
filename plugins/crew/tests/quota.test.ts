import { expect, test } from 'claude-code/testing'
import type { PluginState } from 'claude-code'
import {
  CACHE_MS,
  DEADLINE_MS,
  MARGIN,
  STALE_MS,
  VETO,
  claudeReading,
  activeCodexConnection,
  codexUsage,
  decide,
  remoteAccess,
  settle,
  INITIAL_QUOTA,
  usagePath,
  type CodexState,
  type Quota,
  type Reading,
} from '../hooks/quota'

const NOW = Date.parse('2026-10-12T12:00:00Z')
const w = (percentUsed: number, resetsAt?: string) => ({ percentUsed, ...(resetsAt ? { resetsAt } : {}) })
const reading = (five: number | undefined, seven: number | undefined): Reading => ({
  ...(five === undefined ? {} : { fiveHour: w(five) }),
  ...(seven === undefined ? {} : { sevenDay: w(seven) }),
})

test('constants', () => {
  expect([DEADLINE_MS, CACHE_MS, STALE_MS, VETO, MARGIN]).toEqual([1500, 300_000, 900_000, 90, 10])
})

const d = (c: Reading | null, x: Reading | null, state: CodexState, eligible = true) => decide(c, x, state, eligible, NOW)

test('decide: not eligible stays on Claude', () => {
  expect(d(reading(10, 70), reading(0, 10), 'ok', false)).toEqual({ provider: 'claude', reason: 'routing off or no Codex twin' })
})

test('decide: Codex unknown, stale, down or off, or no reading, stays on Claude', () => {
  const reasons = { unknown: 'Codex quota not known yet', stale: 'Codex quota is stale', down: 'Codex quota source is down', off: 'routing off or no Codex twin' }
  for (const state of ['unknown', 'stale', 'down', 'off'] as const) {
    expect(d(reading(10, 70), reading(0, 10), state)).toEqual({ provider: 'claude', reason: reasons[state] })
  }
  expect(d(reading(10, 70), null, 'ok')).toEqual({ provider: 'claude', reason: 'Codex quota not known yet' })
})

test('decide: Claude without limits stays on Claude', () => {
  for (const claude of [null, {}]) {
    expect(d(claude, reading(0, 10), 'ok')).toEqual({ provider: 'claude', reason: 'no Claude plan limits' })
  }
})

test('decide: the 5-hour veto', () => {
  // Codex at 90: Claude, even with a big 7-day gap.
  expect(d(reading(10, 90), reading(90, 5), 'ok')).toEqual({ provider: 'claude', reason: 'Codex 5h 90% used' })
  // Claude at 90: Codex, even with Claude ahead on the 7-day.
  expect(d(reading(90, 20), reading(10, 60), 'ok')).toEqual({ provider: 'codex', reason: 'Claude 5h 90% used' })
  // Claude at 90 and Codex without a 5-hour window (Pro): Codex.
  expect(d(reading(95, 20), reading(undefined, 60), 'ok')).toEqual({ provider: 'codex', reason: 'Claude 5h 95% used' })
  // Both vetoed: Claude.
  expect(d(reading(91, 80), reading(99, 5), 'ok')).toEqual({ provider: 'claude', reason: 'both 5h windows at 90% or more' })
  // 89.9 is not vetoed.
  expect(d(reading(89.9, 20), reading(10, 60), 'ok').provider).toBe('claude')
})

test('decide: a Claude veto never goes to Codex on an unknown or exhausted Codex 7-day', () => {
  const claude = reading(95, 40)
  const future = '2026-10-12T15:00:00Z'
  const past = '2026-10-12T11:00:00Z'
  // Codex 5h only.
  expect(d(claude, reading(10, undefined), 'ok')).toEqual({ provider: 'claude', reason: 'Codex has no 7d window' })
  // Empty reading with state ok.
  expect(d(claude, {}, 'ok')).toEqual({ provider: 'claude', reason: 'Codex has no 7d window' })
  // Both windows already reset.
  expect(d(claude, { fiveHour: w(10, past), sevenDay: w(10, past) }, 'ok')).toEqual({ provider: 'claude', reason: 'Codex has no 7d window' })
  // 7d at 100 (and at the veto line).
  expect(d(claude, { sevenDay: w(100, future) }, 'ok')).toEqual({ provider: 'claude', reason: 'Codex 7d 100% used' })
  expect(d(claude, reading(10, 90), 'ok').provider).toBe('claude')
  expect(d(claude, reading(10, 89), 'ok').provider).toBe('codex')
})

test('decide: Codex wins on the 7-day only with the margin', () => {
  expect(d(reading(10, 71), reading(10, 38), 'ok')).toEqual({ provider: 'codex', reason: '7d 38% used vs Claude 7d 71%' })
  expect(d(reading(10, 50), reading(10, 40), 'ok').provider).toBe('codex') // exactly the margin
  expect(d(reading(10, 50), reading(10, 40.5), 'ok').provider).toBe('claude')
  expect(d(reading(10, 30), reading(10, 60), 'ok')).toEqual({ provider: 'claude', reason: '7d 30% used vs Codex 7d 60%' })
  expect(d(reading(10, 40), reading(10, 40), 'ok').provider).toBe('claude')
})

test('decide: a missing 7d window stays on Claude', () => {
  expect(d(reading(10, 70), reading(10, undefined), 'ok')).toEqual({ provider: 'claude', reason: 'Codex has no 7d window' })
  expect(d(reading(10, undefined), reading(10, 5), 'ok')).toEqual({ provider: 'claude', reason: 'Claude has no 7d window' })
})

test('decide: a window whose reset has passed counts as unknown', () => {
  const past = '2026-10-12T11:00:00Z'
  const future = '2026-10-12T15:00:00Z'
  const claude: Reading = { fiveHour: w(95, past), sevenDay: w(80, future) }
  const codex: Reading = { fiveHour: w(10, future), sevenDay: w(10, future) }
  // Claude's 5h veto no longer counts; the 7-day gap of 70 still wins Codex.
  expect(d(claude, codex, 'ok')).toEqual({ provider: 'codex', reason: '7d 10% used vs Claude 7d 80%' })
  // Codex's 7-day passed: no 7-day window, Claude.
  expect(d({ sevenDay: w(80, future) }, { fiveHour: w(10, future), sevenDay: w(10, past) }, 'ok').provider).toBe('claude')
})

test('every reason has no provider prefix', () => {
  const cases = [
    d(reading(10, 100), reading(10, 100), 'ok'),
    d(reading(100, 100), reading(10, 89), 'ok'),
    d(reading(100, 100), reading(100, 100), 'ok'),
    d(reading(10, 100), reading(100, 0), 'ok'),
    d(reading(10, 100), reading(10, 0), 'ok'),
    d(reading(10, 100), reading(100, 100), 'ok'),
    d(null, null, 'unknown'),
    d(null, null, 'stale'),
    d(null, null, 'down'),
    d(null, null, 'off', false),
  ]
  for (const { reason } of cases) {
    expect(reason).not.toMatch(/^(Claude|Codex): /)
  }
})

test('claudeReading keeps five_hour and seven_day, ignores spend_limit and unknown kinds', () => {
  expect(
    claudeReading([
      { kind: 'five_hour', percentUsed: 23.5, resetsAt: '2026-10-12T15:00:00Z' },
      { kind: 'seven_day', percentUsed: 71 },
      { kind: 'spend_limit', percentUsed: 120 },
      { kind: 'weekly_opus', percentUsed: 3 },
    ]),
  ).toEqual({ fiveHour: { percentUsed: 23.5, resetsAt: '2026-10-12T15:00:00Z' }, sevenDay: { percentUsed: 71 } })
  expect(claudeReading([{ kind: 'spend_limit', percentUsed: 120 }])).toBeNull()
  expect(claudeReading([])).toBeNull()
  expect(claudeReading(undefined)).toBeNull()
  expect(claudeReading([{ kind: 'five_hour', percentUsed: Number.NaN }])).toBeNull()
})

/** The remote's usage answer for one connection, shaped as a live read returns it. */
const usage = (quotas: Record<string, unknown>, extra: Record<string, unknown> = {}) => JSON.stringify({ plan: 'pro', limitReached: false, quotas, ...extra })
const win = (seconds: number, used: number, extra: Record<string, unknown> = {}) => ({ used, total: 100, remaining: 100 - used, windowSeconds: seconds, unlimited: false, ...extra })
const FIVE = 5 * 3600
const WEEK = 7 * 86400

test('codexUsage names windows by length, not by their key, and observes them now', () => {
  const { reading, state, observedAt } = codexUsage(usage({ session: win(FIVE, 36, { resetAt: '2026-10-12T15:00:00.000Z' }), weekly: win(WEEK, 21) }), NOW)
  expect(state).toBe('ok')
  expect(observedAt).toBe(NOW)
  expect(reading?.fiveHour).toEqual({ percentUsed: 36, resetsAt: '2026-10-12T15:00:00.000Z' })
  expect(reading?.sevenDay).toEqual({ percentUsed: 21 })
  // A plan that reports only a weekly window may file it under `session`, as the remote does today.
  expect(codexUsage(usage({ session: win(WEEK, 20, { resetAt: '2026-10-18T04:48:45.000Z', displayName: 'Weekly' }) }), NOW).reading).toEqual({
    sevenDay: { percentUsed: 20, resetsAt: '2026-10-18T04:48:45.000Z' },
  })
  // Percent is used over total, not an assumed 100.
  expect(codexUsage(usage({ a: win(WEEK, 50, { total: 200 }) }), NOW).reading?.sevenDay?.percentUsed).toBe(25)
})

test('codexUsage: a reached limit reads 100, and percent is clamped', () => {
  expect(codexUsage(usage({ w: win(WEEK, 40) }, { limitReached: true }), NOW).reading?.sevenDay?.percentUsed).toBe(100)
  expect(codexUsage(usage({ w: win(FIVE, 140) }), NOW).reading?.fiveHour?.percentUsed).toBe(100)
})

test('codexUsage: a malformed answer, an unlimited or unknown-length window, or no usable window is unknown and never throws', () => {
  const unknown = { reading: null, state: 'unknown', observedAt: null }
  for (const input of [
    'not json', '', '{}', 'null', undefined, null, 5,
    JSON.stringify({ quotas: 'x' }),
    usage({}),
    usage({ w: win(WEEK, 5, { unlimited: true }) }),
    usage({ w: win(3600, 5), x: { used: 'x', total: 100, windowSeconds: FIVE } }),
    usage({ w: win(FIVE, -1) }),
    usage({ w: win(FIVE, 5, { total: 0 }) }),
    usage({ w: win(FIVE + 1, 5) }),
  ]) {
    expect(codexUsage(input, NOW)).toEqual(unknown)
  }
  // An unreadable reset is dropped, the window kept.
  expect(codexUsage(usage({ w: win(FIVE, 5, { resetAt: 'soon' }) }), NOW).reading).toEqual({ fiveHour: { percentUsed: 5 } })
})

test('activeCodexConnection takes the one active Codex connection', () => {
  const connection = (extra: Record<string, unknown>) => ({ id: 'c-1', provider: 'codex', isActive: true, ...extra })
  expect(activeCodexConnection(JSON.stringify({ connections: [connection({}), { id: 'x', provider: 'claude', isActive: true }] }))).toBe('c-1')
  for (const connections of [
    [], [connection({ isActive: false })], [connection({ provider: 'openai' })], [connection({ id: '' })],
    [connection({ id: '../x' })], [connection({ id: 7 })], [connection({}), connection({ id: 'c-2' })],
  ]) {
    expect(activeCodexConnection({ connections })).toBeUndefined()
  }
  for (const input of ['not json', '{}', '{"connections":"x"}', undefined, null]) expect(activeCodexConnection(input)).toBeUndefined()
})

test('usagePath reads one connection\'s live usage', () => {
  expect(usagePath('47aeb5c0-297d-47e6')).toBe('/api/usage/47aeb5c0-297d-47e6')
})

test('remoteAccess takes an http or https origin and the key as a bearer', () => {
  expect(remoteAccess('https://remote.example.ts.net', 'mgmt-key')).toEqual({
    ok: true, origin: 'https://remote.example.ts.net', headers: { Authorization: 'Bearer mgmt-key', Accept: 'application/json' },
  })
  expect(remoteAccess('http://10.0.0.5:8317/', ' mgmt-key ')).toMatchObject({ ok: true, origin: 'http://10.0.0.5:8317', headers: { Authorization: 'Bearer mgmt-key' } })
})

test('remoteAccess refuses a missing or malformed remote or key, and never puts either in the reason', () => {
  const cases: [unknown, unknown][] = [
    [undefined, 'k'], ['', 'k'], ['https://r.example', undefined], ['https://r.example', ''], ['https://r.example', 'has space'],
    ['nope', 'k'], ['ftp://r.example', 'k'], ['https://u:p@r.example', 'k'], ['https://r.example/v1', 'k'],
    ['https://r.example?x=1', 'k'], ['https://r.example#f', 'k'],
  ]
  for (const [remote, key] of cases) {
    const access = remoteAccess(remote, key)
    expect(access.ok).toBe(false)
    if (!access.ok) {
      expect(access.reason).not.toContain('r.example')
      if (typeof key === 'string' && key) expect(access.reason).not.toContain(key)
    }
  }
})

test('INITIAL_QUOTA is what decide gives with nothing known and Codex off', () => {
  expect(INITIAL_QUOTA.decision).toEqual(decide(null, null, 'off', false, NOW))
  expect(INITIAL_QUOTA).toMatchObject({ claude: null, codex: null, codexState: 'off', fetchedAt: null, codexObservedAt: null, claudeAt: null })
})

test('settle recomputes the decision from the quota\'s own readings and leaves the rest', () => {
  const fetchedAt = NOW - 60_000
  const base = { ...INITIAL_QUOTA, claude: reading(10, 80), codex: reading(10, 20), codexState: 'ok' as const, fetchedAt }
  const settled = settle(base, true, NOW)
  expect(settled.decision).toEqual(decide(base.claude, base.codex, 'ok', true, NOW))
  expect(settled.decision.provider).toBe('codex')
  expect(settled).toMatchObject({ claude: base.claude, codex: base.codex, codexState: 'ok', fetchedAt })
  expect(settle(base, false, NOW).decision).toEqual({ provider: 'claude', reason: 'routing off or no Codex twin' })
})

test('settle treats a Codex reading fetched more than STALE_MS ago as stale, so the router never favors Codex from it', () => {
  const fresh = { ...INITIAL_QUOTA, claude: reading(10, 80), codex: reading(10, 20), codexState: 'ok' as const, fetchedAt: NOW - STALE_MS }
  expect(settle(fresh, true, NOW)).toMatchObject({ codexState: 'ok', decision: { provider: 'codex' } })
  const old = { ...fresh, fetchedAt: NOW - STALE_MS - 1 }
  expect(settle(old, true, NOW)).toMatchObject({ codexState: 'stale', codex: old.codex, decision: { provider: 'claude', reason: 'Codex quota is stale' } })
  // A state other than ok is left as it is, and a reading with no fetch time is not aged.
  expect(settle({ ...old, codexState: 'down' }, true, NOW).codexState).toBe('down')
  expect(settle({ ...fresh, fetchedAt: null }, true, NOW).codexState).toBe('ok')
})

test('the quota type in the plugin\'s types contract is the module\'s Quota, both ways (a compile-time check)', () => {
  const contract: PluginState['crew']['quota'] = INITIAL_QUOTA
  const module: Quota = contract
  expect(module).toBe(INITIAL_QUOTA)
})
