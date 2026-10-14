import { expect, test } from 'claude-code/testing'
import type { SessionHudCard } from '../types'
import { BAR_CELLS, BAR_WIDTH, CHART_COLUMNS, CHART_ROWS, barCells, barSvg, cacheLine, historyCells, historySvg, lastTurnCells, layoutView } from '../hooks/layout'
import type { Draw, Group, Piece } from '../hooks/layout'

const now = Date.parse('2026-10-13T12:00:00Z')
const HOUR = 3_600_000
const at = (ms: number) => new Date(now + ms).toISOString()
const card: SessionHudCard = {
  model: 'claude-opus-5-5', effort: 'medium', context: { tokens: 236_000, window: 1_000_000, percent: 24 }, contextWindow: 500_000, cache: 96,
  cacheUsedAt: now - 40_000, limits: [{ kind: 'seven_day', percentUsed: 19, resetsAt: at(131 * HOUR) }, { kind: 'five_hour', percentUsed: 31, resetsAt: at(224 * 60_000) }],
  lastTurnMs: 70_000, edits: 4, errors: 0, turns: 12, agents: [{ id: 'a', model: 'claude-haiku-4-5' }],
  history: [{ before: 120_000, after: 175_000, output: 1_000 }, { before: 175_000, after: 236_000, output: 2_100 }],
}
const piece = (part: Piece) => ('text' in part ? part.text : `[${part.alt}]`)
const view = (changes: Partial<SessionHudCard> = {}, draw: Draw = 'svg') => layoutView({ card: { ...card, ...changes }, now, working: false, palette: 'mockup', draw })
const text = (line: Group[]) => line.map(group => (group === 'spacer' ? '|' : group.map(piece).join(''))).join(' ')

