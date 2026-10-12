import { expect, test } from 'claude-code/testing'
import { decide, type Quota, type Reading } from '../hooks/quota'
import { quotaNeedsLine, quotaView, filled, type QuotaOptions } from '../hooks/hud/quota-view'
import { contextView, headerProfile, modelLine, receiptLine, tokenRow } from '../hooks/hud/session-view'
import {
  defaultSession,
  sessionCompacted,
  sessionMeasured,
  sessionStarted,
  sessionStepped,
  turnEnded,
  turnSpawned,
  turnStarted,
} from '../hooks/hud/state'
import { cellWidth } from '../hooks/hud/width'

const NOW = Date.parse('2026-10-12T12:00:00Z')
const MIN = 60_000
const iso = (ms: number) => new Date(ms).toISOString()
const win = (percentUsed: number, resetMs?: number) => ({ percentUsed, ...(resetMs === undefined ? {} : { resetsAt: iso(NOW + resetMs) }) })
const reading = (five?: ReturnType<typeof win>, seven?: ReturnType<typeof win>): Reading => ({
  ...(five ? { fiveHour: five } : {}),
  ...(seven ? { sevenDay: seven } : {}),
})

const CLAUDE = reading(win(41, 130 * MIN), win(71, (3 * 24 * 60 + 4 * 60) * 60 * MIN / 60))
const CODEX = reading(win(12, 245 * MIN), win(38, (6 * 24 + 1) * 60 * MIN))

/** A quota atom whose decision comes from the real rule, as the router would store it. */
function quota(over: Partial<Quota> = {}): Quota {
  const base: Quota = {
    claude: CLAUDE,
    codex: CODEX,
    codexState: 'ok',
    fetchedAt: NOW - MIN,
    codexObservedAt: NOW - MIN,
    claudeAt: NOW - MIN,
    decision: { provider: 'claude', reason: '' },
  }
  const q = { ...base, ...over }
  return over.decision ? q : { ...q, decision: decide(q.claude, q.codex, q.codexState, true, NOW) }
}
const opts = (over: Partial<QuotaOptions> = {}): QuotaOptions => ({ now: NOW, routing: true, twins: true, ...over })

// ------------------------------------------------------------------ the fresh, both-known case

test('both fresh: gauges, thresholds, markers, reset countdowns, Codex favored', () => {
  const v = quotaView(quota(), opts())
  expect(v.gaugeWidth).toBe(10)
  expect(v.claude).toMatchObject({ provider: 'claude', header: 'Claude', showResets: true, isFavored: false, isDim: false })
  expect(v.claude.gauges.map(g => [g.label, g.pct, g.marker, g.tone, g.resetText])).toEqual([
    ['5h', 41, '', 'section', '2h10m'],
    ['7d', 71, '!', 'warn', '3d4h'],
  ])
  expect(v.codex).toMatchObject({ provider: 'codex', header: 'Codex', showResets: true, isFavored: true, isDim: false })
  expect(v.codex?.gauges.map(g => [g.label, g.pct, g.marker, g.tone, g.resetText])).toEqual([
    ['5h', 12, '', 'section', '4h05m'],
    ['7d', 38, '', 'section', '6d1h'],
  ])
  expect(v.favoredRow).toBe('→ Codex favored: 7d 38% used vs Claude 7d 71%')
  expect(v.hottest).toBe(71)
})

test('markers: ! from 70, !! from 85, and the tone follows', () => {
  const v = quotaView(quota({ claude: reading(win(69.4, 10 * MIN), win(84, 10 * MIN)), codex: reading(win(85, 10 * MIN), win(100, 10 * MIN)) }), opts())
  expect(v.claude.gauges.map(g => [g.pct, g.marker, g.tone])).toEqual([[69, '', 'section'], [84, '!', 'warn']])
  expect(v.codex?.gauges.map(g => [g.pct, g.marker, g.tone])).toEqual([[85, '!!', 'bad'], [100, '!!', 'bad']])
  expect(v.hottest).toBe(100)
})

