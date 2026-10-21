// What the session panel draws: runs of text with a style the renderer maps to theme colours, and the helpers that fit
// them to a width. Pure.

export type Style = 'plain' | 'title' | 'dim' | 'ok' | 'warn' | 'error' | 'bar' | 'barEmpty' | 'badge'
/** A theme colour a piece may take in place of its style's: an agent type's or a card's. */
export type Tone = 'claude' | 'suggestion' | 'success' | 'warning' | 'error' | 'merged' | 'planMode' | 'inactive' | 'subtle'
export type Piece = { text: string; style: Style; tone?: Tone }

export const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const

export const p = (text: string, style: Style = 'plain'): Piece => ({ text, style })
/** A piece in a theme colour, bold when `strong`. */
export const toned = (text: string, tone: Tone, strong = false): Piece => ({ text, style: strong ? 'title' : 'plain', tone })

/** Width in terminal cells, counting code points (names and labels here are narrow characters). */
export const cells = (text: string): number => [...text].length

/** `text` cut to `width` cells, ending in `…` when cut. */
export function cut(text: string, width: number): string {
  const chars = [...text]
  if (chars.length <= width) return text
  return width <= 0 ? '' : `${chars.slice(0, width - 1).join('')}…`
}

/** `text` cut or padded with spaces to exactly `width` cells. */
export const pad = (text: string, width: number): string => {
  const fitted = cut(text, width)
  return fitted + ' '.repeat(Math.max(0, width - cells(fitted)))
}

/** A line of pieces cut to `width` cells, the last piece that crosses the edge ending in `…`. */
export function fit(line: Piece[], width: number): Piece[] {
  const out: Piece[] = []
  let left = width
  for (const piece of line) {
    if (left <= 0) break
    const w = cells(piece.text)
    if (w <= left) { out.push(piece); left -= w } else { out.push({ ...piece, text: cut(piece.text, left) }); left = 0 }
  }
  return out
}

/** A duration as `mm:ss`, or `h:mm:ss` from an hour. */
export function duration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const two = (n: number) => String(n).padStart(2, '0')
  const h = Math.floor(s / 3600)
  return h ? `${h}:${two(Math.floor((s % 3600) / 60))}:${two(s % 60)}` : `${two(Math.floor(s / 60))}:${two(s % 60)}`
}
