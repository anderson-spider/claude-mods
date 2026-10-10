import { expect, test } from 'claude-code/testing'
import { ROLE_COLOR, SECTION_COLOR, boxLines, cellWidth, gauge, modelName, padCells, strip, truncCells } from '../hooks/theme'

test('cellWidth counts terminal cells per code point', () => {
  for (const g of ['▰', '▱', '┃', '▌', '●', 'α', 'β', '↑', '↓', '─', '│', '╭', '╮', '╰', '╯', '…', 'a']) expect(cellWidth(g)).toBe(1)
  expect(cellWidth('')).toBe(0)
  expect(cellWidth('abc')).toBe(3)
  expect(cellWidth('漢字')).toBe(4)
  expect(cellWidth('ｱ')).toBe(1)
  expect(cellWidth('Ａ')).toBe(2)
  expect(cellWidth('😀')).toBe(2)
  expect(cellWidth('é')).toBe(1)
})

test('padCells and truncCells respect cell width', () => {
  expect(padCells('ab', 5)).toBe('ab   ')
  expect(padCells('漢', 4)).toBe('漢  ')
  expect(padCells('abcdef', 3)).toBe('abcdef')
  expect(truncCells('abc', 5)).toBe('abc')
  expect(truncCells('abcdef', 4)).toBe('abc…')
  expect(cellWidth(truncCells('漢字漢字', 4))).toBeLessThanOrEqual(4)
  expect(truncCells('漢字漢字', 4)).toBe('漢…')
  expect(truncCells('abc', 0)).toBe('')
})

test('gauge clamps and rounds', () => {
  expect(gauge(0, 10)).toEqual({ on: '', off: '▱'.repeat(10) })
  expect(gauge(100, 10)).toEqual({ on: '▰'.repeat(10), off: '' })
  expect(gauge(250, 10).on).toBe('▰'.repeat(10))
  expect(gauge(-5, 10).on).toBe('')
  expect(gauge(50, 10)).toEqual({ on: '▰'.repeat(5), off: '▱'.repeat(5) })
  expect(gauge(33, 6).on.length).toBe(2)
})

test('strip makes one block per job with state colors', () => {
  const runs = strip([
    { state: 'running', role: 'developer' },
    { state: 'done', role: 'architect' },
    { state: 'failed', role: 'architect' },
    { state: 'planned', role: 'code-reader' },
  ])
  expect(runs.length).toBe(4)
  expect(runs.every(r => r.text === '▰')).toBe(true)
  expect(runs[0]!.color).toBe(ROLE_COLOR.developer)
  expect(runs[1]!.color).toBe('#4CC2A0')
  expect(runs[2]!.color).toBe('#E5604D')
  expect(runs[3]!.dim).toBe(true)
  expect(strip([])).toEqual([])
})

test('SECTION_COLOR has the mockup sections', () => {
  expect(Object.keys(SECTION_COLOR).sort()).toEqual(['flow', 'idle', 'log', 'planned', 'running', 'session', 'timeline'])
})

test('boxLines gives every line exactly width cells', () => {
  const width = 30
  const lines = boxLines('Jobs ▰▱', '#5B93E6', ['▰▰▰▱▱ α β ↑ ↓ ┃', 'a very long line that must be truncated for sure', '漢字漢字漢字', ''], width)
  expect(lines.length).toBe(6)
  for (const l of lines) expect(cellWidth(l.map(r => r.text).join(''))).toBe(width)
  const flat = (i: number) => lines[i]!.map(r => r.text).join('')
  expect(flat(0).startsWith('╭─')).toBe(true)
  expect(flat(0).endsWith('╮')).toBe(true)
  expect(flat(5).startsWith('╰')).toBe(true)
  expect(flat(5).endsWith('╯')).toBe(true)
  expect(flat(1).startsWith('│')).toBe(true)
})

test('boxLines truncates a long title and handles tiny widths', () => {
  for (const w of [4, 8, 12]) {
    for (const l of boxLines('A very long title indeed', '#fff', ['x'], w)) expect(cellWidth(l.map(r => r.text).join(''))).toBe(w)
  }
})

test('modelName turns ids into friendly names', () => {
  expect(modelName('claude-opus-5-5')).toBe('Opus 5.5')
  expect(modelName('claude-sonnet-5-5[1m]')).toBe('Sonnet 5.5')
  expect(modelName('claude-haiku-4-5-20251001')).toBe('Haiku 4.5')
  expect(modelName('claude-3-5-sonnet-20241022')).toBe('Sonnet 3.5')
  expect(modelName('opus')).toBe('Opus')
  expect(modelName('fable')).toBe('Fable')
  expect(modelName('gpt-5.5')).toBe('GPT-5.5')
  expect(modelName('Opus 5.5')).toBe('Opus 5.5')
  expect(modelName('codex')).toBe('codex')
  expect(modelName(undefined)).toBe('')
})
