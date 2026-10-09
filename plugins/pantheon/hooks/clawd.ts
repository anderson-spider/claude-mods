// Claude mascot, a side-on pixel sprite with one hat and one held prop per role. Pure module:
// the terminal art (15 x 12 pixels, and a separate 8 x 6 one) as half-block runs, the desktop art
// (30 x 26, shaded and outlined) as an SVG string.
import type { SlotName } from './roster'

export type Mood = 'work' | 'idle' | 'off'
export type Cell = string | null
export type Run = { text: string; fg?: string; bg?: string }

export const FRAMES = 4
export const COLS = 15
export const ROWS = 12

const BODY = '#D0795A'
const EYE = '#1C1B1A'
const OFF_BODY = '#7a5445'

export const ROLE_COLOR: Record<SlotName, string> = {
  orchestrator: '#5B93E6',
  explorer: '#3FA57D',
  librarian: '#C9A24A',
  fixer: '#8F96A6',
  oracle: '#A56BD8',
  designer: '#D870A8',
  council: '#B8B3A6',
}

// ---- Terminal sprite (15 x 12) ----

// Canvas rows 4-9: 9-column torso, left arm stub, right ear bump, two square eyes.
const BODY_ROWS = [
  '..OOOOOOOOOOO..',
  '..OEOOOOOEOOO..',
  'OOOOOOOOOOO....',
  'OOOOOOOOOOO....',
  '..OOOOOOOOO....',
  '..OOOOOOOOO....',
]
// Canvas rows 10-11, two walk poses.
const LEGS = [
  ['..O.O...O.O....', '..O.O...O.O....'],
  ['...O.O.O.O.....', '...O.O.O.O.....'],
]

// Hat per role (canvas rows 0-3); rows past 3 lie over the body, where '.' leaves it showing.
const HATS: Record<SlotName, string[]> = {
  orchestrator: ['......WW.......', '..WWWWWWWWW....', '..WWWgWWWWW....', '..RBBBBBBBBVVV.'],
  explorer: ['...............', '....QQ..QQ.....', '...QqqqqqqQ....', '..QQQQQQQQQQQ..'],
  librarian: ['......DD.......', '..DDDDDDDDDDD.Y', '....DDDDDDD...Y', '...............'],
  // No hat: a mug of coffee, steaming, in the left hand.
  fixer: ['...............', '...............', 'z..............', '.z.............', 'ww.............', 'ww.............'],
  oracle: ['.......b.......', '......bbb......', '.....bbSbb.....', '..bbbbbbbbbbb..'],
  designer: ['...............', '......MM.......', '....MMMMMM.....', '..MMMMMMMMMMM..'],
  council: ['...............', '....LLLLLL.....', '..LLLLLLLLLLL..', '.lLLlLLLlLLLL..', 'Ll.............', 'lL.............'],
}
// Held prop per role: rows from `y` down, columns 11-14.
const PROPS: Record<SlotName, { y: number; rows: string[] }> = {
  // The clipboard's pen hangs on a string from the clip.
  orchestrator: { y: 6, rows: ['....', '.nng', 'WWWg', 'WLWr', 'WLWr', 'WWWK'] },
  explorer: { y: 6, rows: ['.AA.', 'AaaA', 'AaaA', '.AA.', '.n..', 'n...'] },
  librarian: { y: 6, rows: ['....', 'rrrr', 'rwYr', 'rwwr', 'rrrr', '....'] },
  fixer: { y: 6, rows: ['HHHH', 'HCKH', 'HKKH', 'HCCH', 'hhhh'] },
  oracle: { y: 1, rows: ['..S.', '.SSS', '..S.', '..N.', '..N.', '.N..', 'N...'] },
  designer: { y: 6, rows: ['...C', '..nC', '.n..', 'n...', '....', '....'] },
  council: { y: 6, rows: ['.NNN', '.NNN', '..N.', '..N.', '..N.', '....'] },
}

