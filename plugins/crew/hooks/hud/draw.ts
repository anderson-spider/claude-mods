// The HUD's drawing: elements built from the lines compose.ts lays out, over constructors the caller injects. H3 passes
// the surface's table from `$.ui.resolve(e)` and wraps its client modules (`<Client module="./clock.tsx">`, the rail) as
// `Clock` and `Rail`; tests pass fakes that record the tree. No hooks, no `$`, no host import at run time.
import {
  bandShows,
  desktopHeight,
  paneLayout,
  paneRows,
  summaryLines,
  type PaneLayout,
  type PaneOptions,
  type PaneRow,
  type PanelChoice,
  type SummaryForm,
} from './compose'
import { fitLine, lineWidth, type Line, type SectionId, type Span } from './line'
import type { ElapsedProps, RailProps } from './live'
import { paint, paletteOf, type ColorsOption, type Paint, type Palette } from './palette'
import { SECTION_NAME, type CardModel, type HudContext, type HudInput } from './sections'
import { timelineSvg } from './svg'
import { truncate } from './width'

/** What an element may hold: the host's `RenderChildren` with its element type `E`. */
export type Kids<E> = E | string | number | boolean | null | undefined | readonly Kids<E>[]

/** The Text props the HUD sets (a subset of the host's `TextProps`). */
export type TextAttrs = Paint & { wrap?: 'truncate' }

/** The Box props the HUD sets (a subset of the host's `BoxProps`). */
export type BoxAttrs = {
  key?: string
  flexDirection?: 'row' | 'column'
  width?: number
  columnGap?: number
  borderStyle?: string
  borderColor?: string
  paddingX?: number
  marginTop?: number
  marginBottom?: number
}

/**
 * The element constructors the drawing uses. `Box` and `Text` come from every surface's table; `Svg` from the desktop's
 * (absent on the terminal, so the timeline stays text); `Button` makes the agent rows pressable when the pane is focused;
 * `Clock` and `Rail` are the caller's client-module regions (absent: the static text is drawn, which is what the
 * clock's and rail's own functions in live.ts draw at tick 0).
 */
export type HudEls<E> = {
  Box: (props: BoxAttrs & { children?: Kids<E> }) => E
  Text: (props: TextAttrs & { children?: Kids<E> }) => E
  Svg?: (props: { source: string; alt: string; width?: number; height?: number }) => E
  Button?: (props: { key: string; plain: true; hotkey?: string; onPress: () => void; children?: Kids<E> }) => E
  Clock?: (o: { key: string; width: number; props: ElapsedProps }) => E
  Rail?: (o: { key: string; width: number; props: RailProps }) => E
}

export type DrawOptions = {
  colors: ColorsOption
  /** The host says the theme is light (the `roles` table then uses its light column). */
  light?: boolean
  /** `motion: while-active`: rails animate while their card is live (the clocks tick either way). */
  motion: boolean
}

const samePaint = (a: Paint, b: Paint) =>
  a.color === b.color && !!a.dimColor === !!b.dimColor && !!a.bold === !!b.bold && !!a.inverse === !!b.inverse

/** Adjacent spans of one paint become one Text. */
function textKids<E>(els: HudEls<E>, spans: readonly Span[], P: Palette, card?: SectionId): E[] {
  const runs: { paint: Paint; text: string }[] = []
  for (const s of spans) {
    const p = paint(s, P, card)
    const last = runs[runs.length - 1]
    if (last && samePaint(last.paint, p)) last.text += s.text
    else runs.push({ paint: p, text: s.text })
  }
  return runs.map(r => els.Text({ ...r.paint, children: r.text }))
}

/** One line: a truncating Text of styled runs, or a row Box when it holds a clock the caller can tick. */
export function drawLine<E>(els: HudEls<E>, line: Line, P: Palette, card?: SectionId): E {
  const clock = els.Clock
  if (!clock || !line.some(s => s.live)) return els.Text({ wrap: 'truncate', children: textKids(els, line, P, card) })
  const kids: E[] = []
  let run: Span[] = []
  const flush = () => {
    if (run.length > 0) kids.push(els.Text({ wrap: 'truncate', children: textKids(els, run, P, card) }))
    run = []
  }
  for (const s of line) {
    if (!s.live) {
      run.push(s)
      continue
    }
    flush()
    const { key, since, now, endAt, width, align } = s.live
    kids.push(clock({ key, width, props: { since, now, endAt, width, align, ...paint(s, P, card) } }))
  }
  flush()
  return els.Box({ flexDirection: 'row', width: lineWidth(line), children: kids })
}

