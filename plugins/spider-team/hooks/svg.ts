// The desktop's drawing of the pane's cards as one SVG: each card a plate with only a stroke in its tone, the title in a
// gap of its top edge, its lines on the terminal's grid of cells (every run of text held to its cells' width), gauges,
// attempt blocks and the timeline as shapes, and rails between plates. The rail into the running card moves (SMIL) while
// agents run. Colours follow the system's light or dark scheme. Pure.
import type { Card, PaneModel } from './pane'
import { cells, cut } from './text'
import type { Piece, Style, Tone } from './text'

/** A cell's width and a row's height in CSS pixels, at the font size below. */
export const CELL = 7.2
export const ROW = 18
const FONT = 12
const RADIUS = 8
const RAIL_SECONDS = 2.4

type Colour = Tone | 'fg' | 'dim'
const DARK: Record<Colour, string> = {
  fg: '#e8e8e8', dim: '#8c8c8c', subtle: '#505050', claude: '#d77757', suggestion: '#b1b9f9', success: '#4eba65', warning: '#e5c07b',
  error: '#ff6b80', merged: '#af87ff', planMode: '#48968c', inactive: '#999999',
}
const LIGHT: Record<Colour, string> = {
  fg: '#1f1f1f', dim: '#6b6b6b', subtle: '#c4c4c4', claude: '#c15f3c', suggestion: '#5769f7', success: '#2c7a39', warning: '#966c1e',
  error: '#ab2b3f', merged: '#8700ff', planMode: '#006666', inactive: '#666666',
}
const STYLE_COLOUR: Record<Style, Colour> = { plain: 'fg', title: 'fg', dim: 'dim', ok: 'success', warn: 'warning', error: 'error', bar: 'claude', barEmpty: 'subtle', badge: 'claude' }

const rules = (palette: Record<Colour, string>) => Object.entries(palette).map(([key, hex]) => `.f-${key}{fill:${hex}}.s-${key}{stroke:${hex}}`).join('')
const STYLE = `<style>text{font-family:ui-monospace,Menlo,'SF Mono',monospace;font-size:${FONT}px;white-space:pre}.b{font-weight:700}${rules(DARK)}@media (prefers-color-scheme: light){${rules(LIGHT)}}</style>`

// Control characters and lone surrogates are not XML: they would void the whole drawing.
const esc = (text: string) => text.replace(/[\u0000-\u001f\u007f]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, ' ').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const n = (value: number) => String(Math.round(value * 10) / 10)
const colourOf = (piece: Piece): Colour => (piece.style === 'barEmpty' ? 'subtle' : piece.tone ?? STYLE_COLOUR[piece.style])

/** One run of text at a cell, held to its cells' width so the grid stays aligned in any monospace font. */
function text(piece: Piece, col: number, row: number): string {
  if (!piece.text.trim()) return ''
  const bold = piece.style === 'title' || piece.style === 'error' || piece.style === 'badge'
  const length = cells(piece.text)
  const fit = length > 1 ? ` textLength="${n(length * CELL)}" lengthAdjust="spacingAndGlyphs"` : ''
  return `<text x="${n(col * CELL)}" y="${n(row * ROW + ROW * 0.7)}" class="f-${colourOf(piece)}${bold ? ' b' : ''}"${fit}>${esc(piece.text)}</text>`
}

/** A gauge cell, an attempt block, a timeline bucket or a planned dot as a shape; null for a glyph drawn as text. */
function shape(ch: string, colour: Colour, col: number, row: number): string | null {
  const x = col * CELL
  const top = row * ROW
  const mid = top + ROW / 2
  switch (ch) {
    case '▰': case '▱': return `<rect x="${n(x + 1)}" y="${n(top + 5)}" width="${n(CELL - 2)}" height="${ROW - 10}" rx="1.5" class="f-${colour}"/>`
    case '▮': return `<rect x="${n(x + 0.5)}" y="${n(top + 3)}" width="${n(CELL - 1)}" height="${ROW - 6}" rx="2" class="f-${colour}"/>`
    case '▯': return `<rect x="${n(x + 1)}" y="${n(top + 3.5)}" width="${n(CELL - 2)}" height="${ROW - 7}" rx="2" fill="none" stroke-width="1.2" class="s-${colour}"/>`
    case '━': return `<rect x="${n(x)}" y="${n(mid - 2.5)}" width="${n(CELL)}" height="5" class="f-${colour}"/>`
    case '·': return `<rect x="${n(x)}" y="${n(mid - 1)}" width="${n(CELL)}" height="2" opacity="0.6" class="f-${colour}"/>`
    case '●': return `<circle cx="${n(x + CELL / 2)}" cy="${n(mid)}" r="3.5" class="f-${colour}"/>`
    default: return null
  }
}

