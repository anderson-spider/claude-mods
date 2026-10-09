import { expect, test } from 'claude-code/testing'
import { clawdLines, clawdRuns, clawdSvg, COLS, FRAMES, pixels, ROLE_COLOR, ROWS } from '../hooks/clawd'
import type { Mood } from '../hooks/clawd'
import { ROLE_ORDER } from '../hooks/roster'

const MOODS: Mood[] = ['work', 'idle', 'off']
const SIZES = ['small', 'large'] as const
const HEX = /^#[0-9a-fA-F]{6}$/
const width = (runs: { text: string }[]) => runs.reduce((n, r) => n + [...r.text].length, 0)
const key = (role: (typeof ROLE_ORDER)[number], mood: Mood, f: number, size: 'small' | 'large') =>
  JSON.stringify(clawdRuns(role, mood, f, size))

test('pixels: grid is ROWS x COLS with hex or null cells', () => {
  for (const role of ROLE_ORDER) for (const mood of MOODS) {
    const g = pixels(role, mood, 0)
    expect(g.length).toBe(ROWS)
    for (const row of g) {
      expect(row.length).toBe(COLS)
      for (const c of row) expect(c === null || HEX.test(c)).toBe(true)
    }
  }
})

test('clawdRuns: equal display width on every text row, fixed rows per size', () => {
  for (const role of ROLE_ORDER) for (const mood of MOODS) for (const size of SIZES) for (let f = 0; f < FRAMES; f++) {
    const rows = clawdRuns(role, mood, f, size)
    expect(rows.length).toBe(size === 'small' ? 3 : 6)
    for (const r of rows) expect(width(r)).toBe(size === 'small' ? 8 : 15)
  }
})

test('clawdRuns: adjacent runs are merged and colors are hex', () => {
  for (const role of ROLE_ORDER) for (const size of SIZES) for (const row of clawdRuns(role, 'idle', 0, size)) {
    row.forEach((r, i) => {
      if (r.fg) expect(HEX.test(r.fg)).toBe(true)
      if (r.bg) expect(HEX.test(r.bg)).toBe(true)
      if (i > 0) expect(row[i - 1].fg !== r.fg || row[i - 1].bg !== r.bg).toBe(true)
    })
  }
})

test('clawdRuns: an empty half keeps the terminal background', () => {
  for (const row of clawdRuns('fixer', 'idle', 0, 'large')) for (const r of row) {
    if (r.text.includes('▄') || r.text === ' ') expect(r.bg).toBe(undefined)
    if (r.text.includes('▀') && !r.bg) expect(r.fg !== undefined).toBe(true)
  }
})

test('work frames differ, idle and off frames are identical', () => {
  for (const role of ROLE_ORDER) for (const size of SIZES) {
    const work = new Set(Array.from({ length: FRAMES }, (_, f) => key(role, 'work', f, size)))
    expect(work.size > 1).toBe(true)
    for (const mood of ['idle', 'off'] as Mood[]) for (let f = 1; f < FRAMES; f++)
      expect(key(role, mood, f, size)).toBe(key(role, mood, 0, size))
  }
})

test('frames wrap, negative included', () => {
  expect(key('oracle', 'work', FRAMES + 1, 'large')).toBe(key('oracle', 'work', 1, 'large'))
  expect(key('oracle', 'work', -1, 'small')).toBe(key('oracle', 'work', FRAMES - 1, 'small'))
})

test('all seven roles differ at both sizes and in each mood', () => {
  for (const size of SIZES) for (const mood of MOODS)
    expect(new Set(ROLE_ORDER.map(r => key(r, mood, 0, size))).size).toBe(ROLE_ORDER.length)
})

test('off differs from idle (dimmed, eyes closed)', () => {
  expect(key('fixer', 'off', 0, 'large') === key('fixer', 'idle', 0, 'large')).toBe(false)
})