export type PaneDrawOptions = PaneOptions &
  DrawOptions & {
    /** Opens an agent's details (its row's hotkey); with `Button`, the focused pane's agent rows are pressable. */
    onOpen?: (agentId: string) => void
  }

/**
 * A pressable row: the host's plain Button draws `1: ` and then its children, so the Button takes the content after the
 * row's reserved `1: ` cells (the `pressPrefix` span) and the frame stays outside it: `tail` spans at the end (the
 * terminal's ` │`) are drawn after the Button. A Button holds strings and Text only, so its clock is drawn static.
 */
function pressable<E>(els: HudEls<E>, line: Line, P: Palette, card: SectionId | undefined, press: { id: string; hotkey: string }, o: PaneDrawOptions, tail: number): E | null {
  const { Button } = els
  const onOpen = o.onOpen
  const at = line.findIndex(s => s.pressPrefix)
  if (!Button || !onOpen || at < 0) return null
  const end = Math.max(at + 1, line.length - tail)
  const button = Button({
    key: `agent-${press.id}`,
    plain: true,
    hotkey: press.hotkey,
    onPress: () => onOpen(press.id),
    children: textKids(els, line.slice(at + 1, end), P, card),
  })
  const before = line.slice(0, at)
  const after = line.slice(end)
  return els.Box({
    flexDirection: 'row',
    width: lineWidth(line),
    children: [...(before.length ? [els.Text({ children: textKids(els, before, P, card) })] : []), button, ...(after.length ? [els.Text({ children: textKids(els, after, P, card) })] : [])],
  })
}

function terminalRow<E>(els: HudEls<E>, row: PaneRow, W: number, P: Palette, o: PaneDrawOptions): E {
  if (row.rail) {
    const { Rail } = els
    if (o.motion && row.rail.isLive && Rail && W > 4) {
      const width = W - 4
      return els.Box({
        flexDirection: 'row',
        width: W,
        children: [
          els.Text({ children: '  ' }),
          Rail({ key: `rail-${row.rail.section}`, width, props: { active: true, width, color: P.section[row.rail.section], faint: P.faint } }),
          els.Text({ children: '  ' }),
        ],
      })
    }
    return drawLine(els, row.spans, P, row.card)
  }
  if (row.press) {
    const button = pressable(els, row.spans, P, row.card, row.press, o, 1)
    if (button !== null) return button
  }
  return drawLine(els, row.spans, P, row.card)
}

function desktopCard<E>(els: HudEls<E>, c: CardModel, width: number, P: Palette, o: PaneDrawOptions, isFirst: boolean): E {
  const cw = Math.max(0, width - 4)
  const press = new Map((c.press ?? []).map(p => [p.row, p]))
  const body =
    c.id === 'timeline' && els.Svg && c.lanes
      ? [els.Svg(timelineSvg(c.lanes, cw))]
      : c.rows.map((row, i) => {
          const line = fitLine(row, cw)
          const p = press.get(i)
          return (p && pressable(els, line, P, c.id, p, o, 0)) || drawLine(els, line, P, c.id)
        })
  return els.Box({
    flexDirection: 'column',
    borderStyle: 'round',
    borderColor: P.section[c.id],
    paddingX: 1,
    width,
    ...(isFirst ? {} : { marginTop: 1 }),
    children: [els.Text({ bold: true, color: P.section[c.id], wrap: 'truncate', children: truncate(c.title, cw) }), ...body],
  })
}

