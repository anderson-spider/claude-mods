import { expect, test } from 'claude-code/testing'
import {
  fmtAge,
  fmtClock,
  fmtClockSeconds,
  fmtCost,
  fmtCountdown,
  fmtDelta,
  fmtDuration,
  fmtTokens,
  fmtUptime,
  plural,
  prettyModel,
} from '../hooks/hud/format'
import {
  GAUGE_UNKNOWN,
  LEGEND,
  gauge,
  gaugeTone,
  stepCell,
  thresholdOf,
} from '../hooks/hud/glyphs'
import {
  MAX_LEVEL,
  cardBottom,
  cardRow,
  cardRowSegs,
  cardTop,
  columns,
  fitSegs,
  leftRight,
  levelPlan,
  narrowPlan,
  paneBudget,
  pickLevel,
  railCells,
  railRow,
  seg,
  segsText,
  segsWidth,
} from '../hooks/hud/layout'
import { cellWidth, charWidth, fit, pad, spread, truncate, wrap } from '../hooks/hud/width'

// ------------------------------------------------------------------ width

test('cellWidth counts cells, not code units', () => {
  expect(cellWidth('')).toBe(0)
  expect(cellWidth('abc')).toBe(3)
  expect(cellWidth('▰▱╌●✓✗■▶◇↺⊘·…─│╭╮╰╯»◆○⟲━')).toBe(24)
  expect(cellWidth('日本語')).toBe(6)
  expect(cellWidth('a日b')).toBe(4)
  expect(cellWidth('한글')).toBe(4)
  expect(cellWidth('Ａ')).toBe(2) // fullwidth latin
})

test('cellWidth: emoji take two, marks and joiners none', () => {
  expect(cellWidth('🚀')).toBe(2)
  expect(cellWidth('✅')).toBe(2)
  expect(cellWidth('❌')).toBe(2)
  expect(cellWidth('⭐')).toBe(2)
  expect(cellWidth('a🚀b')).toBe(4)
  // text-default symbol with the emoji selector is drawn wide
  expect(cellWidth('✔️')).toBe(2)
  expect(cellWidth('✔')).toBe(1)
  // combining accent adds nothing
  expect(cellWidth('é')).toBe(1)
  // a family emoji (ZWJ sequence) is one wide glyph
  expect(cellWidth('👨‍👩‍👧')).toBe(2)
  expect(cellWidth('​')).toBe(0)
  expect(charWidth(0x1f680)).toBe(2)
  expect(charWidth(0x41)).toBe(1)
  expect(charWidth(0x0301)).toBe(0)
})

test('truncate ends in an ellipsis, trims the space before it, and never exceeds the width', () => {
  expect(truncate('short', 10)).toBe('short')
  expect(truncate('exactly10!', 10)).toBe('exactly10!')
  expect(truncate('general-purpose', 12)).toBe('general-pur…')
  expect(cellWidth(truncate('general-purpose', 12))).toBe(12)
  // the trailing space before the ellipsis goes
  expect(truncate('rewrite internal config', 8)).toBe('rewrite…')
  expect(truncate('abc', 1)).toBe('…')
  expect(truncate('abc', 0)).toBe('')
  // a wide character that does not fit is not split
  expect(truncate('日本語です', 6)).toBe('日本…')
  expect(cellWidth(truncate('日本語です', 6))).toBeLessThanOrEqual(6)
  expect(truncate('a🚀b🚀c', 4)).toBe('a🚀…')
  expect(truncate('x', -3)).toBe('')
})

test('pad, fit, spread give exact widths', () => {
  expect(pad('ab', 5)).toBe('ab   ')
  expect(pad('ab', 5, 'right')).toBe('   ab')
  expect(pad('abcdef', 3)).toBe('abcdef')
  for (const text of ['', 'a', 'hello world', '日本語日本語', 'x🚀y🚀z🚀w']) {
    for (const w of [1, 2, 5, 12, 52]) {
      expect(cellWidth(fit(text, w))).toBe(w)
      expect(cellWidth(fit(text, w, 'right'))).toBe(w)
    }
  }
  expect(fit('ab', 0)).toBe('')
  expect(spread('left', '3:12', 20)).toBe('left            3:12')
  expect(cellWidth(spread('a very long left side that must be cut', '3:12', 20))).toBe(20)
  expect(spread('a very long left side that must be cut', '3:12', 20).endsWith(' 3:12')).toBe(true)
  expect(spread('', '3:12', 8)).toBe('    3:12')
  expect(spread('x', 'wide right part', 5)).toBe('wide…')
})

