import { expect, test } from 'claude-code/testing'
import { cardLines, rail, railHead, terminalLines } from '../../hooks/panel/cards'
import type { Card, PaneModel } from '../../hooks/panel/model'
import { p } from '../../hooks/panel/text'
import type { Piece } from '../../hooks/panel/text'

const text = (line: Piece[]) => line.map(piece => piece.text).join('')
const CARD: Card = { key: 'finished', tone: 'suggestion', title: 'Plan', count: '1/4', aside: [p('▰▱ 25%', 'dim')], lines: [[p('● Explore', 'ok')], []] }

test('a card is a rounded border in its tone, with the title, count and aside in its top edge, every line as wide as the pane', () => {
  const lines = cardLines(CARD, 30)
  expect(lines.map(text)).toEqual([
    '╭─ Plan 1/4 ───────── ▰▱ 25% ╮',
    '│ ● Explore                  │',
    '│                            │',
    '╰────────────────────────────╯',
  ])
  expect(lines[0]![1]).toEqual({ text: ' Plan ', style: 'title', tone: 'suggestion' })
  expect(lines[3]![0]!.tone).toBe('suggestion')
})

test('an aside that does not fit beside the title is left out of the border', () => {
  expect(text(cardLines({ ...CARD, aside: [p('x'.repeat(30))] }, 30)[0]!)).toBe('╭─ Plan 1/4 ─────────────────╮')
})

test('a rail is a dim line; a moving one has a head in its tone with a fading tail', () => {
  expect(text(rail(12, 'success', null))).toBe(`  ${'─'.repeat(8)}`)
  const moving = rail(12, 'success', 5)
  expect(text(moving)).toBe('  ──•••●──')
  expect(moving.find(piece => piece.text === '●')).toEqual({ text: '●', style: 'title', tone: 'success' })
  expect(railHead(8, 3, true)).toBe(4)
  expect(railHead(8, 3, false)).toBeNull()
})

test('the pane is the header, the cards with a rail before each but the first, and the footer; only the rail into running moves', () => {
  const running: Card = { key: 'running', tone: 'success', title: 'Running', count: '1', aside: [], lines: [[p('worker')]] }
  const model: PaneModel = { header: [p('head')], cards: [CARD, running], footer: [p('foot')], motion: true, frame: 1 }
  const lines = terminalLines(model, 20).map(text)
  expect(lines[0]).toBe('head')
  expect(lines[1]).toBe('')
  expect(lines[6]).toContain('●')
  expect(lines.at(-1)).toBe('foot')
  expect(terminalLines({ ...model, cards: [running, CARD] }, 20).map(text)[5]).not.toContain('●')
})