function desktopPane<E>(els: HudEls<E>, L: PaneLayout, P: Palette, o: PaneDrawOptions): E {
  const W = L.width
  const top: E[] = []
  if (L.header) top.push(els.Box({ flexDirection: 'column', width: W, marginBottom: 1, children: [drawLine(els, L.header, P)] }))
  if (L.waiting) top.push(drawLine(els, L.waiting, P))
  const column = (cards: readonly CardModel[], width: number) =>
    els.Box({ flexDirection: 'column', width, children: cards.map((c, i) => desktopCard(els, c, width, P, o, i === 0)) })
  let middle: E[]
  if (L.split) {
    const split = L.split
    const pick = (ids: readonly SectionId[]) => L.cards.filter(c => ids.includes(c.id))
    const log = L.cards.find(c => c.id === 'log')
    middle = [
      els.Box({ flexDirection: 'row', width: W, columnGap: W - 2 * split.width, children: [column(pick(split.left), split.width), column(pick(split.right), split.width)] }),
      ...(log ? [desktopCard(els, log, W, P, o, false)] : []),
    ]
  } else middle = L.cards.map((c, i) => desktopCard(els, c, W, P, o, i === 0))
  const legend = L.legend ? [drawLine(els, L.legend, P)] : []
  return els.Box({ flexDirection: 'column', width: W, children: [...top, ...middle, ...legend] })
}

export type PaneDrawing<E> = {
  tree: E
  /** The degradation level drawn (0 fullest, 7 cut). */
  level: number
  /** Rows drawn (the terminal's lines, the desktop's estimated rows). */
  height: number
  /** Sections that threw and were drawn as one red row: the caller logs them. */
  errors: SectionId[]
}

/** The docked pane: full form (UI spec 4 on the terminal, 5 on the desktop), at the level its rows allow. */
export function drawPane<E>(els: HudEls<E>, input: HudInput, ctx: HudContext, o: PaneDrawOptions): PaneDrawing<E> {
  const P = paletteOf(o.colors, o.light)
  try {
    if (o.surface === 'desktop') {
      const L = paneLayout(input, ctx, o)
      return { tree: desktopPane(els, L, P, o), level: L.level, height: desktopHeight(L), errors: L.errors }
    }
    const { layout, rows } = paneRows(input, ctx, o)
    const tree = els.Box({ flexDirection: 'column', width: o.width, children: rows.map(row => terminalRow(els, row, o.width, P, o)) })
    return { tree, level: layout.level, height: rows.length, errors: layout.errors }
  } catch {
    // Last resort: no input reaches the host as a throw; the pane says so in one red row.
    const line = fitLine([{ text: `${SECTION_NAME.session} could not be drawn; see the debug log.`, tone: 'bad' }], Math.max(0, Math.floor(o.width)))
    return { tree: els.Box({ flexDirection: 'column', width: o.width, children: [drawLine(els, line, P)] }), level: 0, height: 1, errors: ['session'] }
  }
}

export type SummaryDrawOptions = DrawOptions & { width: number; form: SummaryForm; maxRows: number; docked?: boolean }

function summaryTree<E>(els: HudEls<E>, input: HudInput, ctx: HudContext, o: SummaryDrawOptions): E {
  const P = paletteOf(o.colors, o.light)
  const lines = summaryLines(input, ctx, o)
  return els.Box({ flexDirection: 'column', width: o.width, children: lines.map(line => drawLine(els, line, P)) })
}

/** The summary (UI spec 6): the inline pane under layout `mini` and the band's body; no rails, the clocks tick. */
export function drawSummary<E>(els: HudEls<E>, input: HudInput, ctx: HudContext, o: SummaryDrawOptions): E {
  try {
    return summaryTree(els, input, ctx, o)
  } catch {
    // Last resort: an empty column rather than a throw.
    return els.Box({ flexDirection: 'column', width: o.width, children: [] })
  }
}

export type BandDrawOptions = DrawOptions & {
  surface: string
  hasSurvey: boolean
  /** The session's panel choice; null before `session.start` set it. */
  choice: PanelChoice | null
  /** The band's `maxRows` and `bodyColumns`. */
  maxRows: number
  bodyColumns: number
}

/**
 * The band above the prompt, sized to `bodyColumns`, or null when it yields: another surface than the terminal or
 * desktop, a survey up, the panel hidden or at `side`, or a drawing that failed. The caller still draws it only over
 * the engine's own empty band.
 */
export function drawBand<E>(els: HudEls<E>, input: HudInput, ctx: HudContext, o: BandDrawOptions): E | null {
  try {
    if (!bandShows(o)) return null
    return summaryTree(els, input, ctx, { ...o, form: 'band', width: Math.max(0, Math.floor(o.bodyColumns)) })
  } catch {
    return null
  }
}