test('wrap fills rows and ends the last in an ellipsis when text is left', () => {
  expect(wrap('one two three', 20, 3)).toEqual(['one two three'])
  expect(wrap('aaa bbb ccc ddd', 7, 3)).toEqual(['aaa bbb', 'ccc ddd'])
  expect(wrap('aaa bbb ccc ddd eee', 7, 2)).toEqual(['aaa bbb', 'ccc dd…'])
  const cut = wrap('aaa bbb ccc ddd eee fff ggg', 7, 2)
  expect(cut).toHaveLength(2)
  expect(cut[1]?.endsWith('…')).toBe(true)
  for (const row of cut) expect(cellWidth(row)).toBeLessThanOrEqual(7)
  expect(wrap('', 10, 3)).toEqual([])
  expect(wrap('abcdefghijklmnop', 5, 2)[0]).toBe('abcd…')
})

// ------------------------------------------------------------------ format

test('durations, uptime, countdowns, ages', () => {
  expect(fmtDuration(0)).toBe('0:00')
  expect(fmtDuration(42_000)).toBe('0:42')
  expect(fmtDuration(754_000)).toBe('12:34')
  expect(fmtDuration(3_599_000)).toBe('59:59')
  expect(fmtDuration(3_720_000)).toBe('1h02')
  expect(fmtDuration(-5)).toBe('0:00')
  expect(fmtUptime(72 * 60_000)).toBe('up 1:12')
  expect(fmtUptime(0)).toBe('up 0:00')
  expect(fmtCountdown(45 * 60_000)).toBe('45m')
  expect(fmtCountdown(130 * 60_000)).toBe('2h10m')
  expect(fmtCountdown(245 * 60_000)).toBe('4h05m')
  expect(fmtCountdown((3 * 24 * 60 + 4 * 60) * 60_000)).toBe('3d4h')
  expect(fmtCountdown(30_000)).toBe('<1m')
  expect(fmtCountdown(0)).toBe('0m')
  expect(fmtCountdown(-1)).toBe('0m')
  expect(fmtAge(18 * 60_000)).toBe('18m')
  expect(fmtAge(3 * 3_600_000)).toBe('3h')
  expect(fmtAge(2 * 86_400_000)).toBe('2d')
  expect(fmtAge(10)).toBe('<1m')
})

test('tokens, cost, deltas, plural', () => {
  expect(fmtTokens(0)).toBe('0')
  expect(fmtTokens(840)).toBe('840')
  expect(fmtTokens(2100)).toBe('2.1k')
  expect(fmtTokens(2000)).toBe('2k')
  expect(fmtTokens(12_000)).toBe('12k')
  expect(fmtTokens(128_400)).toBe('128k')
  expect(fmtTokens(999_600)).toBe('1M')
  expect(fmtTokens(1_200_000)).toBe('1.2M')
  expect(fmtTokens(14_000_000)).toBe('14M')
  expect(fmtTokens(-1)).toBe('0')
  expect(fmtCost(4.123)).toBe('$4.12')
  expect(fmtCost(0)).toBe('$0.00')
  expect(fmtDelta(0.18)).toBe('+$0.18')
  expect(plural(1, 'step')).toBe('1 step')
  expect(plural(3, 'step')).toBe('3 steps')
})

test('clocks are local time', () => {
  const at = new Date(2026, 9, 12, 14, 32, 7).getTime()
  expect(fmtClock(at)).toBe('14:32')
  expect(fmtClockSeconds(at)).toBe('14:32:07')
  expect(fmtClock(new Date(2026, 9, 12, 9, 2).getTime())).toBe('09:02')
})

