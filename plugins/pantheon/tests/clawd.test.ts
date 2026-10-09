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
    expect(g.length).toBe(ROWS * 2)
    for (const row of g) {
      expect(row.length).toBe(COLS * 2)
      for (const c of row) expect(c === null || HEX.test(c)).toBe(true)
    }
  }
})

test('clawdRuns: equal display width on every text row, fixed rows per size', () => {
  for (const role of ROLE_ORDER) for (const mood of MOODS) for (const size of SIZES) for (let f = 0; f < FRAMES; f++) {
    const rows = clawdRuns(role, mood, f, size)
    expect(rows.length).toBe(4)
    for (const r of rows) expect(width(r)).toBe(9)
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

test('roles have distinct hats over the same body in both terminal sizes', () => {
  for (const size of SIZES) for (const mood of MOODS) for (let frame = 0; frame < FRAMES; frame++) {
    const all = ROLE_ORDER.map(role => clawdRuns(role, mood, frame, size))
    expect(new Set(all.map(rows => JSON.stringify(rows.slice(0, 1)))).size).toBe(ROLE_ORDER.length)
    expect(new Set(all.map(rows => JSON.stringify(rows.slice(1)))).size).toBe(1)
  }
})

test('off differs from idle only in colors', () => {
  expect(key('fixer', 'off', 0, 'large') === key('fixer', 'idle', 0, 'large')).toBe(false)
})

test('clawdLines: plain text of the runs', () => {
  const lines = clawdLines('council', 'idle', 0, 'large')
  expect(lines.length).toBe(4)
  for (const l of lines) expect([...l].length).toBe(9)
  expect(clawdLines('council', 'idle', 0, 'small').map(l => [...l].length)).toEqual([9, 9, 9, 9])
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

// Desktop accessories keep their role colors.
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

test('desktop sprites retain their hat and prop for each role', () => {
  for (const role of ROLE_ORDER) {
    const svg = clawdSvg(role, 'idle').toUpperCase()
    for (const c of SIGNATURE[role]) {
      expect(svg.includes(`FILL="${c}"`)).toBe(true)
    }
  }
})

const rects = (svg: string) =>
  [...svg.matchAll(/<rect x="(\d+)" y="(\d+)"[^>]*fill="([^"]+)"/g)].map(m => ({ x: +m[1], y: +m[2], fill: m[3].toUpperCase() }))

test('the council wig has curls hanging beside the face', () => {
  const WIG = ['#D8D5CB', '#A7A397']
  // Desktop: the torso's top row is y 10 in the padded canvas; curls hang below it, behind the eyes.
  const curls = rects(clawdSvg('council', 'idle')).filter(r => WIG.includes(r.fill) && r.y >= 10)
  expect(curls.length >= 4).toBe(true)
  expect(curls.every(r => r.x < 8)).toBe(true)

})

test('a pen hangs from the orchestrator clipboard', () => {
  const PEN = '#C4483D'
  // Desktop: right of the clipboard (x 20-26 in the padded canvas).
  expect(rects(clawdSvg('orchestrator', 'idle')).filter(r => r.fill === PEN && r.x >= 27).length >= 3).toBe(true)

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

test('the original three-row body and poses remain below the hats', () => {
  const feet = '  ▘▘ ▝▝  '
  const lower = '▝▜█████▛▘'
  const poses = [
    [' ▐▛███▜▌ ', lower, feet],
    [' ▐▙███▙▌ ', lower, feet],
    ['▗▟▛███▜▙▖', ' ▜█████▛ ', feet],
    [' ▐▟███▟▌ ', lower, feet],
  ]
  for (const role of ROLE_ORDER) for (let frame = 0; frame < FRAMES; frame++) {
    const rows = clawdLines(role, 'work', frame, 'small')
    expect(rows.slice(1)).toEqual(poses[frame])
    expect(rows.slice(0, 1)).toEqual(clawdLines(role, 'idle', 0, 'small').slice(0, 1))
  }
})

test('terminal sizes match and off preserves the default silhouette and eyes', () => {
  for (const role of ROLE_ORDER) for (const mood of MOODS) for (let f = 0; f < FRAMES; f++) {
    expect(clawdRuns(role, mood, f, 'small')).toEqual(clawdRuns(role, mood, f, 'large'))
    expect(colorsOf(pixels(role, mood, f).slice(2)).size).toBe(2)
  }
  for (const role of ROLE_ORDER) {
    const idle = clawdRuns(role, 'idle', 0, 'small')
    const off = clawdRuns(role, 'off', 3, 'small')
    expect(off.map(row => row.map(r => [r.text, !!r.fg, !!r.bg])))
      .toEqual(idle.map(row => row.map(r => [r.text, !!r.fg, !!r.bg])))
    expect(key(role, 'off', 0, 'small')).not.toBe(key(role, 'idle', 0, 'small'))
  }
})

test('every colored quadrant round-trips without painting over transparent pixels', () => {
  const glyphs = [' ', '▘', '▝', '▀', '▖', '▌', '▞', '▛', '▗', '▚', '▐', '▜', '▄', '▙', '▟', '█']
  for (const role of ROLE_ORDER) for (const mood of MOODS) for (let frame = 0; frame < FRAMES; frame++) {
    const source = pixels(role, mood, frame)
    const rows = clawdRuns(role, mood, frame, 'small')
    rows.forEach((row, y) => {
      let x = 0
      for (const run of row) for (const glyph of run.text) {
        const mask = glyphs.indexOf(glyph)
        expect(mask >= 0).toBe(true)
        for (let bit = 0; bit < 4; bit++) {
          const color = (mask & (1 << bit) ? run.fg : run.bg) ?? null
          expect(color).toBe(source[y * 2 + Math.floor(bit / 2)]![x * 2 + bit % 2])
        }
        x++
      }
    })
  }
})