const PALETTE: Record<string, string> = {
  O: BODY, E: EYE, W: '#F5F4EF', g: '#CFCFC6', B: '#4A86D8', R: '#B0664D', V: '#4D4D4B',
  Y: '#EEBB4D', K: '#2E2A28', Q: '#6E625A', q: '#9A8B7E', D: '#3B3B40', C: '#4FB6D8', N: '#6B4A2E',
  M: '#D870A8', m: '#A8507F', L: '#D8D5CB', l: '#A7A397', A: '#E9C04F', a: '#CFD4D9', H: '#C4C9D6',
  h: '#8C92A3', r: '#C4483D', w: '#F6EFDD', z: '#FFE9CF', n: '#7A5230', b: '#2D4A8C', S: '#FFF1A8',
}

function wrap(frame: number): number {
  return ((frame % FRAMES) + FRAMES) % FRAMES
}

function dim(hex: string, keep: number, floor: number): string {
  const n = parseInt(hex.slice(1), 16)
  const mix = (v: number) => Math.round(v * keep + floor * (1 - keep))
  return '#' + [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(mix).map(v => v.toString(16).padStart(2, '0')).join('')
}

// The small sprite (8 x 6), drawn on its own: body rows 2-4 with both eyes, legs on row 5.
const SMALL_BODY = ['........', '........', '.OEOOEO.', 'OOOOOOO.', '.OOOOOO.']
const SMALL_LEGS = ['.O.OO.O.', 'O.O..O.O']
// Hat and prop per role over the small body; '.' leaves it showing.
const SMALL: Record<SlotName, string[]> = {
  orchestrator: ['..WWW...', '.BBBBBV.', '.......n', '.......W', '.......W'],
  explorer: ['..QqqQ..', '.QQQQQQQ', '.......a', '.......n'],
  librarian: ['.DDDDDD.', '..KKKK.Y', '.......Y', '.......r', '.......r'],
  fixer: ['z.......', '.z......', 'w......H', 'w......C', '.......h'],
  oracle: ['...bb..S', '.bbbbbbN', '.......N'],
  designer: ['....M...', '.MMMMMmC', '.......N', '.......N'],
  council: ['.LLLLLL.', 'lLLLLLLl', 'l......N', '.......n'],
}

// The terminal grid: a color string or null per pixel. Off closes the eyes and dims the colors.
export function pixels(role: SlotName, mood: Mood, frame: number, size: 'small' | 'large' = 'large'): Cell[][] {
  const body = mood === 'off' ? OFF_BODY : BODY
  const pose = mood === 'work' ? wrap(frame) % 2 : 0
  const small = size === 'small'
  const rows = (small ? [...SMALL_BODY, SMALL_LEGS[pose]] : [...Array<string>(4).fill(''), ...BODY_ROWS, ...LEGS[pose]])
    .map(r => [...r.padEnd(small ? 8 : COLS, '.')])
  const over = (x: number, y: number, art: string[]) =>
    art.forEach((r, j) => [...r].forEach((ch, i) => { if (ch !== '.') rows[y + j][x + i] = ch }))
  if (small) over(0, 0, SMALL[role])
  else {
    over(0, 0, HATS[role])
    over(11, PROPS[role].y, PROPS[role].rows)
  }
  return rows.map(row =>
    row.map(ch => {
      if (ch === '.') return null
      if (ch === 'O') return body
      if (ch === 'E') return mood === 'off' ? body : EYE
      const c = PALETTE[ch]
      return mood === 'off' ? dim(c, 0.55, 28) : c
    }),
  )
}

function halfBlocks(g: Cell[][]): Run[][] {
  const rows: Run[][] = []
  for (let y = 0; y < g.length; y += 2) {
    const runs: Run[] = []
    for (let x = 0; x < g[y].length; x++) {
      const top = g[y][x]
      const bottom = g[y + 1]?.[x] ?? null
      let run: Run
      if (top && bottom) run = { text: '▀', fg: top, bg: bottom }
      else if (bottom) run = { text: '▄', fg: bottom }
      else if (top) run = { text: '▀', fg: top }
      else run = { text: ' ' }
      const last = runs[runs.length - 1]
      if (last && last.fg === run.fg && last.bg === run.bg) last.text += run.text
      else runs.push(run)
    }
    rows.push(runs)
  }
  return rows
}

export function clawdRuns(role: SlotName, mood: Mood, frame: number, size: 'small' | 'large'): Run[][] {
  return halfBlocks(pixels(role, mood, frame, size))
}

export function clawdLines(role: SlotName, mood: Mood, frame: number, size: 'small' | 'large'): string[] {
  return clawdRuns(role, mood, frame, size).map(row => row.map(r => r.text).join(''))
}

// ---- Desktop sprite (30 x 26) ----

const W = 30
const H = 26
const IW = 28
const IH = 24

const PAL: Record<string, string> = {
  O: '#FF7F50', s: '#D4603A', K: '#141211', X: '#2A140C',
  b: '#2D4A8C', n: '#17275A', c: '#F6DDB0', Y: '#F6C445', y: '#D9A52E',
  g: '#6E625A', k: '#2E2A28', a: '#CFD4D9', w: '#F6EFDD', T: '#D88A2E', t: '#9A5A1E',
  W: '#F5F4EF', G: '#CFCFC6', B: '#4A86D8', v: '#4D4D4B', r: '#C4483D', q: '#7E2A24', D: '#3B3B40',
  M: '#D870A8', m: '#A8507F', C: '#4FB6D8', N: '#6B4A2E', H: '#C4C9D6', h: '#8C92A3',
  L: '#D8D5CB', l: '#A7A397', x: '#4A2E1E', z: '#FFE9CF', S: '#FFF1A8', Z: '#FFF1A8', P: '#9A62D6',
}

const BLANK = '........................'
const HAT: Record<SlotName, string[]> = {
  oracle: [
    '..........bbb...........',
    '.........bbbbn..........',
    '.........bbbbbn.........',
    '........bbbbbbn.........',
    '........bbbbbbbn........',
    '.......bbbbbbbbn........',
    '.......cccccccccn.......',
    '....bbbbbbbbbbbbbbbn....',
    '...nnbbbbbbbbbbbbbnnn...',
  ],
  explorer: [
    BLANK,
    '..........kk..kk........',
    '.........kkkkkkkk.......',
    '........kggggggggk......',
    '.......kggggggggggk.....',
    '......kggggggggggggk....',
    '.....kkkkkkkkkkkkkkkk...',
    '....kkggggggggggggggkk..',
    BLANK,
  ],
  librarian: [
    BLANK, BLANK, BLANK, BLANK, BLANK,
    '......DDDDDDDDDDDD......',
    '....DDDDDDDDDDDDDDDD.Y..',
    '......kkkkkkkkkkkk...Y..',
    BLANK,
  ],
  fixer: Array<string>(9).fill(BLANK),
  designer: [
    BLANK,
    '..........M.............',
    '......MMMMMMMMMM........',
    '....MMMMMMMMMMMMMMm.....',
    '...MMMMMMMMMMMMMMMMm....',
    '...mmmmmmmmmmmmmmmmm....',
    BLANK, BLANK, BLANK,
  ],
  council: [
    BLANK,
    '.......LLLLLLLL.........',
    '.....LLLLLLLLLLLL.......',
    '....LLlLLLLLLLlLLLL.....',
    '...LLLLLlLLLLLLLLLLL....',
    '...LlLLLLLLLLlLLLLLL....',
    '...lLLLLLLLLLLLLLLLl....',
    '..LLLLLLLLLLLLLLLLLLL...',
    '..lL...............Ll...',
  ],
  orchestrator: [
    BLANK,
    '...........WWW..........',
    '.......WWWWWWWWWWW......',
    '.......WWWGWWWWWWW......',
    '.......WWWWWWWWWWW......',
    '......BBBBBBYBBBBBB.....',
    '......BBBBBBBBBBBBvvvv..',
    BLANK, BLANK,
  ],
}

type Stamp = [number, number, string[]]
type Line = [number, number, number, number, string]
// `frames` are drawn over the prop, one per step of its loop while working; frame 0 is the still.
type Prop = { stamp?: Stamp[]; line?: Line[]; hand?: [number, number]; arm?: number; frames?: Stamp[][]; step?: number }

// The laptop's code lines, scrolling up one row per frame through its six-row screen.
const CODE = ['nCCnCCCnn', 'nnnnnnnnn', 'nCCCCnnnn', 'nnnnnCCCn', 'nnnnnnnnn', 'nnCCCnCCn']
// A glint sweeping across the lens now and then: frames 1-3 of six.
const GLINT: [number, number][][] = [[], [[21, 11], [22, 10]], [[21, 13], [22, 12], [23, 11], [24, 10]], [[23, 13], [24, 12]], [], []]
const PROP: Record<SlotName, Prop> = {
  oracle: {
    // S twinkles, Z (the small stars) half a beat later.
    stamp: [[23, 1, ['..S..', '.SSS.', 'SSSSS', '.SSS.', '..S..']], [20, 2, ['Z']], [26, 8, ['Z']]],
    line: [[19, 14, 24, 6, 'N']],
    hand: [18, 13],
  },
  explorer: {
    stamp: [[19, 8, ['..kkk..', '.kaaak.', 'kaaaaak', 'kwaaaak', 'kwaaaak', '.kaaak.', '..kkk..']]],
    line: [[19, 15, 17, 17, 'N']],
    hand: [17, 16],
    frames: GLINT.map(f => f.map(([x, y]): Stamp => [x, y, ['W']])),
    step: 0.35,
  },
  librarian: {
    stamp: [[19, 10, ['qqqqqqq', 'qrrrrrw', 'qrYYYrw', 'qrrrrrw', 'qrYYrrw', 'qrrrrrw', 'qqqqqqq']]],
    hand: [17, 13],
  },
  fixer: {
    stamp: [[14, 8, [
      '..HHHHHHHHHHH',
      '..HnnnnnnnnnH',
      '..HnCCnCCCnnH',
      '..HnnnnnnnnnH',
      '..HnCCCCnnnnH',
      '..HnnnnnCCCnH',
      '..HnnnnnnnnnH',
      '..HHHHHHHHHHH',
      'HHHHHHHHHHHHH',
      'hhhhhhhhhhhhh',
    ]]],
    frames: CODE.map((_, k) => [[17, 9, CODE.map((_, j) => CODE[(k + j) % CODE.length])]]),
    step: 0.3,
  },
  designer: {
    stamp: [[24, 3, ['.CC.', 'CCCC', 'CCCC', '.HH.', '.HH.']]],
    line: [[18, 15, 24, 9, 'N']],
    hand: [18, 14],
  },
  council: {
    stamp: [
      [19, 8, ['NNNNNNN', 'NttttNN', 'NNNNNNN', 'NNNNNNt']], [18, 18, ['NNNNNNNNN', 'ttttttttt']], [21, 12, ['NN', 'NN', 'NN', 'NN', 'NN', 'NN']],
      // The wig's side curls, hanging behind the face.
      [2, 8, ['LLL', 'lll', 'LLL', 'lll']],
    ],
    hand: [20, 14],
    arm: 5,
  },
  orchestrator: {
    stamp: [
      [19, 10, ['..ttt..', 'WWWWWWW', 'WLLLLLW', 'WWWWWWW', 'WLLLLWW', 'WWWWWWW', 'WLLLWWW', 'WWWWWWW']],
      // A pen on a string, hanging off the clipboard's edge.
      [26, 10, ['g', 'g', 'r', 'r', 'r', 'r', 'k']],
    ],
    hand: [17, 14],
  },
}

// The 30 x 26 character grid; `legB` selects the second walking pose, `fx` the prop's frame.
function grid(role: SlotName, mood: Mood, legB: boolean, fx = 0): string[][] {
  const g = Array.from({ length: IH }, () => Array<string>(IW).fill('.'))
  const px = (x: number, y: number, c: string) => { if (g[y]?.[x] !== undefined) g[y][x] = c }
  const rect = (x: number, y: number, w: number, h: number, c: string) => {
    for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) px(i, j, c)
  }
  const stamp = (x: number, y: number, rows: string[]) =>
    rows.forEach((r, j) => [...r].forEach((ch, i) => { if (ch !== '.' && ch !== ' ') px(x + i, y + j, ch) }))
  const line = (x0: number, y0: number, x1: number, y1: number, c: string) => {
    const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0))
    for (let k = 0; k <= n; k++) {
      const x = Math.round(x0 + ((x1 - x0) * k) / n)
      const y = Math.round(y0 + ((y1 - y0) * k) / n)
      px(x, y, c); px(x + 1, y, c)
    }
  }
  const p = PROP[role]
  rect(4, 9, 13, 9, 'O')
  rect(17, 9, 3, 3, 'O')
  rect(1, 12, 3, 3, 'O')
  const legs = legB ? [5, 8, 11, 14] : [4, 7, 12, 15]
  legs.forEach(x => rect(x, 18, 2, 2, 'O'))
  if (p.hand || role === 'orchestrator') rect(17, role === 'explorer' ? 16 : role === 'librarian' ? 13 : 14, p.arm ?? 3, 2, 'O')
  // Shade: the right edge of the body and the sole of each leg only.
  const snap = g.map(r => [...r])
  for (let j = 0; j < IH; j++) for (let i = 0; i < IW; i++) {
    if (snap[j][i] !== 'O') continue
    if ((snap[j][i + 1] !== 'O' && j < 18) || j === 19) g[j][i] = 's'
  }
  // Seat the hat: its lowest row touches the torso's top row (index 8).
  const hat = HAT[role]
  const last = hat.map(r => /[^.]/.test(r)).lastIndexOf(true)
  stamp(0, last >= 0 ? Math.max(0, 8 - last) : 0, hat)
  const eye = (x: number) => (mood === 'off' ? rect(x, 12, 3, 1, 'K') : rect(x, 11, 2, 3, 'K'))
  eye(7); eye(13)
  p.stamp?.forEach(([x, y, rows]) => stamp(x, y, rows))
  p.frames?.[fx]?.forEach(([x, y, rows]) => stamp(x, y, rows))
  p.line?.forEach(([a, b, c, d, ch]) => line(a, b, c, d, ch))
  if (p.hand) {
    const [hx, hy] = p.hand
    rect(hx, hy, 2, 2, 'O'); px(hx + 1, hy, 's'); px(hx + 1, hy + 1, 's'); px(hx, hy + 1, 's')
  }
  if (role === 'fixer') stamp(0, 6, ['.zz.', '.z..', 'wxxw', 'wwwh', 'wwwh', 'www.'])
  // 1px outline around everything, in a padded canvas.
  const out = Array.from({ length: H }, () => Array<string>(W).fill('.'))
  for (let j = 0; j < IH; j++) for (let i = 0; i < IW; i++) out[j + 1][i + 1] = g[j][i]
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    if (out[j][i] !== '.') continue
    const n = [out[j - 1]?.[i], out[j + 1]?.[i], out[j]?.[i - 1], out[j]?.[i + 1]]
    if (n.some(c => c && c !== '.' && c !== 'X' && c !== 'S' && c !== 'Z' && c !== 'z')) out[j][i] = 'X'
  }
  return out
}

