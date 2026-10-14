import { expect, test } from 'claude-code/testing'
import type { SessionHudCard } from '../types'
import { BAR_CELLS, BAR_WIDTH, CONTEXT_ALERT, barCells, barSvg, cacheLine, lastTurnCells, layoutView, sentOf } from '../hooks/layout'
import type { Draw, Group, Piece } from '../hooks/layout'

const now = Date.parse('2026-10-13T12:00:00Z')
const HOUR = 3_600_000
const at = (ms: number) => new Date(now + ms).toISOString()
const card: SessionHudCard = {
  model: 'claude-opus-5-5', effort: 'medium', context: { tokens: 236_000, window: 1_000_000, percent: 24 }, contextWindow: 500_000, cache: 96,
  cacheUsedAt: now - 40_000, limits: [{ kind: 'seven_day', percentUsed: 19, resetsAt: at(131 * HOUR) }, { kind: 'five_hour', percentUsed: 31, resetsAt: at(224 * 60_000) }],
  lastTurnMs: 70_000, edits: 4, errors: 0, turns: 12, agents: [{ id: 'a', model: 'claude-haiku-4-5' }],
  history: [{ before: 120_000, after: 175_000, output: 1_000 }, { before: 181_000, after: 236_000, output: 2_100 }],
}
const piece = (part: Piece) => ('text' in part ? part.text : `[${part.alt}]`)
const view = (changes: Partial<SessionHudCard> = {}, draw: Draw = 'svg') => layoutView({ card: { ...card, ...changes }, now, working: false, palette: 'mockup', draw })
const text = (line: Group[]) => line.map(group => (group === 'spacer' ? '|' : group.map(piece).join(''))).join(' ')

test('the card holds the head with the agents, the context with the last turn, the cache, both windows and the turn, and no money', () => {
  const lines = view().map(text)
  expect(lines).toEqual([
    '● Opus 5.5 · medium | 1 agent: Haiku 4.5',
    'ctx [context 47% used] 47%  236k / 500k | +6k sent · ▲ +55k in turn · 2k out',
    'cache 96% · used 40s ago',
    '5h [5h 31% used] 31% ▲6  3h 44m · 100% in 2h 49m 7d [7d 19% used] 19%  5d 11h · ~86% at reset',
    'last turn 1m · 12 turns · 4 edits · 0 errors',
  ])
  expect(lines.join('\n')).not.toContain('$')
  const bare: SessionHudCard = { limits: [], edits: 0, errors: 0, turns: 0, agents: [], history: [] }
  for (const draw of ['svg', 'cells'] as const) expect(layoutView({ card: bare, now, palette: 'mockup', draw })).toEqual([])
})

test('the cache line says how long ago it was used and, with a lifetime the host named, what is left or that it expired', () => {
  const line = (changes: Partial<SessionHudCard>) => cacheLine({ ...card, ...changes }, now).map(s => s.text).join('')
  expect(line({})).toBe('cache 96% · used 40s ago')
  expect(line({ cacheTtl: '5m' })).toBe('cache 96% · used 40s ago · 5m TTL, 4m left')
  expect(line({ cacheTtl: '5m', cacheUsedAt: now - 6 * 60_000 })).toBe('cache 96% · used 6m ago · 5m TTL, expired')
  expect(line({ cacheUsedAt: undefined, cacheTtl: '1h' })).toBe('cache 96%')
  expect(line({ cache: undefined })).toBe('')
})

test('a bar is a fixed width, lit to the percent and capped at 100, with the tick where the window stands', () => {
  expect(barSvg(50, '#4fb383', 'mockup')).toContain(`width="${BAR_WIDTH}"`)
  expect(barSvg(50, '#4fb383', 'mockup')).toContain('width="48" height="5" rx="2.5" fill="#4fb383"')
  expect(barSvg(250, '#4fb383', 'mockup')).toContain(`width="${BAR_WIDTH}" height="5" rx="2.5" fill="#4fb383"`)
  expect(barSvg(0, '#4fb383', 'mockup')).not.toContain('#4fb383')
  expect(barSvg(10, '#e5c07b', 'mockup', 0.25)).toContain('<rect x="24" y="0" width="1.5"')
})

test('malformed turns and a light theme never reach the drawing as numbers or the dark colours', () => {
  const lines = layoutView({ card: { ...card, history: [{ before: Number.NaN, after: 1, output: 1 }, null as never] }, now, palette: 'theme', draw: 'svg' })
  expect(lines.map(text).join('\n')).not.toMatch(/NaN|sent|in turn/u)
  const sources = lines.flat().flatMap(group => (group === 'spacer' ? [] : group)).filter((p): p is Extract<Piece, { kind: 'svg' }> => 'kind' in p).map(p => p.source).join('')
  expect(sources).not.toContain('#34383f')
})

test('each window and each part of the context line is a group of its own, so a narrow card wraps between them', () => {
  for (const draw of ['svg', 'cells'] as const) {
    const lines = view({}, draw)
    expect(lines.map(line => line.length)).toEqual([3, 3, 1, 2, 1])
    expect([lines[0]![1], lines[1]![1]]).toEqual(['spacer', 'spacer'])
  }
})

