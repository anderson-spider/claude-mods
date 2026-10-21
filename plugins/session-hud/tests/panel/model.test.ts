import { expect, test } from 'claude-code/testing'
import type { SessionHudCard, SessionHudPanel, SessionHudPanelAgent } from '../../types'
import { EMPTY } from '../../hooks/card'
import { FRAME, LANES, paneLines, paneModel, rowsOf } from '../../hooks/panel/model'
import type { Piece } from '../../hooks/panel/text'

const USAGE = { input: 1_000, output: 500, cacheRead: 180_000, cacheWrite: 1_900 }
const RUNNING: SessionHudPanelAgent = {
  id: 'a1', type: 'reviewer', model: 'claude-opus-5-5', effort: 'high', status: 'running', startedAt: 0, usage: USAGE, requests: 3,
  contextTokens: 42_000, activity: { tools: ['Grep', 'Read', 'Edit'], calls: 9, errors: 1 },
}
const DONE: SessionHudPanelAgent = { id: 'a2', type: 'Explore', model: 'claude-haiku-5-5', status: 'done', startedAt: 0, endedAt: 61_000, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, requests: 0 }
const PANEL: SessionHudPanel = { agents: [RUNNING, DONE], main: { usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0 }, turns: [] } }
const CARD: SessionHudCard = { ...EMPTY, model: 'claude-opus-5-5', effort: 'medium', context: { tokens: 200_000, window: 1_000_000 }, contextWindow: 500_000, turnStartedAt: 0, turns: 3, edits: 2, agentTokens: 1_500_000 }
const all = (lines: Piece[][]) => lines.map(l => l.map(piece => piece.text).join('')).join('\n')
type View = Parameters<typeof paneModel>[0]
const view = (over: Partial<View> = {}): View => ({ panel: PANEL, card: CARD, columns: 110, now: 272_000, frame: 0, ...over })
const card = (key: string, over: Partial<View> = {}) => paneModel(view(over)).cards.find(c => c.key === key)

test('the panel is cards in order, each in its tone: the session, the agents running and finished, and the timeline', () => {
  expect(paneModel(view()).cards.map(c => [c.key, c.tone])).toEqual([['session', 'claude'], ['running', 'success'], ['finished', 'inactive'], ['timeline', 'merged']])
  const header = paneModel(view()).header
  expect(header[0]).toEqual({ text: ' HUD ', style: 'badge' })
  expect(all([header])).toMatch(/^ HUD {3}Session panel +● 1 running$/)
  expect([...all([header])].length).toBe(110)
  expect(all([paneModel(view()).footer])).toBe('2 agents')
})

test("the session card shows the main model, effort and turn, its context gauge against the compaction window and tokens, then its figures", () => {
  const lines = card('session')!.lines
  expect(all([lines[0]!])).toMatch(/^Opus 5\.5 · medium +● working 04:32$/)
  expect(lines[0]![0]).toEqual({ text: 'Opus 5.5', style: 'title', tone: 'claude' })
  expect(all([lines[1]!])).toMatch(/^ctx ▰+▱+ 40% {3}10↑ 10↓$/)
  expect(all([lines[2]!])).toBe('turns 3   edits 2   agents 1.5M')
  expect(all(card('session', { card: { ...CARD, turnStartedAt: undefined, errors: 4 } })!.lines)).toMatch(/○ idle[\s\S]*errors 4/)
})

test('a running agent has a row in its type tone with model, time and effort, then its tools, calls, context and tokens, and never money', () => {
  const lines = card('running')!.lines
  expect(all([lines[0]!])).toMatch(/^⠋ reviewer +Opus 5\.5 +04:32 +high$/)
  expect(all([lines[1]!])).toBe('  └ Grep · Read · Edit  9 calls  ✗ 1  ctx 42k  183k↑ 500↓')
  expect(lines[1]!.find(piece => piece.text === 'Edit')!.style).toBe('plain')
  expect(lines[1]!.find(piece => piece.text.includes('✗'))!.style).toBe('error')
  expect(all(paneLines(view()))).not.toContain('$')
  for (const c of paneModel(view({ columns: 60 })).cards) for (const line of c.lines) expect([...all([line])].length).toBeLessThanOrEqual(60 - FRAME)
})

