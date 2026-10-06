// Pure formatting of $.session.usage() into one card per reading, each split
// into a left side (label, percent, pace) and a right side (tokens or the time
// to the reset), as toned segments the band colors:
// ctx 24%    244k / 1M  |  5h 23% ▼50    1h 21m  |  7d 7% ●    6d 14h

export type Usage = {
  context: { tokens?: number; window: number; percent?: number }
  rateLimits: { kind: string; percentUsed: number; resetsAt?: string }[]
}

// label: the item's name, quiet; plain, warn and bad: the percent under 50%,
// from 50% and from 80%; ahead and behind: a pace with room to spare and one
// spending fast; muted: details, separators and a pace on track.
export type Tone = 'label' | 'plain' | 'warn' | 'bad' | 'ahead' | 'behind' | 'muted'

export type Segment = { text: string; tone: Tone }

const WINDOWS: { kind: string; label: string; seconds: number }[] = [
  { kind: 'five_hour', label: '5h', seconds: 5 * 3600 },
  { kind: 'seven_day', label: '7d', seconds: 7 * 86400 },
]

// Points off pace that still count as on it: one point either way is noise.
export const PACE_TOLERANCE = 5

// "850", "90k", "1M", "1.2M"
export function formatTokens(n: number): string {
  if (n < 1000) return String(Math.trunc(n))
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
}

