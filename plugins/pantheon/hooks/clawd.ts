// Clawd: the Claude Code mascot (blocky orange body, two dark eyes, arm stubs, short legs) with one
// costume prop per role. Pure module: terminal art as half-block text, desktop art as an SVG string.
import type { SlotName } from './roster'

export type Mood = 'work' | 'idle' | 'off'
export const FRAMES = 4

const BODY = '#D97757'
const EYE = '#1F1E1D'
const BODY_OFF = '#8A5A49'

const wrap = (frame: number) => ((Math.trunc(frame) % FRAMES) + FRAMES) % FRAMES

// Terminal props: two cells wide, two rows tall, one per role.
const PROPS: Record<SlotName, [string, string]> = {
  orchestrator: ['▛▜', '▌▐'], // headset: band and ear cups
  explorer: ['▛▜', ' ▝'], // magnifier: lens and handle
  librarian: ['██', '▀▀'], // book
  fixer: ['▀▜', ' ▐'], // wrench
  oracle: ['▝▘', '▘▝'], // sparkle
  designer: [' ▝', '▐▘'], // brush
  council: ['██', '▐ '], // gavel
}

const ZONE = 4 // gap, two prop cells, spare column for the work swing

function place(prop: [string, string], col: number): [string, string] {
  const pad = (s: string) => ' '.repeat(col) + s + ' '.repeat(ZONE - col - 2)
  return [pad(prop[0]), pad(prop[1])]
}

// Small art keeps the logo silhouette: ▐▛███▜▌ over ▝▜█████▛▘, eyes as the two gaps of the top row.
function small(mood: Mood, f: number): [string, string] {
  if (mood !== 'work') {
    return [mood === 'off' ? ' ▐▛▄█▄▜▌ ' : ' ▐▛ █ ▜▌ ', mood === 'off' ? '▝▜█████▛▘' : '▝▜█▌ ▐█▛▘']
  }
  const top = [' ▐▛ █ ▜▌ ', ' ▝▛ █ ▜▘ ', ' ▐▛▄█▄▜▌ ', ' ▘▛ █ ▜▝ '][f]
  const legs = ['▝▜█▌ ▐█▛▘', '▝▜▐█ █▌▛▘', '▝▜█▌ ▐█▛▘', '▝▜█▐ ▌█▛▘'][f]
  return [top, legs]
}

function large(mood: Mood, f: number): string[] {
  if (mood === 'idle') return [' ▐▛███▜▌ ', '▐█ ███ █▌', '▝▜█████▛▘', '  ▘▘ ▝▝  ']
  if (mood === 'off') return [' ▐▛███▜▌ ', '▐█▄███▄█▌', '▝▜█████▛▘', '  ▝▘ ▝▘  ']
  const arms = [['▐', '▌'], ['▝', '▘'], ['▐', '▌'], ['▘', '▝']][f]
  const eye = f === 2 ? '▄' : ' '
  return [
    ' ▐▛███▜▌ ',
    `${arms[0]}█${eye}███${eye}█${arms[1]}`,
    '▝▜█████▛▘',
    ['  ▘▘ ▝▝  ', '  ▝▝ ▘▘  ', '  ▘▘ ▝▝  ', '  ▘▝ ▘▝  '][f],
  ]
}

export function clawdLines(role: SlotName, mood: Mood, frame: number, size: 'small' | 'large' = 'small'): string[] {
  const f = mood === 'work' ? wrap(frame) : 0
  const swing = mood === 'work' && f % 2 === 1
  const prop = PROPS[role]
  if (size === 'small') {
    const [a, b] = small(mood, f)
    const [pa, pb] = place(prop, swing ? 2 : 1)
    return [a + pa, b + pb]
  }
  const body = large(mood, f)
  const rows = swing ? 1 : 0
  const [pa, pb] = place(prop, 1)
  const empty = ' '.repeat(ZONE)
  const zone = [empty, empty, empty, empty]
  zone[rows] = pa
  zone[rows + 1] = pb
  return body.map((l, i) => l + zone[i])
}

// Desktop: pixel grid, 3x3 prop bitmaps per role.
const GW = 16
const GH = 11
const SVG_PROPS: Record<SlotName, { color: string; bits: [string, string, string] }> = {
  orchestrator: { color: '#6BA3E8', bits: ['###', '#.#', '#.#'] },
  explorer: { color: '#7FD1AE', bits: ['##.', '##.', '..#'] },
  librarian: { color: '#C9A66B', bits: ['#.#', '###', '###'] },
  fixer: { color: '#B8BCC4', bits: ['#.#', '###', '.#.'] },
  oracle: { color: '#E8C547', bits: ['.#.', '###', '.#.'] },
  designer: { color: '#C77DDB', bits: ['..#', '.#.', '#..'] },
  council: { color: '#D4D0C8', bits: ['###', '.#.', '.#.'] },
}

const rect = (x: number, y: number, w: number, h: number, fill: string, cls = '') =>
  `<rect${cls ? ` class="${cls}"` : ''} x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}"/>`

export function clawdSvg(role: SlotName, mood: Mood, size = 28): string {
  const body = mood === 'off' ? BODY_OFF : BODY
  const parts: string[] = []
  // body with clipped corners, arm stubs at mid-height
  parts.push(rect(4, 2, 8, 1, body), rect(3, 3, 10, 3, body), rect(4, 6, 8, 1, body))
  parts.push(rect(2, 4, 1, 1, body, 'clawd-arm'), rect(13, 4, 1, 1, body, 'clawd-arm'))
  // eyes
  if (mood === 'off') parts.push(rect(5, 4, 2, 0.4, EYE), rect(9, 4, 2, 0.4, EYE))
  else parts.push(rect(5, 3, 1, 2, EYE, 'clawd-eye'), rect(10, 3, 1, 2, EYE, 'clawd-eye'))
  // legs
  parts.push(rect(5, 7, 2, 2, body, 'clawd-leg-a'), rect(9, 7, 2, 2, body, 'clawd-leg-b'))
  // prop
  const p = SVG_PROPS[role]
  const props: string[] = []
  p.bits.forEach((row, y) => [...row].forEach((c, x) => { if (c === '#') props.push(rect(x, y, 1, 1, p.color)) }))
  parts.push(`<g class="clawd-prop" transform="translate(13 0)">${props.join('')}</g>`)
  const css = mood === 'work'
    ? '<style>'
      + '@keyframes clawd-step{0%,100%{transform:translateY(0)}50%{transform:translateY(-0.6px)}}'
      + '@keyframes clawd-swing{0%,100%{transform:translateY(0)}50%{transform:translateY(-1px)}}'
      + '@keyframes clawd-blink{0%,90%,100%{opacity:1}95%{opacity:0}}'
      + '.clawd-leg-a{animation:clawd-step .6s steps(2,jump-none) infinite}'
      + '.clawd-leg-b{animation:clawd-step .6s steps(2,jump-none) infinite reverse}'
      + '.clawd-arm,.clawd-prop{animation:clawd-swing .6s ease-in-out infinite}'
      + '.clawd-eye{animation:clawd-blink 3s steps(1) infinite}'
      + '@media (prefers-reduced-motion: reduce){.clawd-leg-a,.clawd-leg-b,.clawd-arm,.clawd-prop,.clawd-eye{animation:none}}'
      + '</style>'
    : ''
  const width = Math.round((size * GW) / GH)
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${GW} ${GH}" width="${width}" height="${size}" shape-rendering="crispEdges">${css}${parts.join('')}</svg>`
}