test('filled cells follow the rounded share', () => {
  expect(filled(41, 10)).toBe(4)
  expect(filled(71, 10)).toBe(7)
  expect(filled(12, 10)).toBe(1)
  expect(filled(100, 30)).toBe(30)
  expect(filled(-4, 10)).toBe(0)
  expect(filled(999, 10)).toBe(10)
})

// ------------------------------------------------------------------ favored row

test('the favored row reads the router decision and never recomputes it', () => {
  expect(quotaView(quota(), opts()).favoredRow).toBe('→ Codex favored: 7d 38% used vs Claude 7d 71%')
  const claudeAhead = quota({ claude: reading(win(10, 60 * MIN), win(41, 60 * MIN)), codex: reading(win(10, 60 * MIN), win(63, 60 * MIN)) })
  const v = quotaView(claudeAhead, opts())
  expect(v.favoredRow).toBe('→ Claude favored: 7d 41% used vs Codex 7d 63%')
  expect(v.claude.isFavored).toBe(true)
  expect(v.codex?.isFavored).toBe(false)
  // whatever the atom's decision says is shown, even when it disagrees with the readings
  const forced = quotaView(quota({ decision: { provider: 'codex', reason: 'because I said so' } }), opts())
  expect(forced.favoredRow).toBe('→ Codex favored: because I said so')
  expect(forced.codex?.isFavored).toBe(true)
})

test('routing off: no favored row and no mark', () => {
  const v = quotaView(quota(), opts({ routing: false }))
  expect(v.favoredRow).toBeNull()
  expect(v.claude.isFavored).toBe(false)
  expect(v.codex?.isFavored).toBe(false)
  // the gauges still show
  expect(v.codex?.gauges[1]?.pct).toBe(38)
})

test('the router\'s "no eligible call" reason has no provider to name: no row', () => {
  const v = quotaView(quota({ decision: decide(CLAUDE, CODEX, 'ok', false, NOW) }), opts())
  expect(v.favoredRow).toBeNull()
  expect(v.claude.isFavored).toBe(false)
})

// ------------------------------------------------------------------ Codex states

test('unknown: the header says so, gauges are unknown, no resets heading', () => {
  const v = quotaView(quota({ codex: null, codexState: 'unknown', codexObservedAt: null, fetchedAt: null }), opts())
  expect(v.codex).toMatchObject({ header: 'Codex · not known yet', showResets: false, isDim: false, isFavored: false })
  expect(v.codex?.gauges.map(g => [g.pct, g.tone, g.resetText, g.marker])).toEqual([[null, 'faint', '', ''], [null, 'faint', '', '']])
  expect(v.favoredRow).toBe('→ Claude favored: Codex quota not known yet')
  expect(v.claude.isFavored).toBe(true)
})

test('stale: the age in the header, last values dimmed, countdowns keep running', () => {
  const v = quotaView(quota({ codexState: 'stale', codexObservedAt: NOW - 18 * MIN }), opts())
  expect(v.codex).toMatchObject({ header: 'Codex · 18m old', showResets: true, isDim: true })
  expect(v.codex?.gauges.map(g => [g.pct, g.isDim, g.resetText])).toEqual([[12, true, '4h05m'], [38, true, '6d1h']])
  expect(v.favoredRow).toBe('→ Claude favored: Codex quota is stale')
  // age falls back to the fetch time, then to a plain word
  expect(quotaView(quota({ codexState: 'stale', codexObservedAt: null, fetchedAt: NOW - 40 * MIN }), opts()).codex?.header).toBe('Codex · 40m old')
  expect(quotaView(quota({ codexState: 'stale', codexObservedAt: null, fetchedAt: null }), opts()).codex?.header).toBe('Codex · stale')
})