test('the terminal card holds the same lines as the desktop, with text bars and no drawing', () => {
  const lines = view({}, 'cells')
  expect(lines.map(text)).toEqual([
    '● Opus 5.5 · medium | 1 agent: Haiku 4.5',
    'ctx ━━━━━━━━━━━━ 47%  236k / 500k | +6k sent · ▲ +55k in turn · 2k out',
    'cache 96% · used 40s ago',
    '5h ━━━│━━━━━━━━ 31% ▲6  3h 44m · 100% in 2h 49m 7d ━━━│━━━━━━━━ 19%  5d 11h · ~86% at reset',
    'last turn 1m · 12 turns · 4 edits · 0 errors',
  ])
  const pieces = lines.flat().flatMap(group => (group === 'spacer' ? [] : group))
  expect(pieces.every(p => 'text' in p)).toBe(true)
})

test('a terminal bar is a fixed width, lit to the percent and capped at 100, with the tick where the window stands', () => {
  const styles = (row: ReturnType<typeof barCells>) => row.map(s => `${s.style}:${s.text.length}`)
  expect(barCells(50, 'success')).toEqual([{ text: '━'.repeat(6), style: 'success' }, { text: '━'.repeat(6), style: 'track' }])
  expect(styles(barCells(250, 'bar'))).toEqual([`bar:${BAR_CELLS}`])
  expect(styles(barCells(0, 'bar'))).toEqual([`track:${BAR_CELLS}`])
  expect(styles(barCells(10, 'bar', 0.5))).toEqual(['bar:1', 'track:5', 'tick:1', 'track:5'])
  expect(styles(barCells(10, 'bar', 2))).toEqual(['bar:1', 'track:10', 'tick:1'])
})

test('the last turn says what was sent at its start, what it added and its output; what was sent is left out when it is not known', () => {
  const figures = (turn: Parameters<typeof lastTurnCells>[0], previous?: Parameters<typeof lastTurnCells>[1]) => lastTurnCells(turn, previous).map(s => s.text).join('')
  const previous = { before: 100_000, after: 114_000, output: 500 }
  expect(figures({ before: 128_000, after: 222_000, output: 36_000 }, previous)).toBe('+14k sent · ▲ +94k in turn · 36k out')
  expect(lastTurnCells({ before: 128_000, after: 222_000, output: 36_000 }, previous)[0]).toEqual({ text: '+14k sent', style: 'sent' })
  // The first turn the card has seen, and a turn after a compaction, have no known start.
  expect(figures({ before: 128_000, after: 222_000, output: 36_000 })).toBe('▲ +94k in turn · 36k out')
  expect(figures({ before: 20_000, after: 30_000, output: 900, compacted: true }, previous)).toBe('▲ +10k in turn · 900 out')
  expect(sentOf({ before: 90_000, after: 95_000, output: 1 }, previous)).toBeUndefined()
  expect(figures({ before: 400_000, after: 20_000, output: 900 })).toBe('▼ −380k · 900 out')
})

test('from 85% of the compaction window the context bar and percent turn to the alert colour on every surface', () => {
  expect(CONTEXT_ALERT).toBe(85)
  const ctx = (tokensUsed: number, draw: Draw, palette: 'mockup' | 'theme' = 'mockup') =>
    layoutView({ card: { ...card, context: { tokens: tokensUsed, window: 1_000_000, percent: 0 } }, now, palette, draw })[1]![0] as Piece[]
  const svgOf = (pieces: Piece[]) => pieces.filter((p): p is Extract<Piece, { kind: 'svg' }> => 'kind' in p)[0]!
  const percentOf = (pieces: Piece[]) => pieces.find(p => 'text' in p && /^ \d+%$/u.test(p.text)) as { text: string; style: string }

  const calm = ctx(420_000, 'svg')
  expect(svgOf(calm).source).toContain('#4fb383')
  expect(svgOf(calm).alt).toBe('context 84% used')
  expect(percentOf(calm)).toEqual({ text: ' 84%', style: 'strong' })

  const near = ctx(425_000, 'svg')
  expect(svgOf(near).source).toContain('#e06c75')
  expect(svgOf(near).source).not.toContain('#4fb383')
  expect(svgOf(near).alt).toBe('context 85% used, near compaction')
  expect(percentOf(near)).toEqual({ text: ' 85%', style: 'danger' })
  expect(svgOf(ctx(425_000, 'svg', 'theme')).source).toContain('#c53030')

  const cells = ctx(470_000, 'cells')
  expect(cells.filter(p => 'text' in p && p.text.includes('━')).map(p => (p as { style: string }).style)).toEqual(['danger', 'track'])
  expect(percentOf(cells)).toEqual({ text: ' 94%', style: 'danger' })
  expect(ctx(420_000, 'cells').some(p => 'style' in p && p.style === 'danger')).toBe(false)
})