test('prettyModel', () => {
  expect(prettyModel('claude-opus-5-5')).toBe('Opus 5.5')
  expect(prettyModel('claude-sonnet-5-5-20260301')).toBe('Sonnet 5.5')
  expect(prettyModel('claude-haiku-5-5')).toBe('Haiku 5.5')
  expect(prettyModel('claude-opus-4-1-20250805')).toBe('Opus 4.1')
  expect(prettyModel('claude-opus-5')).toBe('Opus 5')
  expect(prettyModel('claude-3-5-sonnet-20241022')).toBe('Sonnet 3.5')
  expect(prettyModel('opus')).toBe('Opus')
  expect(prettyModel('sonnet')).toBe('Sonnet')
  expect(prettyModel('claude-opus-5-5[1m]')).toBe('Opus 5.5')
  expect(prettyModel('gpt-6-astra')).toBe('GPT-6 Astra')
  expect(prettyModel('gpt-6-astra-high')).toBe('GPT-6 Astra')
  expect(prettyModel('gpt-5.1-codex-max')).toBe('GPT-5.1 Codex Max')
  expect(prettyModel('gpt-6-astra-2026-05-01')).toBe('GPT-6 Astra')
  expect(prettyModel('')).toBe('')
  expect(prettyModel('some-model')).toBe('some-model')
})

// ------------------------------------------------------------------ glyphs

test('thresholds are judged on the rounded figure: 70 warns, 85 is bad', () => {
  expect(thresholdOf(0)).toBe('ok')
  expect(thresholdOf(69.4)).toBe('ok')
  expect(thresholdOf(69.5)).toBe('warn')
  expect(thresholdOf(70)).toBe('warn')
  expect(thresholdOf(84.4)).toBe('warn')
  expect(thresholdOf(84.5)).toBe('bad')
  expect(thresholdOf(100)).toBe('bad')
  expect(gaugeTone(41)).toBe('section')
  expect(gaugeTone(71)).toBe('warn')
  expect(gaugeTone(90)).toBe('bad')
})

test('gauge fills by rounded share and draws unknown as faint dashes', () => {
  expect(gauge(41, 10)).toBe('▰▰▰▰▱▱▱▱▱▱')
  expect(gauge(71, 10)).toBe('▰▰▰▰▰▰▰▱▱▱')
  expect(gauge(12, 10)).toBe('▰▱▱▱▱▱▱▱▱▱')
  expect(gauge(38, 10)).toBe('▰▰▰▰▱▱▱▱▱▱')
  expect(gauge(100, 10)).toBe('▰'.repeat(10))
  expect(gauge(0, 10)).toBe('▱'.repeat(10))
  expect(gauge(150, 4)).toBe('▰▰▰▰')
  expect(gauge(-5, 4)).toBe('▱▱▱▱')
  expect(gauge(null, 10)).toBe(GAUGE_UNKNOWN.repeat(10))
  expect(gauge(64, 30)).toBe('▰'.repeat(19) + '▱'.repeat(11))
  expect(cellWidth(gauge(64, 30))).toBe(30)
})

test('step cells and the legend are single-cell glyphs', () => {
  expect(stepCell('implementing')).toEqual({ glyph: '▶', tone: 'role' })
  expect(stepCell('qa').glyph).toBe('◇')
  expect(stepCell('fixes')).toEqual({ glyph: '↺', tone: 'warn' })
  expect(stepCell('done')).toEqual({ glyph: '▰', tone: 'ok' })
  expect(stepCell('next').glyph).toBe('▱')
  expect(stepCell('waits').glyph).toBe('·')
  expect(stepCell('blocked')).toEqual({ glyph: '⊘', tone: 'bad' })
  expect(cellWidth(LEGEND)).toBe(LEGEND.length)
})

// ------------------------------------------------------------------ segments

