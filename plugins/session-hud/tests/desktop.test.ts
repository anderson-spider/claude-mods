import { expect, test } from 'claude-code/testing'
import type { SessionHudCard } from '../types'
import { BAR_WIDTH, barSvg, cacheLine, desktopView, historySvg, lastTurnCells } from '../hooks/desktop'
import type { Group, Piece } from '../hooks/desktop'

const now = Date.parse('2026-10-13T12:00:00Z')
const HOUR = 3_600_000
const at = (ms: number) => new Date(now + ms).toISOString()
const card: SessionHudCard = {
  model: 'claude-opus-5-5', effort: 'medium', context: { tokens: 236_000, window: 1_000_000, percent: 24 }, contextWindow: 500_000, cache: 96,
  cacheUsedAt: now - 40_000, limits: [{ kind: 'seven_day', percentUsed: 19, resetsAt: at(131 * HOUR) }, { kind: 'five_hour', percentUsed: 31, resetsAt: at(224 * 60_000) }],
  lastTurnMs: 70_000, edits: 4, errors: 0, turns: 12, output: 9_000, agents: [{ id: 'a', model: 'claude-haiku-4-5' }],
  history: [{ before: 120_000, after: 175_000, output: 1_000 }, { before: 175_000, after: 236_000, output: 2_100 }],
}
const piece = (part: Piece) => ('text' in part ? part.text : `[${part.alt}]`)
const text = (line: Group[]) => line.map(group => (group === 'spacer' ? '|' : group.map(piece).join(''))).join(' ')

test('the desktop card holds the head with the agents, the context with its history, the cache, both windows and the turn, and no money', () => {
  const lines = desktopView({ card, now, working: false, palette: 'mockup' }).map(text)
  expect(lines).toEqual([
    '● Opus 5.5 · medium | 1 agent: Haiku 4.5',
    'ctx [context 47% used] 47%  236k / 500k | [context of the last 2 turns]  ▲ +61k · 2k out',
    'cache 96% · used 40s ago',
    '5h [5h 31% used] 31% ▲6  3h 44m · 100% in 2h 49m 7d [7d 19% used] 19%  5d 11h · ~86% at reset',
    'last turn 1m · 12 turns · 4 edits · 0 errors',
  ])
  expect(lines.join('\n')).not.toContain('$')
  expect(desktopView({ card: { limits: [], edits: 0, errors: 0, turns: 0, output: 0, agents: [], history: [] }, now, palette: 'mockup' })).toEqual([])
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
  const lines = desktopView({ card: { ...card, history: [{ before: Number.NaN, after: 1, output: 1 }, null as never] }, now, palette: 'theme' })
  expect(lines.map(text).join('\n')).not.toMatch(/NaN|last \d+ turns/u)
  const sources = lines.flat().flatMap(group => (group === 'spacer' ? [] : group)).filter((p): p is Extract<Piece, { kind: 'svg' }> => 'kind' in p).map(p => p.source).join('')
  expect(sources).not.toContain('#34383f')
})

test('each window and each part of the context line is a group of its own, so a narrow card wraps between them', () => {
  const lines = desktopView({ card, now, palette: 'mockup' })
  expect(lines.map(line => line.length)).toEqual([3, 3, 1, 2, 1])
  expect(lines[0]![1]).toBe('spacer')
  expect(desktopView({ card: { ...card, history: [card.history[0]!] }, now, palette: 'mockup' }).map(text)[1]).toContain('[context of the last turn]')
})
