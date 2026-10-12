// Terminal cell widths. Everything the HUD lays out is measured in cells, never in `.length`: a wide character
// (CJK, emoji) takes two, a combining mark or joiner none, and the HUD's own glyphs (`●`, `▰`, `✓`, `…`) one.

/** Code points that take two cells. Ambiguous-width symbols (box drawing, arrows, geometric shapes) stay narrow. */
const WIDE: readonly (readonly [number, number])[] = [
  [0x1100, 0x115f], // Hangul Jamo
  [0x231a, 0x231b], // watch, hourglass
  [0x23e9, 0x23ec],
  [0x23f0, 0x23f0],
  [0x23f3, 0x23f3],
  [0x25fd, 0x25fe],
  [0x2614, 0x2615],
  [0x2648, 0x2653],
  [0x267f, 0x267f],
  [0x2693, 0x2693],
  [0x26a1, 0x26a1],
  [0x26aa, 0x26ab],
  [0x26bd, 0x26be],
  [0x26c4, 0x26c5],
  [0x26ce, 0x26ce],
  [0x26d4, 0x26d4],
  [0x26ea, 0x26ea],
  [0x26f2, 0x26f3],
  [0x26f5, 0x26f5],
  [0x26fa, 0x26fa],
  [0x26fd, 0x26fd],
  [0x2705, 0x2705],
  [0x270a, 0x270b],
  [0x2728, 0x2728],
  [0x274c, 0x274c],
  [0x274e, 0x274e],
  [0x2753, 0x2755],
  [0x2757, 0x2757],
  [0x2795, 0x2797],
  [0x27b0, 0x27b0],
  [0x27bf, 0x27bf],
  [0x2b1b, 0x2b1c],
  [0x2b50, 0x2b50],
  [0x2b55, 0x2b55],
  [0x2e80, 0x303e], // CJK radicals, punctuation
  [0x3041, 0x33ff], // kana, CJK symbols
  [0x3400, 0x4dbf],
  [0x4e00, 0xa4cf], // CJK ideographs, Yi
  [0xa960, 0xa97f],
  [0xac00, 0xd7a3], // Hangul syllables
  [0xf900, 0xfaff],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60], // fullwidth forms
  [0xffe0, 0xffe6],
  [0x1f004, 0x1f004], // mahjong red dragon
  [0x1f0cf, 0x1f0cf],
  [0x1f18e, 0x1f18e],
  [0x1f191, 0x1f19a],
  [0x1f200, 0x1f202],
  [0x1f210, 0x1f23b],
  [0x1f240, 0x1f248],
  [0x1f250, 0x1f251],
  [0x1f260, 0x1f265],
  [0x1f300, 0x1f64f], // emoji: pictographs, emoticons
  [0x1f680, 0x1f6ff], // transport
  [0x1f7e0, 0x1f7eb], // colored circles and squares
  [0x1f7f0, 0x1f7f0],
  [0x1f900, 0x1f9ff], // supplemental symbols
  [0x1fa70, 0x1faff],
  [0x20000, 0x3fffd],
]

const inRanges = (cp: number, ranges: readonly (readonly [number, number])[]): boolean => {
  let lo = 0
  let hi = ranges.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const [from, to] = ranges[mid] as readonly [number, number]
    if (cp < from) hi = mid - 1
    else if (cp > to) lo = mid + 1
    else return true
  }
  return false
}

/** Marks and joiners that take no cell of their own. */
const isZeroWidth = (cp: number): boolean =>
  (cp >= 0x0300 && cp <= 0x036f) || // combining diacritics
  (cp >= 0x200b && cp <= 0x200f) || // zero-width space, joiners, direction marks
  (cp >= 0x20d0 && cp <= 0x20ff) ||
  (cp >= 0xfe00 && cp <= 0xfe0f) || // variation selectors
  (cp >= 0x1f3fb && cp <= 0x1f3ff) || // skin tones ride on the previous emoji
  cp === 0x2060 ||
  cp === 0xfeff ||
  cp < 0x20 ||
  (cp >= 0x7f && cp < 0xa0)