test('fitSegs gives an exact width: pads short rows, cuts the overflowing segment, drops the rest', () => {
  const short = fitSegs([seg('ab', 'ok'), seg('cd')], 8)
  expect(segsWidth(short)).toBe(8)
  expect(segsText(short)).toBe('abcd    ')
  const long = fitSegs([seg('hello ', 'ok'), seg('wonderful world', 'role'), seg('tail', 'dim')], 14)
  expect(segsWidth(long)).toBe(14)
  expect(segsText(long)).toBe('hello wonderf…')
  expect(long[1]?.tone).toBe('role')
  expect(long.some(s => s.text === 'tail')).toBe(false)
  expect(fitSegs([seg('日本語')], 5).map(s => s.text).join('')).toBe('日本…')
  expect(segsWidth(fitSegs([seg('日本語')], 5))).toBe(5)
  expect(fitSegs([seg('x')], 0)).toEqual([])
})

test('leftRight keeps the right part whole and cuts the left', () => {
  const row = leftRight([seg('developer  contract injection point')], [seg('3:12', 'dim')], 30)
  expect(segsWidth(row)).toBe(30)
  expect(segsText(row).endsWith('3:12')).toBe(true)
  expect(segsText(row)).toBe('developer  contract inje… 3:12')
  const roomy = leftRight([seg('a')], [seg('b')], 10)
  expect(segsText(roomy)).toBe('a        b')
  expect(segsText(leftRight([], [seg('b')], 4))).toBe('   b')
  expect(segsWidth(leftRight([seg('left')], [seg('a right part wider than the row')], 10))).toBe(10)
})

// ------------------------------------------------------------------ frames

test('card frames are exactly the pane width at 56 and 66', () => {
  for (const w of [56, 57, 60, 66]) {
    expect(cellWidth(cardTop('Session', w))).toBe(w)
    expect(cellWidth(cardTop('Plan · proxy-rewrite', w))).toBe(w)
    expect(cellWidth(cardTop('Agents · running 2', w))).toBe(w)
    expect(cellWidth(cardTop('A title that is much too long to fit in the border of any card at all', w))).toBe(w)
    expect(cellWidth(cardBottom(w))).toBe(w)
    expect(cellWidth(railRow(w, null))).toBe(w)
    expect(cellWidth(railRow(w, 7))).toBe(w)
    for (const content of ['', 'short', 'x'.repeat(200), '日本語 mixed 🚀 content', '▰▰▰▱▱ 64%']) {
      expect(cellWidth(cardRow(content, w))).toBe(w)
      expect(segsWidth(cardRowSegs([seg(content, 'ok')], w))).toBe(w)
    }
  }
  expect(cardTop('Session', 56)).toBe('╭─ Session ────────────────────────────────────────────╮')
  expect(cardBottom(56)).toBe('╰' + '─'.repeat(54) + '╯')
  expect(cardRow('hi', 10)).toBe('│ hi     │')
})

test('a long title is cut with an ellipsis inside the border', () => {
  const top = cardTop('A title that is much too long to fit in the border of any card at all', 30)
  expect(top.startsWith('╭─ A title')).toBe(true)
  expect(top).toContain('… ─')
  expect(top.endsWith('╮')).toBe(true)
})

test('rails are a still line or a packet with a trail every 24 cells', () => {
  expect(railCells(10, null)).toBe('─'.repeat(10))
  expect(railCells(0, 3)).toBe('')
  // head at 6, trail behind it
  expect(railCells(12, 6)).toBe('───•••●─────')
  const rail = railCells(52, 14)
  expect(rail).toHaveLength(52)
  expect(rail.indexOf('●')).toBe(14)
  expect(rail.slice(11, 15)).toBe('•••●')
  // a second packet 24 cells later
  expect(rail.indexOf('●', 15)).toBe(38)
  expect(rail.slice(35, 39)).toBe('•••●')
  // near the left edge the trail is cut, and the head at 0 has none
  expect(railCells(10, 0).startsWith('●')).toBe(true)
  expect(railCells(10, 1).slice(0, 2)).toBe('•●')
  // the phase wraps every 24 ticks
  expect(railCells(52, 24)).toBe(railCells(52, 0))
  expect(railCells(52, -1)).toBe(railCells(52, 23))
  expect(cellWidth(railCells(52, 5))).toBe(52)
})