test('down: the proxy is named, no resets heading, last values dimmed without countdowns; "Claude only"', () => {
  const v = quotaView(quota({ codexState: 'down' }), opts())
  expect(v.codex).toMatchObject({ header: 'Codex · proxy down', showResets: false, isDim: true })
  expect(v.codex?.gauges.map(g => [g.pct, g.isDim, g.resetText])).toEqual([[12, true, ''], [38, true, '']])
  expect(v.favoredRow).toBe('→ Claude only: Codex proxy is down')
  expect(v.claude.isFavored).toBe(true)
  // down with nothing remembered reads as unknown
  const bare = quotaView(quota({ codexState: 'down', codex: null }), opts())
  expect(bare.codex?.gauges.map(g => g.pct)).toEqual([null, null])
  expect(bare.codex?.header).toBe('Codex · proxy down')
})

test('a window whose reset has passed shows — and reset until the next status', () => {
  const v = quotaView(quota({ codex: reading(win(12, -MIN), win(38, 6 * 24 * 60 * MIN)) }), opts())
  expect(v.codex?.gauges[0]).toMatchObject({ label: '5h', pct: null, resetText: 'reset', marker: '', tone: 'faint' })
  expect(v.codex?.gauges[1]).toMatchObject({ pct: 38, resetText: '6d0h' })
  // Claude's too
  const c = quotaView(quota({ claude: reading(win(41, 0), win(71, MIN)) }), opts())
  expect(c.claude.gauges[0]).toMatchObject({ pct: null, resetText: 'reset' })
  expect(c.claude.gauges[1]).toMatchObject({ pct: 71, resetText: '1m' })
  // a passed window does not count as the hottest
  expect(v.hottest).toBe(71)
})

test('a window without resetsAt shows —', () => {
  const v = quotaView(quota({ claude: reading(win(41), win(71)) }), opts())
  expect(v.claude.gauges.map(g => g.resetText)).toEqual(['—', '—'])
})

test('a missing window draws as unknown', () => {
  const v = quotaView(quota({ claude: reading(undefined, win(71, 60 * MIN)) }), opts())
  expect(v.claude.gauges.map(g => g.pct)).toEqual([null, 71])
  const only5 = quotaView(quota({ codex: reading(win(12, 60 * MIN)) }), opts())
  expect(only5.codex?.gauges.map(g => g.pct)).toEqual([12, null])
})

// ------------------------------------------------------------------ Claude states and layout

test('no twins and no proxy: the Codex block is left out and Claude\'s gauges grow to 30', () => {
  const v = quotaView(quota({ codex: null, codexState: 'off' }), opts({ twins: false, routing: false }))
  expect(v.codex).toBeNull()
  expect(v.gaugeWidth).toBe(30)
  expect(v.favoredRow).toBeNull()
  expect(v.claude.gauges).toHaveLength(2)
})

test('twins registered with no reading asked: the block shows as not known yet', () => {
  const v = quotaView(quota({ codex: null, codexState: 'off' }), opts({ twins: true }))
  expect(v.codex?.header).toBe('Codex · not known yet')
  expect(v.gaugeWidth).toBe(10)
})

test('no plan limits at all (API billing): Claude says so and has no gauges', () => {
  const v = quotaView(quota({ claude: null, claudeAt: null }), opts())
  expect(v.claude).toMatchObject({ header: 'Claude · no plan limits', showResets: false, gauges: [] })
  expect(quotaView(quota({ claude: null, claudeAt: null, codex: null, codexState: 'off' }), opts({ twins: false })).claude.header).toBe('Claude · no plan limits')
  expect(v.hottest).toBe(38)
})

test('a Claude reading older than 15 minutes shows its age and dims; fresher ones do not', () => {
  const old = quotaView(quota({ claudeAt: NOW - 18 * MIN }), opts())
  expect(old.claude).toMatchObject({ header: 'Claude · 18m old', isDim: true, showResets: true })
  expect(old.claude.gauges.every(g => g.isDim)).toBe(true)
  const edge = quotaView(quota({ claudeAt: NOW - 15 * MIN }), opts())
  expect(edge.claude).toMatchObject({ header: 'Claude', isDim: false })
  expect(quotaView(quota({ claudeAt: NOW - 3 * 60 * MIN }), opts()).claude.header).toBe('Claude · 3h old')
  expect(quotaView(quota({ claudeAt: null }), opts()).claude.header).toBe('Claude')
})

// ------------------------------------------------------------------ the one-line form