const VS16 = 0xfe0f
const ZWJ = 0x200d

/** The cells one code point takes: 0, 1 or 2. */
export function charWidth(cp: number): 0 | 1 | 2 {
  if (isZeroWidth(cp)) return 0
  return inRanges(cp, WIDE) ? 2 : 1
}

/**
 * The cells a string takes. A base character followed by VS16 (emoji presentation) takes two; a character after a
 * ZWJ joins the sequence and adds nothing, so a family emoji counts as one wide glyph.
 */
export function cellWidth(text: string): number {
  let width = 0
  let afterJoiner = false
  const points = Array.from(text, ch => ch.codePointAt(0) as number)
  for (let i = 0; i < points.length; i++) {
    const cp = points[i] as number
    if (cp === ZWJ) {
      afterJoiner = true
      continue
    }
    const w = charWidth(cp)
    if (afterJoiner) {
      afterJoiner = false
      if (w > 0) continue
    }
    if (w === 0) continue
    width += points[i + 1] === VS16 ? 2 : w
  }
  return width
}

// C0 and C1 controls, line and paragraph separators: none may reach a frame, where the terminal would act on them.
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g

/** Controls (tab, newline, ESC, ...) replaced by a space, one for one. */
export const cleanControls = (text: string): string => text.replace(CONTROL, ' ')

/** Text for one row: controls and whitespace runs collapse to one space, ends trimmed. */
export const oneLine = (text: string): string => text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\s]+/g, ' ').trim()

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

/**
 * Cuts a string to at most `max` cells, ending in `…` (one cell) when something was cut, with a trailing space trimmed
 * before it. A string that fits comes back unchanged (controls replaced by spaces). Cuts fall between grapheme clusters,
 * never inside an emoji ZWJ sequence.
 */
export function truncate(input: string, max: number): string {
  if (max <= 0) return ''
  const text = cleanControls(input)
  if (cellWidth(text) <= max) return text
  const room = max - 1
  let used = 0
  let out = ''
  for (const { segment } of graphemes.segment(text)) {
    const w = cellWidth(segment)
    if (used + w > room) break
    used += w
    out += segment
  }
  return `${out.trimEnd()}…`
}

export type Align = 'left' | 'right'

/** Pads with spaces to exactly `width` cells (never cuts). */
export function pad(text: string, width: number, align: Align = 'left'): string {
  const clean = cleanControls(text)
  const gap = Math.max(0, width - cellWidth(clean))
  return align === 'left' ? clean + ' '.repeat(gap) : ' '.repeat(gap) + clean
}

/** Exactly `width` cells: cut with `…` when long, padded when short. */
export function fit(text: string, width: number, align: Align = 'left'): string {
  if (width <= 0) return ''
  return pad(truncate(text, width), width, align)
}

/** `left` and `right` in `width` cells, the right part whole and the left cut to what remains (one gap kept). */
export function spread(left: string, right: string, width: number): string {
  const rightWidth = cellWidth(right)
  if (rightWidth >= width) return fit(right, width, 'right')
  const room = Math.max(0, width - rightWidth - (left === '' ? 0 : 1))
  return pad(truncate(left, room), width - rightWidth) + right
}

/** Wraps on spaces into at most `maxRows` rows of at most `width` cells; the last row ends in `…` when text is left over. */
export function wrap(text: string, width: number, maxRows: number): string[] {
  if (width <= 0 || maxRows <= 0) return []
  const lines: string[] = []
  let line = ''
  for (const word of text.split(/\s+/)) {
    if (word === '') continue
    const next = line === '' ? word : `${line} ${word}`
    if (cellWidth(next) <= width) {
      line = next
      continue
    }
    if (line !== '') lines.push(line)
    // A word longer than a row is cut.
    line = truncate(word, width)
  }
  if (line !== '') lines.push(line)
  if (lines.length <= maxRows) return lines
  return [...lines.slice(0, maxRows - 1), truncate(lines.slice(maxRows - 1).join(' '), width)]
}
