import { expect, test } from 'claude-code/testing'
import type { PluginState } from 'claude-code'
import {
  CACHE_MS,
  DEADLINE_MS,
  MARGIN,
  STALE_MS,
  VETO,
  claudeReading,
  codexReading,
  decide,
  proxyAccess,
  settle,
  INITIAL_QUOTA,
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
  expect([DEADLINE_MS, CACHE_MS, STALE_MS, VETO, MARGIN]).toEqual([1500, 60_000, 900_000, 90, 10])
})

const d = (c: Reading | null, x: Reading | null, state: CodexState, eligible = true) => decide(c, x, state, eligible, NOW)

test('decide: not eligible stays on Claude', () => {
  expect(d(reading(10, 70), reading(0, 10), 'ok', false)).toEqual({ provider: 'claude', reason: 'routing off or no Codex twin' })
})

test('decide: Codex unknown, stale, down or off, or no reading, stays on Claude', () => {
  const reasons = { unknown: 'Codex quota not known yet', stale: 'Codex quota is stale', down: 'Codex proxy is down', off: 'routing off or no Codex twin' }
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

const row = (extra: Record<string, unknown>) => ({
  percentUsed: 40,
  resetsAt: 1791037689,
  observedAt: new Date(NOW - 60_000).toISOString(),
  ...extra,
})

test('codexReading parses kinds and the window_<n>m form', () => {
  const body = JSON.stringify({
    codexLimits: [row({ kind: 'five_hour', percentUsed: 36 }), row({ kind: 'window_10080m', percentUsed: 21 })],
  })
  const { reading, state } = codexReading(body, NOW)
  expect(state).toBe('ok')
  expect(reading?.fiveHour?.percentUsed).toBe(36)
  expect(reading?.sevenDay?.percentUsed).toBe(21)
  expect(reading?.sevenDay?.resetsAt).toBe(new Date(1791037689 * 1000).toISOString())
  // windowMinutes alone, with an odd kind.
  const byMinutes = codexReading({ codexLimits: [row({ kind: 'primary', windowMinutes: 300 })] }, NOW)
  expect(byMinutes.reading?.fiveHour?.percentUsed).toBe(40)
  expect(codexReading({ codexLimits: [row({ kind: 'window_300m' })] }, NOW).reading?.fiveHour).toBeDefined()
})

test('codexReading: absent, empty or malformed is unknown and never throws', () => {
  for (const input of ['not json', '', '{}', '[]', 'null', '{"codexLimits":[]}', '{"codexLimits":"x"}', undefined, null, 5, {}]) {
    expect(codexReading(input, NOW)).toEqual({ reading: null, state: 'unknown', observedAt: null })
  }
  const junk = { codexLimits: [null, 3, { kind: 'five_hour' }, { kind: 'five_hour', percentUsed: 'x' }, { kind: 'monthly', percentUsed: 5 }] }
  expect(codexReading(junk, NOW).state).toBe('unknown')
})

test('codexReading: percent over 100 or below 0 is clamped', () => {
  const { reading } = codexReading({ codexLimits: [row({ kind: 'five_hour', percentUsed: 140 }), row({ kind: 'seven_day', percentUsed: -3 })] }, NOW)
  expect(reading?.fiveHour?.percentUsed).toBe(100)
  expect(reading?.sevenDay?.percentUsed).toBe(0)
})

test('codexReading: stale after 15 minutes or without observedAt', () => {
  const at = (ms: number) => ({ codexLimits: [row({ kind: 'seven_day', observedAt: new Date(NOW - ms).toISOString() })] })
  expect(codexReading(at(STALE_MS), NOW).state).toBe('ok')
  expect(codexReading(at(STALE_MS + 1000), NOW).state).toBe('stale')
  expect(codexReading(at(STALE_MS + 1000), NOW).reading?.sevenDay).toBeDefined()
  expect(codexReading({ codexLimits: [{ kind: 'seven_day', percentUsed: 5 }] }, NOW).state).toBe('stale')
  // The oldest window decides, and observedAt is the oldest.
  const mixed = codexReading({ codexLimits: [row({ kind: 'five_hour', observedAt: NOW - 1000 }), row({ kind: 'seven_day', observedAt: NOW - STALE_MS - 5000 })] }, NOW)
  expect(mixed.state).toBe('stale')
  expect(mixed.observedAt).toBe(NOW - STALE_MS - 5000)
  expect(codexReading(at(60_000), NOW).observedAt).toBe(NOW - 60_000)
  // An observedAt in the future is stale, a little skew is not.
  expect(codexReading({ codexLimits: [row({ kind: 'seven_day', observedAt: '2030-01-01T00:00:00Z' })] }, NOW).state).toBe('stale')
  expect(codexReading({ codexLimits: [row({ kind: 'seven_day', observedAt: NOW + 10_000 })] }, NOW).state).toBe('ok')
  // observedAt in Unix seconds.
  expect(codexReading({ codexLimits: [row({ kind: 'seven_day', observedAt: Math.floor(NOW / 1000) - 30 })] }, NOW).state).toBe('ok')
})

test('proxyAccess accepts a loopback http base with the token', () => {
  const access = proxyAccess('http://127.0.0.1:4567', 'X-Ccmproxy-Token: s3cret')
  expect(access).toEqual({ ok: true, url: 'http://127.0.0.1:4567/__ccmproxy/status?refresh=limits', headers: { 'X-Ccmproxy-Token': 's3cret' } })
  expect(proxyAccess('http://localhost:9/', 'X-Ccmproxy-Token: a').ok).toBe(true)
  expect(proxyAccess('http://[::1]:9', 'X-Ccmproxy-Token: a')).toMatchObject({ ok: true, url: 'http://[::1]:9/__ccmproxy/status?refresh=limits' })
})

test('proxyAccess refuses a non-loopback or https base and a missing base', () => {
  for (const base of ['https://127.0.0.1:4567', 'http://example.com', 'http://0.0.0.0:80', 'http://127.0.0.1.evil.com', 'nope', '']) {
    expect(proxyAccess(base, 'X-Ccmproxy-Token: s').ok).toBe(false)
  }
  expect(proxyAccess(undefined, 'X-Ccmproxy-Token: s')).toMatchObject({ ok: false })
})

test('proxyAccess reads the header case-insensitively among several lines', () => {
  const headers = 'Foo: bar\r\nx-ccmproxy-token:  tok:with:colons \nBaz: qux'
  expect(proxyAccess('http://127.0.0.1:1', headers)).toMatchObject({ ok: true, headers: { 'X-Ccmproxy-Token': 'tok:with:colons' } })
  // The first matching line wins.
  expect(proxyAccess('http://127.0.0.1:1', 'X-CCMPROXY-TOKEN: one\nX-Ccmproxy-Token: two')).toMatchObject({ headers: { 'X-Ccmproxy-Token': 'one' } })
})

test('proxyAccess without the header, empty or under another name', () => {
  for (const headers of [undefined, '', 'Other: x', 'X-Ccmproxy-Token:', 'X-Ccmproxy-Token:   ', 'X-Ccmproxy-Token-2: x', 'no colon']) {
    const access = proxyAccess('http://127.0.0.1:1', headers)
    expect(access.ok).toBe(false)
    if (!access.ok) expect(access.reason).toContain('X-Ccmproxy-Token')
  }
})

test('proxyAccess never puts the token in a refusal reason', () => {
  for (const [base, headers] of [['https://127.0.0.1:9', 'X-Ccmproxy-Token: s3cret'], ['http://example.com', 'X-Ccmproxy-Token: s3cret'], ['http://127.0.0.1:9', 'Other: s3cret']] as const) {
    const access = proxyAccess(base, headers)
    expect(access.ok).toBe(false)
    if (!access.ok) expect(access.reason).not.toContain('s3cret')
  }
})

test('proxyAccess drops userinfo, path, query and fragment from the status URL', () => {
  const access = proxyAccess('http://u:p@127.0.0.1:9/x/y?z#h', 'X-Ccmproxy-Token: t')
  expect(access).toMatchObject({ ok: true, url: 'http://127.0.0.1:9/__ccmproxy/status?refresh=limits' })
})

test('codexReading: an out-of-range resetsAt makes the whole reading unknown (toISOString throws; Claude is the safe side)', () => {
  expect(codexReading({ codexLimits: [row({ kind: 'seven_day', resetsAt: 1e20 })] }, NOW)).toEqual({ reading: null, state: 'unknown', observedAt: null })
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