test('the quota line shows for a hot window, a recent switch, or an unknown or down Codex with twins', () => {
  const calm = quota({ claude: reading(win(10, 60 * MIN), win(30, 60 * MIN)), codex: reading(win(5, 60 * MIN), win(25, 60 * MIN)) })
  const view = quotaView(calm, opts())
  expect(quotaNeedsLine(view, calm, true, false)).toBe(false)
  expect(quotaNeedsLine(view, calm, true, true)).toBe(true)
  const hot = quota()
  expect(quotaNeedsLine(quotaView(hot, opts()), hot, true, false)).toBe(true)
  const unknown = quota({ claude: reading(win(10, 60 * MIN), win(30, 60 * MIN)), codex: null, codexState: 'unknown' })
  expect(quotaNeedsLine(quotaView(unknown, opts()), unknown, true, false)).toBe(true)
  expect(quotaNeedsLine(quotaView(unknown, opts({ twins: false })), unknown, false, false)).toBe(false)
  const down = { ...unknown, codexState: 'down' as const }
  expect(quotaNeedsLine(quotaView(down, opts()), down, true, false)).toBe(true)
  // 70 exactly counts
  const edge = quota({ claude: reading(win(10, 60 * MIN), win(70, 60 * MIN)), codex: reading(win(5, 60 * MIN), win(25, 60 * MIN)) })
  expect(quotaNeedsLine(quotaView(edge, opts()), edge, true, false)).toBe(true)
})

// ------------------------------------------------------------------ session view

test('the header profile lists only what is on', () => {
  expect(headerProfile({ mode: 'default', jev: false, cx: false })).toBe('')
  expect(headerProfile({ mode: '', jev: false, cx: false })).toBe('')
  expect(headerProfile({ mode: 'auto', jev: true, cx: true })).toBe('auto · jev · cx')
  expect(headerProfile({ mode: 'default', jev: true, cx: false })).toBe('jev')
  expect(headerProfile({ mode: 'acceptEdits', jev: false, cx: true })).toBe('acceptEdits · cx')
  expect(cellWidth(headerProfile({ mode: 'x'.repeat(60), jev: true, cx: true }))).toBeLessThanOrEqual(30)
})

test('the model line: effort left out when the host sends none', () => {
  const s = sessionStepped(defaultSession(NOW), { isMain: true, model: 'claude-opus-5-5', effort: 'high' })
  expect(modelLine(s)).toBe('Opus 5.5 · high effort')
  expect(modelLine(sessionStepped(s, { isMain: true, effort: '' }))).toBe('Opus 5.5')
  expect(modelLine(defaultSession(NOW))).toBe('model unknown')
  expect(modelLine(sessionStepped(defaultSession(NOW), { isMain: true, model: 'gpt-6-astra' }))).toBe('GPT-6 Astra')
})

test('context: unknown before a measurement, then percent, markers and tokens', () => {
  expect(contextView(defaultSession(NOW))).toEqual({ pct: null, threshold: 'ok', marker: '', tone: 'faint', tokens: '' })
  const s = sessionMeasured(defaultSession(NOW), { tokens: 128_000, window: 200_000 })
  expect(contextView(s)).toEqual({ pct: 64, threshold: 'ok', marker: '', tone: 'section', tokens: '128k/200k' })
  expect(contextView(sessionMeasured(s, { percent: 72 }))).toMatchObject({ pct: 72, marker: '!', tone: 'warn' })
  expect(contextView(sessionMeasured(s, { percent: 91 }))).toMatchObject({ pct: 91, marker: '!!', tone: 'bad' })
  expect(contextView(sessionMeasured(defaultSession(NOW), { percent: 30 })).tokens).toBe('')
})