test('clawdLines: plain text of the runs', () => {
  const lines = clawdLines('council', 'idle', 0, 'large')
  expect(lines.length).toBe(6)
  for (const l of lines) expect([...l].length).toBe(15)
  expect(clawdLines('council', 'idle', 0, 'small').map(l => [...l].length)).toEqual([8, 8, 8])
})

test('ROLE_COLOR has the seven roles in hex', () => {
  expect(Object.keys(ROLE_COLOR).sort()).toEqual([...ROLE_ORDER].sort())
  for (const c of Object.values(ROLE_COLOR)) expect(HEX.test(c)).toBe(true)
})

test('clawdSvg: standalone, hex only, animation only when working', () => {
  for (const role of ROLE_ORDER) {
    const work = clawdSvg(role, 'work')
    expect(work.startsWith('<svg')).toBe(true)
    expect(work.includes('viewBox="0 0 30 26"')).toBe(true)
    expect(work.includes('width="60"')).toBe(true)
    expect(work.includes('class="la"') && work.includes('class="lb"')).toBe(true)
    expect(work.includes('animation: none') || work.includes('animation:none')).toBe(true)
    expect(work.includes('shape-rendering="crispEdges"')).toBe(true)
    expect(work.includes('@keyframes')).toBe(true)
    expect(work.includes('prefers-reduced-motion')).toBe(true)
    for (const mood of ['idle', 'off'] as Mood[]) {
      const s = clawdSvg(role, mood, 40)
      expect(s.includes('@keyframes') || s.includes('<style')).toBe(false)
      expect(s.includes('prefers-reduced-motion')).toBe(false)
      expect(s.includes('height="40"')).toBe(true)
    }
    for (const mood of MOODS) {
      const fills = [...clawdSvg(role, mood).matchAll(/fill="([^"]*)"/g)].map(m => m[1])
      expect(fills.length > 0).toBe(true)
      for (const f of fills) expect(HEX.test(f)).toBe(true)
    }
    expect(/success|warning|error|accent|theme/i.test(work)).toBe(false)
  }
})

test('clawdSvg: idle and off are the same shape, off is dimmed', () => {
  expect(clawdSvg('fixer', 'off') === clawdSvg('fixer', 'idle')).toBe(false)
  expect(clawdSvg('fixer', 'idle', 40).includes('<rect')).toBe(true)
})

test('clawdSvg: roles differ', () => {
  expect(new Set(ROLE_ORDER.map(r => clawdSvg(r, 'idle'))).size).toBe(ROLE_ORDER.length)
})

// Each role's held prop and hat read the same at every size: these colors are the prop's own.
const SIGNATURE: Record<(typeof ROLE_ORDER)[number], string[]> = {
  orchestrator: ['#F5F4EF', '#4A86D8'],
  explorer: ['#6E625A', '#CFD4D9'],
  librarian: ['#3B3B40', '#C4483D'],
  fixer: ['#C4C9D6', '#F6EFDD'],
  oracle: ['#2D4A8C', '#FFF1A8'],
  designer: ['#D870A8', '#4FB6D8'],
  council: ['#D8D5CB', '#6B4A2E'],
}
const colorsOf = (g: (string | null)[][]) => new Set(g.flat().filter((c): c is string => !!c).map(c => c.toUpperCase()))

test('terminal and desktop sprites carry the same hat and prop for each role', () => {
  for (const role of ROLE_ORDER) {
    const svg = clawdSvg(role, 'idle').toUpperCase()
    const term = colorsOf(pixels(role, 'idle', 0))
    for (const c of SIGNATURE[role]) {
      expect(svg.includes(`FILL="${c}"`)).toBe(true)
      expect(term.has(c)).toBe(true)
    }
  }
})

test('the fixer wears no hat and holds a laptop and a mug; the oracle has no crystal ball', () => {
  const fixer = pixels('fixer', 'idle', 0)
  // Above the torso only the mug and its steam, at the far left.
  for (let y = 0; y < 4; y++) fixer[y].forEach((c, x) => { if (c) expect(x < 2).toBe(true) })
  expect(colorsOf(pixels('oracle', 'idle', 0)).has('#6F3FB0')).toBe(false)
})