test('only names reach the screen: a type, model, tool or reason that is not one is drawn as ? or error', () => {
  const odd: SessionHudPanelAgent = { ...RUNNING, type: 'bad type\u001b[31m', model: 'gpt-5', activity: { tools: ['../etc/passwd x'], calls: 1, errors: 0 } }
  const failed: SessionHudPanelAgent = { ...DONE, id: 'f', status: 'failed', endReason: 'Error: /home/me secret' }
  const text = all(paneLines(view({ panel: { ...PANEL, agents: [odd, failed] } })))
  expect(text).not.toContain('passwd')
  expect(text).not.toContain('secret')
  expect(text).not.toContain('gpt')
  expect(text).toMatch(/⠋ \? +\? +04:32/)
  expect(text).toContain('└ ?  1 call')
  expect(text).toMatch(/Explore .*error · 3 min ago/)
})

test('finished agents show how they ended and when, and the card counts what it leaves out', () => {
  const failed: SessionHudPanelAgent = { ...DONE, id: 'f', status: 'failed', endReason: 'max_tokens', endedAt: 200_000 }
  const rows = card('finished', { panel: { ...PANEL, agents: [RUNNING, failed, DONE] } })!.lines
  expect(rows[0]![0]).toEqual({ text: '●', style: 'error' })
  expect(all([rows[0]!])).toMatch(/Explore .*max_tokens · 1 min ago$/)
  expect(all([rows[1]!])).toMatch(/^● Explore +Haiku 5\.5 +01:01 +3 min ago$/)
  const many = Array.from({ length: 9 }, (_, i) => ({ ...DONE, id: `d${i}`, endedAt: 1_000 * i }))
  const lines = card('finished', { panel: { ...PANEL, agents: many } })!.lines
  expect(lines.length).toBe(7)
  expect(all([lines.at(-1)!])).toBe('  +3 more')
})

test('the timeline lanes the main session and each agent type that worked in the last 15 minutes, the most recent first, lit in one-minute buckets', () => {
  const now = 20 * 60_000
  const card0 = { ...CARD, turnStartedAt: undefined }
  const main = { ...PANEL.main, turns: [[6 * 60_000, 7 * 60_000]] as [number, number][] }
  const old = { ...DONE, id: 'old', type: 'Plan', endedAt: 60_000 }
  const explore = { ...DONE, id: 'e', startedAt: 15 * 60_000, endedAt: 16 * 60_000 }
  const lines = card('timeline', { now, card: card0, panel: { main, agents: [{ ...RUNNING, startedAt: 18 * 60_000 }, old, explore] } })!.lines
  expect(lines.map(l => l[0]!.text.trim())).toEqual(['main', 'reviewer', 'Explore', ''])
  expect(lines[0]![0]!.tone).toBe('claude')
  const cw = (110 - FRAME - 14) / 15 | 0
  expect(all([lines[0]!]).slice(14)).toBe(`${'·'.repeat(cw)}${'━'.repeat(cw)}${'·'.repeat(13 * cw)}`)
  expect(all([lines[1]!]).slice(14).endsWith(`${'·'.repeat(cw)}${'━'.repeat(2 * cw)}`)).toBe(true)
  expect(all([lines[2]!]).slice(14)).toBe(`${'·'.repeat(10 * cw)}${'━'.repeat(cw)}${'·'.repeat(4 * cw)}`)
  expect(all([lines.at(-1)!])).toMatch(/^ +−15m +now$/)
  const types = Array.from({ length: 9 }, (_, i) => ({ ...DONE, id: `t${i}`, type: `type${i}`, startedAt: now - 60_000, endedAt: now - i }))
  expect(card('timeline', { now, card: card0, panel: { ...PANEL, agents: types } })!.lines.length).toBe(LANES + 1)
})

test('without agents the panel says so, and the rail moves only while one runs', () => {
  expect(all(paneLines(view({ panel: { ...PANEL, agents: [] } })))).toContain('No agents yet')
  expect(all(paneLines(view({ frame: 1 })))).toContain('⠙')
  expect(paneModel(view()).motion).toBe(true)
  expect(paneModel(view({ panel: { ...PANEL, agents: [DONE] } })).motion).toBe(false)
})

test('short of rows the panel drops the timeline first, then the finished agents', () => {
  const keys = (rows: number) => paneModel(view({ rows })).cards.map(c => c.key)
  const full = paneModel(view()).cards
  expect(keys(rowsOf(full))).toContain('timeline')
  expect(keys(rowsOf(full) - 1)).toEqual(['session', 'running', 'finished'])
  expect(keys(1)).toEqual(['session', 'running'])
})