test('the token row: cost, flow with the cached share, compactions, uptime', () => {
  let s = defaultSession(NOW)
  const fresh = tokenRow(s)
  expect(fresh.cost).toBe('$0.00')
  expect(fresh.flow).toBe('in 0  out 0')
  expect(fresh.compacted).toBe('')
  expect(fresh.uptime(NOW)).toBe('up 0:00')
  s = sessionMeasured(s, { costUsd: 4.12 })
  s = sessionStepped(s, { isMain: true, usage: { input_tokens: 96_000, cache_read_input_tokens: 1_104_000, output_tokens: 84_000 } })
  s = sessionCompacted(sessionCompacted(s))
  const row = tokenRow(s)
  expect(row.cost).toBe('$4.12')
  expect(row.flow).toBe('in 1.2M 92% cached  out 84k')
  expect(row.compacted).toBe('⟲2')
  expect(row.uptime(NOW + 72 * MIN)).toBe('up 1:12')
})

// ------------------------------------------------------------------ receipt

test('no turn yet', () => {
  expect(receiptLine(defaultSession(NOW), NOW, 52)).toBe('no turn finished yet')
})

function turnWithWork(): ReturnType<typeof defaultSession> {
  let s = sessionMeasured(sessionStarted(defaultSession(NOW), { now: NOW }), { costUsd: 4 })
  s = turnStarted(s, { now: NOW })
  s = sessionStepped(s, { isMain: true, usage: { input_tokens: 12_000, output_tokens: 2100 } })
  s = turnSpawned(turnSpawned(turnSpawned(s)))
  return sessionMeasured(s, { costUsd: 4.18 })
}

test('working: turn clock, cost delta, tokens and agents', () => {
  const s = turnWithWork()
  expect(receiptLine(s, NOW + 42_000, 52)).toBe('turn 0:42 · +$0.18 · in 12k · out 2.1k · 3 agents')
  // no ledger: no cost part
  const noCost = turnStarted(defaultSession(NOW), { now: NOW })
  expect(receiptLine(noCost, NOW + 5000, 52)).toBe('turn 0:05 · in 0 · out 0')
})

test('idle: the last turn with its outcome', () => {
  const s = turnEnded(turnWithWork(), { now: NOW + 133_000, reason: 'answer' })
  expect(receiptLine(s, NOW + 200_000, 56)).toBe('✓ last turn 2:13 · +$0.18 · in 12k · out 2.1k · 3 agents')
  // at 52 cells (the Session card's content) the agents part is the first to go
  expect(receiptLine(s, NOW + 200_000, 52)).toBe('✓ last turn 2:13 · +$0.18 · in 12k · out 2.1k')
  const stopped = turnEnded(turnWithWork(), { now: NOW + 133_000, reason: 'aborted' })
  expect(receiptLine(stopped, NOW, 66)).toBe('✗ last turn 2:13 · stopped · +$0.18 · in 12k · out 2.1k · 3 agents')
  const failed = turnEnded(turnWithWork(), { now: NOW + 133_000, reason: 'error' })
  expect(receiptLine(failed, NOW, 66)).toContain('✗ last turn 2:13 · failed')
  const oneAgent = turnEnded(turnSpawned(turnStarted(defaultSession(NOW), { now: NOW })), { now: NOW + 1000, reason: 'answer' })
  expect(receiptLine(oneAgent, NOW, 52)).toBe('✓ last turn 0:01 · in 0 · out 0 · 1 agent')
})

test('a long receipt drops the agents, then out, then in; duration and cost stay', () => {
  const s = turnEnded(turnWithWork(), { now: NOW + 133_000, reason: 'answer' })
  const full = '✓ last turn 2:13 · +$0.18 · in 12k · out 2.1k · 3 agents'
  expect(receiptLine(s, NOW, cellWidth(full))).toBe(full)
  expect(receiptLine(s, NOW, cellWidth(full) - 1)).toBe('✓ last turn 2:13 · +$0.18 · in 12k · out 2.1k')
  expect(receiptLine(s, NOW, 40)).toBe('✓ last turn 2:13 · +$0.18 · in 12k')
  expect(receiptLine(s, NOW, 30)).toBe('✓ last turn 2:13 · +$0.18')
  expect(receiptLine(s, NOW, 12)).toBe('✓ last turn…')
  for (const w of [10, 20, 30, 40, 52, 66]) expect(cellWidth(receiptLine(s, NOW, w))).toBeLessThanOrEqual(w)
})