test('the card holds the head with the agents, the context with its history, the cache, both windows and the turn, and no money', () => {
  const lines = view().map(text)
  expect(lines).toEqual([
    '● Opus 5.5 · medium | 1 agent: Haiku 4.5',
    'ctx [context 47% used] 47%  236k / 500k | [context of the last 2 turns]  ▲ +61k · 2k out',
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

test('the history stacks what each turn began with under what it added, against the window, and marks a compaction the host reported', () => {
  const turns = [{ before: 100, after: 400, output: 10 }, { before: 50, after: 60, output: 5, compacted: true as const }]
  expect(historySvg([turns[0]!, { before: 50, after: 60, output: 5 }], 1_000, 'mockup')).not.toContain('<line')
  const chart = historySvg(turns, 1_000, 'mockup')
  // The newest turn sits at the right: slots 10 and 11 of twelve.
  expect(chart).toContain('<rect x="100" y="19.8" width="7" height="2.2" fill="#3d424b"/>')
  expect(chart).toContain('<rect x="100" y="13.2" width="7" height="6.6" fill="#4fb383"/>')
  expect(chart).toContain('<line x1="108.5"')
  expect(historySvg(turns, undefined, 'mockup')).toContain('<rect x="100" y="0" width="7" height="16.5" fill="#4fb383"/>')
  expect(lastTurnCells({ before: 400_000, after: 20_000, output: 900 }).map(s => s.text).join('')).toBe('▼ −380k · 900 out')
})

test('malformed turns and a light theme never reach the drawing as numbers or the dark colours', () => {
  const lines = layoutView({ card: { ...card, history: [{ before: Number.NaN, after: 1, output: 1 }, null as never] }, now, palette: 'theme', draw: 'svg' })
  expect(lines.map(text).join('\n')).not.toMatch(/NaN|last \d+ turns/u)
  const sources = lines.flat().flatMap(group => (group === 'spacer' ? [] : group)).filter((p): p is Extract<Piece, { kind: 'svg' }> => 'kind' in p).map(p => p.source).join('')
  expect(sources).not.toContain('#34383f')
})

test('each window and each part of the context line is a group of its own, so a narrow card wraps between them', () => {
  for (const draw of ['svg', 'cells'] as const) {
    const lines = view({}, draw)
    expect(lines.map(line => line.length)).toEqual([3, 3, 1, 2, 1])
    expect(lines[0]![1]).toBe('spacer')
    expect(view({ history: [card.history[0]!] }, draw).map(text)[1]).toContain('[context of the last turn]')
  }
})

/** The grid's cells as `[glyph, fg, bg]` triplets, row-major. */
const decode = (cells: string) => {
  const bytes = Uint8Array.from(atob(cells), c => c.charCodeAt(0))
  const words = new Uint32Array(bytes.buffer)
  return Array.from({ length: words.length / 3 }, (_, i) => [...words.slice(i * 3, i * 3 + 3)] as [number, number, number])
}
const cell = (grid: [number, number, number][], column: number, row: number) => grid[row * CHART_COLUMNS + column]!

test('the terminal card holds the same lines as the desktop, with text bars and the history as a cell grid', () => {
  const lines = view({}, 'cells')
  expect(lines.map(text)).toEqual([
    '● Opus 5.5 · medium | 1 agent: Haiku 4.5',
    'ctx ━━━━━━━━━━━━ 47%  236k / 500k | [context of the last 2 turns]  ▲ +61k · 2k out',
    'cache 96% · used 40s ago',
    '5h ━━━│━━━━━━━━ 31% ▲6  3h 44m · 100% in 2h 49m 7d ━━━│━━━━━━━━ 19%  5d 11h · ~86% at reset',
    'last turn 1m · 12 turns · 4 edits · 0 errors',
  ])
  const pieces = lines.flat().flatMap(group => (group === 'spacer' ? [] : group))
  expect(pieces.some(p => 'kind' in p && p.kind === 'svg')).toBe(false)
  const chart = pieces.find((p): p is Extract<Piece, { kind: 'raster' }> => 'kind' in p && p.kind === 'raster')
  expect(chart).toMatchObject({ key: 'history', columns: CHART_COLUMNS, rows: CHART_ROWS })
  expect(decode(chart!.cells)).toHaveLength(CHART_COLUMNS * CHART_ROWS)
})

test('a terminal bar is a fixed width, lit to the percent and capped at 100, with the tick where the window stands', () => {
  const styles = (row: ReturnType<typeof barCells>) => row.map(s => `${s.style}:${s.text.length}`)
  expect(barCells(50, 'success')).toEqual([{ text: '━'.repeat(6), style: 'success' }, { text: '━'.repeat(6), style: 'track' }])
  expect(styles(barCells(250, 'bar'))).toEqual([`bar:${BAR_CELLS}`])
  expect(styles(barCells(0, 'bar'))).toEqual([`track:${BAR_CELLS}`])
  expect(styles(barCells(10, 'bar', 0.5))).toEqual(['bar:1', 'track:5', 'tick:1', 'track:5'])
  expect(styles(barCells(10, 'bar', 2))).toEqual(['bar:1', 'track:10', 'tick:1'])
})

test('the terminal history stacks what each turn began with under what it added, against the window, and marks a compaction the host reported', () => {
  const kept = 0x3d424b, added = 0x4fb383, cut = 0xe5c07b, none = 0x01000000
  const grid = decode(historyCells([{ before: 250, after: 750, output: 10 }, { before: 100, after: 400, output: 5, compacted: true }], 1_000, 'mockup'))
  // Twelve slots, the newest at the right: the older turn in column 21, the newest in column 23, each after its gap column.
  // 250 of 1000 is 4 of 16 levels kept and 750 is 12: the bottom row half grey under green, the top row half green.
  expect(cell(grid, 21, 1)).toEqual([0x2584, kept, added])
  expect(cell(grid, 21, 0)).toEqual([0x2584, added, none])
  // 100 is 2 levels kept, 400 is 6: both end inside the bottom row, drawn to the top in green; nothing above.
  expect(cell(grid, 23, 1)).toEqual([0x2586, added, none])
  expect(cell(grid, 23, 0)).toEqual([0x20, none, none])
  expect([cell(grid, 22, 0), cell(grid, 22, 1)]).toEqual([[0x254e, cut, none], [0x254e, cut, none]])
  expect(cell(grid, 20, 0)).toEqual([0x20, none, none])
  expect(cell(grid, 1, 1)).toEqual([0x20, none, none])
  // A turn that shrank is grey up to where it ended (the change above it is green, as on the desktop); without a window the fullest turn fills both rows.
  expect(cell(decode(historyCells([{ before: 900, after: 500, output: 1 }], 1_000, 'mockup')), 23, 1)).toEqual([0x2588, kept, none])
  expect(cell(decode(historyCells([{ before: 0, after: 80, output: 1 }], undefined, 'mockup')), 23, 0)).toEqual([0x2588, added, none])
})
