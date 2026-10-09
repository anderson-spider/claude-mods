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

test('clawdSvg paints an optional frame background first and stays transparent by default', () => {
  for (const mood of MOODS) {
    const svg = clawdSvg('orchestrator', mood, 52, '#242423')
    expect(svg).toContain('style="background:#242423"><rect width="100%" height="100%" fill="#242423"/>')
    const transparent = clawdSvg('orchestrator', mood, 52)
    expect(transparent).not.toContain('style="background:')
    expect(transparent).not.toContain('width="100%" height="100%"')
  }
})

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

const rects = (svg: string) =>
  [...svg.matchAll(/<rect x="(\d+)" y="(\d+)"[^>]*fill="([^"]+)"/g)].map(m => ({ x: +m[1], y: +m[2], fill: m[3].toUpperCase() }))

test('the council wig has curls hanging beside the face', () => {
  const WIG = ['#D8D5CB', '#A7A397']
  // Desktop: the torso's top row is y 10 in the padded canvas; curls hang below it, behind the eyes.
  const curls = rects(clawdSvg('council', 'idle')).filter(r => WIG.includes(r.fill) && r.y >= 10)
  expect(curls.length >= 4).toBe(true)
  expect(curls.every(r => r.x < 8)).toBe(true)
  // Terminal: wig pixels left of the torso, on its first rows.
  const g = pixels('council', 'idle', 0)
  expect([g[4][0], g[4][1], g[5][0], g[5][1]].every(c => c !== null && WIG.includes(c.toUpperCase()))).toBe(true)
})

test('a pen hangs from the orchestrator clipboard', () => {
  const PEN = '#C4483D'
  // Desktop: right of the clipboard (x 20-26 in the padded canvas).
  expect(rects(clawdSvg('orchestrator', 'idle')).filter(r => r.fill === PEN && r.x >= 27).length >= 3).toBe(true)
  const g = pixels('orchestrator', 'idle', 0)
  expect(g.slice(9, 11).every(row => row[14]?.toUpperCase() === PEN)).toBe(true)
})

const groups = (svg: string) => [...svg.matchAll(/<g class="([^"]+)">(.*?)<\/g>/g)].map(m => ({ cls: m[1], body: m[2] }))

test('clawdSvg: the held objects move only while working (stars, laptop screen, lens glint)', () => {
  const oracle = groups(clawdSvg('oracle', 'work'))
  for (const cls of ['tw', 'tw2']) {
    const g = oracle.find(x => x.cls === cls)
    expect(g !== undefined && g.body.toUpperCase().includes('#FFF1A8')).toBe(true)
  }
  for (const role of ['fixer', 'explorer'] as const) {
    const frames = groups(clawdSvg(role, 'work')).filter(g => g.cls.split(' ').includes('fx'))
    expect(frames.length >= 3).toBe(true)
    expect(new Set(frames.map(f => f.body)).size >= 3).toBe(true)
    expect(frames[0].cls.split(' ')).toContain('f0')
  }
  for (const role of ['orchestrator', 'librarian', 'designer', 'council'] as const) {
    expect(groups(clawdSvg(role, 'work')).map(g => g.cls).sort()).toEqual(['la', 'lb'])
  }
  for (const role of ROLE_ORDER) for (const mood of ['idle', 'off'] as Mood[]) {
    expect(clawdSvg(role, mood).includes('<g')).toBe(false)
  }
})

test('clawdSvg: reduced motion stops the objects and shows their first frame', () => {
  const svg = clawdSvg('fixer', 'work')
  const media = svg.slice(svg.indexOf('prefers-reduced-motion'))
  for (const cls of ['.fx', '.tw', '.tw2', '.la', '.lb']) expect(media.includes(cls)).toBe(true)
  expect(/\.fx\{animation:none;opacity:0\}\.f0\{opacity:1\}/.test(media)).toBe(true)
})

test('the small terminal sprite is drawn by hand at 8 x 6, with two eyes and the role signature', () => {
  const EYE = '#1C1B1A'
  for (const role of ROLE_ORDER) for (const mood of MOODS) for (let f = 0; f < 2; f++) {
    const g = pixels(role, mood, f, 'small')
    expect(g.length).toBe(6)
    for (const row of g) expect(row.length).toBe(8)
    expect(g.flat().filter(c => c === EYE).length).toBe(mood === 'off' ? 0 : 2)
    if (mood === 'idle') expect(SIGNATURE[role].some(c => colorsOf(g).has(c))).toBe(true)
  }
})