const rectAt = (x: number, y: number, fill: string) =>
  `<rect x="${x}" y="${y}" width="1.03" height="1.03" fill="${fill}"/>`

export function clawdSvg(role: SlotName, mood: Mood, height = 52, background?: string): string {
  const color = (ch: string) => {
    const c = PAL[ch] ?? '#ff00ff'
    return mood === 'off' ? dim(c, 0.5, 27) : c
  }
  const head = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${(height * W) / H}" height="${height}" shape-rendering="crispEdges"${background ? ` style="background:${background}"` : ''}>${background ? `<rect width="100%" height="100%" fill="${background}"/>` : ''}`
  const a = grid(role, mood, false)
  if (mood !== 'work') {
    const still: string[] = []
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) if (a[j][i] !== '.') still.push(rectAt(i, j, color(a[j][i])))
    return `${head}${still.join('')}</svg>`
  }
  // Working: the legs alternate (la, lb), the stars twinkle (tw, tw2) and the prop's frames loop (fx).
  const b = grid(role, mood, true)
  const p = PROP[role]
  const fx = (p.frames ?? []).map((_, k) => grid(role, mood, false, k))
  const layer = { base: [] as string[], la: [] as string[], lb: [] as string[], tw: [] as string[], tw2: [] as string[] }
  const frames = fx.map((): string[] => [])
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const ca = a[j][i]
    const cb = b[j][i]
    if (ca !== cb) {
      if (ca !== '.') layer.la.push(rectAt(i, j, color(ca)))
      if (cb !== '.') layer.lb.push(rectAt(i, j, color(cb)))
    } else if (fx.some(g => g[j][i] !== ca)) {
      // The still sits under the frames too, so seams between scaled cells never show the background.
      if (ca !== '.') layer.base.push(rectAt(i, j, color(ca)))
      fx.forEach((g, k) => { if (g[j][i] !== '.') frames[k].push(rectAt(i, j, color(g[j][i]))) })
    } else if (ca !== '.') {
      layer[ca === 'S' ? 'tw' : ca === 'Z' ? 'tw2' : 'base'].push(rectAt(i, j, color(ca)))
    }
  }
  const n = frames.length
  const step = p.step ?? 0.3
  const style =
    '<style>' +
    '@keyframes la{0%{opacity:1}50%{opacity:0}}' +
    '@keyframes lb{0%{opacity:0}50%{opacity:1}}' +
    '@keyframes tw{0%{opacity:1}50%{opacity:.3}100%{opacity:1}}' +
    '.la{animation:la .5s steps(1,end) infinite}' +
    '.lb{animation:lb .5s steps(1,end) infinite}' +
    '.tw{animation:tw 1.2s steps(1,end) infinite}' +
    '.tw2{animation:tw 1.2s steps(1,end) -.6s infinite}' +
    (n
      ? `@keyframes fx{0%{opacity:1}${+(100 / n).toFixed(3)}%,100%{opacity:0}}` +
        `.fx{animation:fx ${+(n * step).toFixed(3)}s steps(1,end) infinite}` +
        frames.map((_, k) => `.f${k}{animation-delay:${k ? -+((n - k) * step).toFixed(3) : 0}s}`).join('')
      : '') +
    '@media (prefers-reduced-motion: reduce){.la,.lb,.tw,.tw2{animation:none}.lb{opacity:0}.fx{animation:none;opacity:0}.f0{opacity:1}}' +
    '</style>'
  const group = (cls: string, rects: string[]) => (rects.length ? `<g class="${cls}">${rects.join('')}</g>` : '')
  return (
    head + style + layer.base.join('') +
    group('la', layer.la) + group('lb', layer.lb) + group('tw', layer.tw) + group('tw2', layer.tw2) +
    frames.map((r, k) => group(`fx f${k}`, r)).join('') +
    '</svg>'
  )
}