test('columns cuts or pads each column to its width', () => {
  expect(columns([{ text: '● ', width: 2 }, { text: 'developer', width: 13 }, { text: '3:12', width: 8, align: 'right' }])).toBe(
    '● developer        3:12',
  )
  expect(cellWidth(columns([{ text: 'general-purpose agent', width: 12 }, { text: '日本語', width: 5 }]))).toBe(17)
})

// ------------------------------------------------------------------ pane and levels

test('paneBudget: content is width minus the frame; extra cells beyond 56 go to the text columns', () => {
  expect(paneBudget(56)).toEqual({ width: 56, content: 52, extra: 0 })
  expect(paneBudget(66)).toEqual({ width: 66, content: 62, extra: 10 })
  expect(paneBudget(60)).toEqual({ width: 60, content: 56, extra: 4 })
  expect(paneBudget(80).extra).toBe(10)
  expect(paneBudget(50)).toEqual({ width: 50, content: 46, extra: 0 })
})

test('narrowPlan drops the strip, then the effort, below 56', () => {
  expect(narrowPlan(56)).toEqual({ jobStrip: true, effort: true, planOwner: true, quotaHeader: true, finishedStrip: true })
  expect(narrowPlan(52)).toEqual({ jobStrip: false, effort: true, planOwner: false, quotaHeader: false, finishedStrip: false })
  expect(narrowPlan(44).effort).toBe(false)
})

test('levelPlan follows the spec ladder', () => {
  const l0 = levelPlan(0)
  expect(l0).toMatchObject({ legend: true, logRows: 10, timeline: true, finished: 'card', quota: 'card', rails: true, activityRow: true, agentRows: 3, reviewRows: 3, plan: 'full', sessionRows: 4, cutFromBottom: false })
  expect(levelPlan(1)).toMatchObject({ legend: false, logRows: 3, timeline: true })
  expect(levelPlan(2)).toMatchObject({ logRows: 0, timeline: true })
  expect(levelPlan(3)).toMatchObject({ timeline: false, finished: 'card', quota: 'card' })
  expect(levelPlan(4)).toMatchObject({ finished: 'inline', quota: 'no-header', rails: true, activityRow: true, agentRows: 3 })
  expect(levelPlan(5)).toMatchObject({ rails: false, activityRow: false, agentRows: 2, reviewRows: 1, plan: 'short', quota: 'favored-when-hot', sessionRows: 4 })
  expect(levelPlan(6)).toMatchObject({ sessionRows: 1, quota: 'line', plan: 'line', agentRows: 1, cutFromBottom: false })
  expect(levelPlan(7)).toMatchObject({ sessionRows: 1, quota: 'line', plan: 'line', agentRows: 1, cutFromBottom: true })
  expect(levelPlan(99).level).toBe(MAX_LEVEL)
  expect(levelPlan(-3).level).toBe(0)
})

test('each level keeps no more than the one before it', () => {
  const heights = (plan: ReturnType<typeof levelPlan>) =>
    (plan.legend ? 1 : 0) + plan.logRows + (plan.timeline ? 9 : 0) + (plan.finished === 'card' ? 5 : 1) + (plan.rails ? 5 : 0) + plan.agentRows * 2 + plan.reviewRows + (plan.sessionRows === 4 ? 6 : 3)
  for (let level = 1; level <= MAX_LEVEL; level++) {
    expect(heights(levelPlan(level))).toBeLessThanOrEqual(heights(levelPlan(level - 1)))
  }
})

test('pickLevel takes the fullest level that fits, else the last', () => {
  const height = (plan: ReturnType<typeof levelPlan>) => 60 - plan.level * 6
  expect(pickLevel(100, height)).toBe(0)
  expect(pickLevel(60, height)).toBe(0)
  expect(pickLevel(59, height)).toBe(1)
  expect(pickLevel(36, height)).toBe(4)
  expect(pickLevel(24, height)).toBe(6)
  expect(pickLevel(3, height)).toBe(MAX_LEVEL)
  expect(pickLevel(0, () => 10)).toBe(MAX_LEVEL)
})
