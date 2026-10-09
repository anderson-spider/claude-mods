import { expect, test } from 'claude-code/testing'
import { clawdLines, clawdSvg, FRAMES } from '../hooks/clawd'
import type { Mood } from '../hooks/clawd'
import { ROLE_ORDER } from '../hooks/roster'

const MOODS: Mood[] = ['work', 'idle', 'off']
const SIZES = ['small', 'large'] as const
const ALLOWED = new Set([...'▀▄█▐▌▛▜▝▘ '])

test('clawdLines: equal display width on every line, fixed rows per size', () => {
  for (const role of ROLE_ORDER) for (const mood of MOODS) for (const size of SIZES) for (let f = 0; f < FRAMES; f++) {
    const lines = clawdLines(role, mood, f, size)
    expect(lines.length).toBe(size === 'small' ? 2 : 4)
    for (const l of lines) expect([...l].length).toBe([...lines[0]].length)
    for (const l of lines) for (const c of l) expect(ALLOWED.has(c)).toBe(true)
  }
})

test('clawdLines: width is the same across roles, moods and frames', () => {
  for (const size of SIZES) {
    const w = [...clawdLines('fixer', 'idle', 0, size)[0]].length
    for (const role of ROLE_ORDER) for (const mood of MOODS) for (let f = 0; f < FRAMES; f++)
      expect([...clawdLines(role, mood, f, size)[0]].length).toBe(w)
  }
})

test('clawdLines: work frames differ, idle and off frames are identical', () => {
  for (const role of ROLE_ORDER) for (const size of SIZES) {
    const work = new Set(Array.from({ length: FRAMES }, (_, f) => clawdLines(role, 'work', f, size).join('\n')))
    expect(work.size > 1).toBe(true)
    for (const mood of ['idle', 'off'] as Mood[]) {
      const first = clawdLines(role, mood, 0, size).join('\n')
      for (let f = 1; f < FRAMES; f++) expect(clawdLines(role, mood, f, size).join('\n')).toBe(first)
    }
  }
})

test('clawdLines: frame wraps and defaults to small', () => {
  expect(clawdLines('oracle', 'work', FRAMES + 1).join('\n')).toBe(clawdLines('oracle', 'work', 1, 'small').join('\n'))
  expect(clawdLines('oracle', 'work', -1).join('\n')).toBe(clawdLines('oracle', 'work', FRAMES - 1).join('\n'))
})

test('clawdLines: every role has its own look at both sizes and in each mood', () => {
  for (const size of SIZES) for (const mood of MOODS) {
    const looks = ROLE_ORDER.map(r => clawdLines(r, mood, 0, size).join('\n'))
    expect(new Set(looks).size).toBe(ROLE_ORDER.length)
  }
})

test('clawdLines: small idle body row starts with the same logo cells for every role', () => {
  const rows = ROLE_ORDER.map(r => clawdLines(r, 'idle', 0, 'small')[0])
  for (const row of rows) expect(row.slice(0, 9)).toBe(rows[0].slice(0, 9))
  expect(rows[0].slice(0, 9)).toBe(' ▐▛ █ ▜▌ ')
})

test('clawdLines: idle differs from off (eyes closed)', () => {
  expect(clawdLines('fixer', 'off', 0, 'large').join('\n') === clawdLines('fixer', 'idle', 0, 'large').join('\n')).toBe(false)
})

test('clawdSvg: standalone svg, hex colors, animation only when working', () => {
  for (const role of ROLE_ORDER) {
    const work = clawdSvg(role, 'work')
    expect(work.startsWith('<svg')).toBe(true)
    expect(work.includes('shape-rendering="crispEdges"')).toBe(true)
    expect(work.includes('@keyframes')).toBe(true)
    expect(work.includes('prefers-reduced-motion')).toBe(true)
    expect(work.includes('#D97757')).toBe(true)
    expect(work.includes('#1F1E1D')).toBe(true)
    for (const mood of ['idle', 'off'] as Mood[]) {
      const s = clawdSvg(role, mood, 40)
      expect(s.includes('@keyframes')).toBe(false)
      expect(s.includes('#')).toBe(true)
      expect(s.includes('height="40"')).toBe(true)
    }
    expect(/success|warning|error|accent|theme/i.test(work)).toBe(false)
  }
})

test('clawdSvg: roles differ', () => {
  expect(new Set(ROLE_ORDER.map(r => clawdSvg(r, 'idle'))).size).toBe(ROLE_ORDER.length)
})