/** A run of `length` timeline cells as one rect: lit, or the dim track. */
function stretch(ch: string, colour: Colour, col: number, length: number, row: number): string {
  const mid = row * ROW + ROW / 2
  const [h, opacity] = ch === '━' ? [5, ''] : [2, ' opacity="0.6"']
  return `<rect x="${n(col * CELL)}" y="${n(mid - h / 2)}" width="${n(length * CELL)}" height="${h}"${opacity} class="f-${colour}"/>`
}

/** A line of pieces from a cell on: bars and blocks as shapes, the rest as text. */
function line(pieces: Piece[], col: number, row: number): string {
  let at = col
  let out = ''
  for (const piece of pieces) {
    if (piece.style === 'bar' || piece.style === 'barEmpty') {
      const colour = colourOf(piece)
      const chars = [...piece.text]
      // A run of timeline cells is one stretch, so a wide lane stays a single shape.
      if (chars.every(ch => ch === chars[0]) && (chars[0] === '━' || chars[0] === '·')) out += stretch(chars[0], colour, at, chars.length, row)
      else chars.forEach((ch, i) => { out += shape(ch, colour, at + i, row) ?? text({ ...piece, text: ch }, at + i, row) })
    } else out += text(piece, at, row)
    at += cells(piece.text)
  }
  return out
}

/** A card's plate: a rounded stroke with gaps in its top edge for the title and the aside, then its lines. */
function plate(card: Card, columns: number, row: number): string {
  const x0 = CELL / 2
  const x1 = columns * CELL - CELL / 2
  const y0 = row * ROW + ROW / 2
  const y1 = (row + card.lines.length + 1) * ROW + ROW / 2
  const r = RADIUS
  const count = card.count !== undefined ? `${card.count} ` : ''
  const title: Piece = { text: ` ${cut(card.title, Math.max(1, columns - 6 - cells(count)))} `, style: 'title', tone: card.tone }
  const titleEnd = 2 + cells(title.text) + cells(count)
  const asideCells = card.aside.reduce((sum, piece) => sum + cells(piece.text), 0)
  const asideStart = card.aside.length && titleEnd + asideCells + 4 <= columns ? columns - 2 - asideCells : null
  const gapEnd = asideStart === null ? x1 - r : (asideStart - 1) * CELL
  const path = [
    `M${n(titleEnd * CELL)} ${n(y0)}H${n(gapEnd)}`,
    ...(asideStart === null ? [] : [`M${n((columns - 1) * CELL)} ${n(y0)}H${n(x1 - r)}`]),
    `A${r} ${r} 0 0 1 ${n(x1)} ${n(y0 + r)}V${n(y1 - r)}A${r} ${r} 0 0 1 ${n(x1 - r)} ${n(y1)}H${n(x0 + r)}`,
    `A${r} ${r} 0 0 1 ${n(x0)} ${n(y1 - r)}V${n(y0 + r)}A${r} ${r} 0 0 1 ${n(x0 + r)} ${n(y0)}H${n(2 * CELL)}`,
  ].join('')
  return [
    `<path d="${path}" fill="none" stroke-width="1.2" stroke-opacity="0.8" class="s-${card.tone}"/>`,
    text(title, 2, row),
    count ? text({ text: count, style: 'dim' }, 2 + cells(title.text), row) : '',
    asideStart === null ? '' : line(card.aside, asideStart, row),
    ...card.lines.map((pieces, i) => line(pieces, 2, row + 1 + i)),
  ].join('')
}

/** A rail across a row: a dim line, and in `tone` a head with a fading tail that runs along it when `moving`. */
function rail(columns: number, tone: Tone, row: number, moving: boolean): string {
  const y = n(row * ROW + ROW / 2)
  const from = 2 * CELL
  const to = (columns - 2) * CELL
  const base = `<line x1="${n(from)}" y1="${y}" x2="${n(to)}" y2="${y}" stroke-width="1.2" class="s-subtle"/>`
  if (!moving) return base
  const dots = [[3.6, 1], [2.4, 0.6], [1.8, 0.4], [1.4, 0.25]] as const
  return base + dots.map(([radius, opacity], i) =>
    `<circle cx="${n(from)}" cy="${y}" r="${radius}" opacity="${opacity}" class="f-${tone}"><animate attributeName="cx" values="${n(from)};${n(to)}" dur="${RAIL_SECONDS}s" begin="-${n(i * 0.08)}s" repeatCount="indefinite"/></circle>`).join('')
}

/** The cards as one SVG document `columns` cells wide, and whether it moves (drawn interactive only then). */
export function svgOf(model: PaneModel, columns: number): { source: string; width: number; height: number; moving: boolean } {
  let row = 0
  let body = ''
  let moving = false
  model.cards.forEach((card, i) => {
    if (i) {
      const moves = model.motion && card.key === 'running'
      moving ||= moves
      body += rail(columns, card.tone, row++, moves)
    }
    body += plate(card, columns, row)
    row += card.lines.length + 2
  })
  const width = Math.ceil(columns * CELL)
  const height = row * ROW
  return { source: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">${STYLE}${body}</svg>`, width, height, moving }
}
