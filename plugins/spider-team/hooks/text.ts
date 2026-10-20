// What the pane draws: runs of text with a style the renderer maps to theme colours, and the helpers that
// fit them to a width. Pure.

export type Style = 'plain' | 'title' | 'dim' | 'ok' | 'warn' | 'error' | 'bar' | 'barEmpty' | 'badge'
/** A theme colour a piece may take in place of its style's: a role's or a card's. */
export type Tone = 'claude' | 'suggestion' | 'success' | 'warning' | 'error' | 'merged' | 'planMode' | 'inactive' | 'subtle'
export type Piece = { text: string; style: Style; tone?: Tone }

const LIT_RUN = 4 // cells lit in the moving stretch of an indeterminate bar

export const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const

export const p = (text: string, style: Style = 'plain'): Piece => ({ text, style })
/** A piece in a theme colour, bold when `strong`. */
export const toned = (text: string, tone: Tone, strong = false): Piece => ({ text, style: strong ? 'title' : 'plain', tone })

/** Width in terminal cells, counting code points (titles and labels here are narrow characters). */
export const cells = (text: string): number => [...text].length

/** `text` cut to `width` cells, ending in `…` when cut. */
export function cut(text: string, width: number): string {
  const chars = [...text]
  if (chars.length <= width) return text
  return width <= 0 ? '' : `${chars.slice(0, width - 1).join('')}…`
}

/**
 * `text` broken at spaces into lines of at most `width` cells, a word longer than a line split across lines; past `max`
 * lines the last one ends in `…`.
 */
export function wrap(text: string, width: number, max: number): string[] {
  if (width <= 0 || max <= 0) return []
  const lines: string[] = []
  let line = ''
  for (const word of text.split(/\s+/).filter(Boolean)) {
    let rest = word
    while (rest) {
      if (cells(rest) <= (line ? width - cells(line) - 1 : width)) {
        line = line ? `${line} ${rest}` : rest
        rest = ''
      } else if (line) {
        lines.push(line)
        line = ''
      } else {
        const chars = [...rest]
        lines.push(chars.slice(0, width).join(''))
        rest = chars.slice(width).join('')
      }
    }
  }
  if (line) lines.push(line)
  if (lines.length <= max) return lines
  // The next line did not fit beside the last kept one, so joining them always crosses `width` and ends in `…`.
  const last = [...`${lines[max - 1]} ${lines[max]}`].slice(0, width - 1).join('').trimEnd()
  return [...lines.slice(0, max - 1), `${last}…`]
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

/** A Claude model id as people name it (`claude-opus-5-5` → `Opus 5.5`); anything else as given. */
export function modelName(model: string | undefined): string | undefined {
  if (!model) return undefined
  const m = /claude-(fable|mythos|opus|sonnet|haiku)-(\d+)(?:-(\d{1,2}))?(?!\d)/.exec(model)
  return m ? `${m[1]![0]!.toUpperCase()}${m[1]!.slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ''}` : model
}

/** A bar `width` cells wide lit to `percent`; with no percent, a dim track with a short lit stretch that moves with `frame`. */
export function bar(percent: number | undefined, width: number, frame: number): Piece[] {
  if (width <= 0) return []
  if (percent === undefined) {
    const run = Math.min(LIT_RUN, width)
    const at = frame % width
    const lit = Array.from({ length: width }, (_, i) => (i - at + width) % width < run)
    return lit.map(on => p(on ? '━' : '░', on ? 'bar' : 'barEmpty')).reduce<Piece[]>((acc, piece) => {
      const last = acc.at(-1)
      if (last && last.style === piece.style) last.text += piece.text
      else acc.push({ ...piece })
      return acc
    }, [])
  }
  const full = Math.round((Math.max(0, Math.min(100, percent)) / 100) * width)
  return [p('━'.repeat(full), 'bar'), p('░'.repeat(width - full), 'barEmpty')].filter(piece => piece.text)
}
