// The terminal's drawing of the session panel's cards, line by line: each card in a rounded border of its tone with its
// title, count and aside set in the top border, and a rail between cards; the rail into the running card moves while
// agents run. Pure.
import type { Card, PaneModel } from './model'
import { cells, cut, p, toned } from './text'
import type { Piece, Tone } from './text'

/** Cells the rail's head moves each second, and the fading dots behind it. */
const RAIL_STEP = 4
const RAIL_TAIL = 3

const width = (line: Piece[]) => line.reduce((n, piece) => n + cells(piece.text), 0)

/** Pieces with the same style and tone joined, so a drawn line has few runs. */
function merged(line: Piece[]): Piece[] {
  return line.filter(piece => piece.text).reduce<Piece[]>((out, piece) => {
    const last = out.at(-1)
    if (last && last.style === piece.style && last.tone === piece.tone) last.text += piece.text
    else out.push({ ...piece })
    return out
  }, [])
}

/** Where the rail's head is at `frame`, or null for a still rail. */
export const railHead = (length: number, frame: number, moving: boolean): number | null => (moving && length > 0 ? (frame * RAIL_STEP) % length : null)

/** A rail `columns` wide in `tone`: a dim line, with a head and a fading tail where `head` is set. */
export function rail(columns: number, tone: Tone, head: number | null): Piece[] {
  const length = Math.max(0, columns - 4)
  const cell = (i: number): Piece => {
    if (head === null) return p('─', 'barEmpty')
    if (i === head) return toned('●', tone, true)
    return i < head && head - i <= RAIL_TAIL ? toned('•', tone) : p('─', 'barEmpty')
  }
  return merged([p('  '), ...Array.from({ length }, (_, i) => cell(i))])
}

/** A card in its border: the top carries the title, the count and, where it fits, the aside. */
export function cardLines(card: Card, columns: number): Piece[][] {
  const inner = columns - 4
  const count = card.count !== undefined ? [p(`${card.count} `, 'dim')] : []
  const title = toned(` ${cut(card.title, Math.max(1, columns - 6 - width(count)))} `, card.tone, true)
  const head = [toned('╭─', card.tone), title, ...count]
  const aside = card.aside.length && width(head) + width(card.aside) + 4 <= columns ? [p(' '), ...card.aside, p(' ')] : []
  const fill = Math.max(0, columns - 1 - width(head) - width(aside))
  const top = [...head, toned('─'.repeat(fill), card.tone), ...aside, toned('╮', card.tone)]
  const rows = card.lines.map(line => [toned('│ ', card.tone), ...line, p(' '.repeat(Math.max(0, inner - width(line)))), toned(' │', card.tone)])
  return [top, ...rows, [toned(`╰${'─'.repeat(Math.max(0, columns - 2))}╯`, card.tone)]].map(merged)
}

/** The whole pane as lines: the header, the cards with a rail before each but the first, and the footer. */
export function terminalLines(model: PaneModel, columns: number): Piece[][] {
  const cards = model.cards.flatMap((card, i) => [
    ...(i ? [rail(columns, card.tone, railHead(columns - 4, model.frame, model.motion && card.key === 'running'))] : []),
    ...cardLines(card, columns),
  ])
  return [model.header, [], ...cards, [], model.footer]
}