// "3d 4h", "2h 15m" or "40m"
export function formatReset(resetsAt: number, now: number): string {
  const d = Math.max(0, Math.trunc((resetsAt - now) / 1000))
  const days = Math.trunc(d / 86400)
  const hours = Math.trunc((d % 86400) / 3600)
  const mins = Math.trunc((d % 3600) / 60)
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${mins}m`
  return `${mins}m`
}

// Usage minus the share of the window already gone, in points: -N under pace,
// +N over it, 0 on it. Nothing once expired or in the window's first 1%.
export function paceOf(used: number, resetsAt: number, seconds: number, now: number): number | undefined {
  const rem = (resetsAt - now) / 1000
  if (rem <= 0 || rem > seconds) return undefined
  const elapsed = seconds - rem
  if (elapsed < 0.01 * seconds) return undefined
  return Math.round(used - (elapsed * 100) / seconds) || 0
}

// ▼N with room to spare, ▲N spending fast, ● within the tolerance. Points, not
// a percent, so it does not read as a second use figure.
export function paceSegment(delta: number): Segment {
  if (delta < -PACE_TOLERANCE) return { text: `▼${-delta}`, tone: 'ahead' }
  if (delta > PACE_TOLERANCE) return { text: `▲${delta}`, tone: 'behind' }
  return { text: '●', tone: 'muted' }
}

// Color only once it matters: from 50% and from 80%.
export const levelOf = (percent: number): Tone => (percent >= 80 ? 'bad' : percent >= 50 ? 'warn' : 'plain')

const space: Segment = { text: ' ', tone: 'muted' }

const head = (label: string, percent: number): Segment[] => [
  { text: label, tone: 'label' },
  space,
  { text: `${Math.round(percent)}%`, tone: levelOf(percent) },
]

// One card: `level` is the percent's tone, which the card's border takes.
export type Item = { key: string; left: Segment[]; right: Segment[]; level: Tone }

export function items(usage: Usage, now: number): Item[] {
  const out: Item[] = []
  const { tokens, window, percent } = usage.context

  if (percent !== undefined) {
    const used = tokens ?? Math.round((percent * window) / 100)
    out.push({
      key: 'ctx',
      left: head('ctx', percent),
      right: window > 0 ? [{ text: `${formatTokens(used)} / ${formatTokens(window)}`, tone: 'muted' }] : [],
      level: levelOf(percent),
    })
  }

  for (const w of WINDOWS) {
    const limit = usage.rateLimits.find(r => r.kind === w.kind)
    if (limit === undefined) continue
    const left = head(w.label, limit.percentUsed)
    const right: Segment[] = []
    const resetsAt = limit.resetsAt === undefined ? NaN : Date.parse(limit.resetsAt)
    if (!Number.isNaN(resetsAt)) {
      const pace = paceOf(limit.percentUsed, resetsAt, w.seconds, now)
      if (pace !== undefined) left.push(space, paceSegment(pace))
      right.push({ text: formatReset(resetsAt, now), tone: 'muted' })
    }
    out.push({ key: w.label, left, right, level: levelOf(limit.percentUsed) })
  }

  return out
}

export const textOf = (parts: Segment[]): string => parts.map(s => s.text).join('')

// A card's text as one line: the left side, then the right one.
export const lineOf = (item: Item): Segment[] =>
  item.right.length === 0 ? item.left : [...item.left, { text: ' · ', tone: 'muted' }, ...item.right]

// The same items on one line, for a band too narrow or short for the cards.
export const segments = (usage: Usage, now: number): Segment[] =>
  items(usage, now).flatMap((item, i) =>
    i === 0 ? lineOf(item) : [{ text: '  │  ', tone: 'muted' } as Segment, ...lineOf(item)],
  )

// Columns between two cards; each card's border and padding together, and
// the least room kept between its two sides.
export const CARD_GAP = 1
const CARD_CHROME = 4
const SIDES_GAP = 2

// The width of each card across `columns`, or undefined when a card's two
// sides would not fit in it (or the band has under 3 rows).
export function cardWidth(shown: Item[], columns: number, rows: number): number | undefined {
  if (shown.length === 0 || rows < 3) return undefined
  const width = Math.floor((columns - CARD_GAP * (shown.length - 1)) / shown.length)
  const widest = Math.max(...shown.map(item => textOf(item.left).length + SIDES_GAP + textOf(item.right).length))
  return widest + CARD_CHROME <= width ? width : undefined
}

// Ivory and gray at rest, amber kraft from 50%, and the desktop diff's red
// (from 80%, spending fast) and green (a pace with room to spare). Each in a
// dark-theme and a light-theme shade, since raw colors do not follow the
// theme. `fill` is the card's background, a step above the band's.
export type Style = { color?: string; bold?: boolean }

const PALETTE = {
  dark: { kraft: '#F5B047', red: '#FF2B56', green: '#2FD84C', cloud: '#8F8D86', fill: '#2B2A28', text: '#E8E6DC' },
  light: { kraft: '#B86E00', red: '#CF222E', green: '#1A7F37', cloud: '#87867F', fill: '#F0EEE6', text: '#141413' },
}

const paletteOf = (isLight: boolean) => (isLight ? PALETTE.light : PALETTE.dark)

export const fillOf = (isLight: boolean): string => paletteOf(isLight).fill

// A card's border: the fill itself at rest, so it does not show, and the
// percent's color once it matters. Kept in every state so the cards never
// change height.
export function borderOf(level: Tone, isLight: boolean): string {
  const p = paletteOf(isLight)
  return level === 'bad' ? p.red : level === 'warn' ? p.kraft : p.fill
}

// Only the percent is bold: it is what the card is for.
export function styleOf(tone: Tone, isLight: boolean): Style {
  const p = paletteOf(isLight)
  switch (tone) {
    case 'label':
    case 'muted':
      return { color: p.cloud }
    case 'plain':
      return { bold: true }
    case 'warn':
      return { color: p.kraft, bold: true }
    case 'bad':
      return { color: p.red, bold: true }
    case 'behind':
      return { color: p.red }
    case 'ahead':
      return { color: p.green }
  }
}

// `/config`'s theme: `light`, `light-daltonized`, `light-ansi` and so on.
export const isLightTheme = (theme: unknown): boolean => typeof theme === 'string' && theme.startsWith('light')

// The desktop draws Text in its UI font and takes no font prop, so there each
// side is an SVG in the monospace the diff header uses. Its width is measured
// generously (13 px monospace advances about 7.8 px; a glyph the font lacks,
// such as ▼ or │, falls back wider) and the Svg gets no width prop, so a side
// wider than its room scales down to fit instead of being cut.
const SVG_FONT = "'SF Mono', SFMono-Regular, Menlo, Consolas, monospace"
const SVG_SIZE = 13
const SVG_ADVANCE = 8.4
const SVG_WIDE = new Set(['▼', '▲', '●', '│'])
const SVG_WIDE_ADVANCE = 14
const SVG_PAD = 4
const SVG_HEIGHT = 18

const escapeXml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export const svgWidth = (text: string): number =>
  Math.ceil([...text].reduce((sum, ch) => sum + (SVG_WIDE.has(ch) ? SVG_WIDE_ADVANCE : SVG_ADVANCE), 0)) + SVG_PAD

export function svgLine(parts: Segment[], isLight: boolean): { source: string } {
  const width = svgWidth(textOf(parts))
  const spans = parts
    .map(part => {
      const style = styleOf(part.tone, isLight)
      const fill = style.color ?? paletteOf(isLight).text
      const weight = style.bold ? ' font-weight="600"' : ''

      return `<tspan fill="${fill}"${weight}>${escapeXml(part.text)}</tspan>`
    })
    .join('')
  const source =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${SVG_HEIGHT}" viewBox="0 0 ${width} ${SVG_HEIGHT}">` +
    `<text x="1" y="13" font-family="${SVG_FONT}" font-size="${SVG_SIZE}" xml:space="preserve">${spans}</text></svg>`

  return { source }
}
