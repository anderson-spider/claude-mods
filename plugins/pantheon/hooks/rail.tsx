// Ported from scasella/claude-flightdeck 0.3.2 (MIT); see NOTICE.
// Packets travel on the surface's frame clock; only this region redraws.
import type { ClientModule } from 'claude-code'

export type RailProps = {
  active: boolean
  width: number
  color: string
  dim: string
  marks: number[]
  isMerge: boolean
  vertical?: boolean
  glyph?: { on: string; off: string }
  // Both default to true. Without the line only the glyph is drawn, with no 110 ms timer;
  // without the pulse the glyph stays steady, with no 600 ms timer.
  isLine?: boolean
  isPulse?: boolean
}

type Ref = { phase: number; tick: number; active: boolean }
type State = { ref: Ref }

// A negative phase is the resting line, with no packets.
export function railCells(width: number, phase: number, marks: number[], isMerge: boolean): { text: string; isLit: boolean }[] {
  const cells = Array.from({ length: width }, () => ({ text: '─', isLit: false }))
  for (const m of marks) if (m >= 0 && m < width) cells[m].text = isMerge ? '┴' : '┬'
  if (phase < 0) return cells

  for (let base = 0; base < width + 24; base += 24) {
    const head = (base + phase) % (width + 24)
    if (head < width) cells[head] = { text: '●', isLit: true }
    if (head - 1 >= 0 && head - 1 < width) cells[head - 1] = { text: '•', isLit: true }
  }
  return cells
}

export function pulseOn(tick: number): boolean {
  return tick % 2 === 0
}

const Rail: ClientModule<RailProps, State> = (props, surface) => {
  const { Box, Text } = surface.elements
  const ref = surface.state?.ref ?? { phase: 0, tick: 0, active: props.active }
  ref.active = props.active
  if (surface.state === undefined) {
    surface.setState({ ref })
    if (props.isLine !== false) {
      surface.every(110, () => {
        if (ref.active) {
          ref.phase += 1
          surface.setState({ ref })
        }
      })
    }
    if (props.isPulse !== false) {
      surface.every(600, () => {
        if (ref.active) {
          ref.tick += 1
          surface.setState({ ref })
        }
      })
    }
  }

  // The region's columns hold the glyph cell too: the line takes what is left, so a fixed region stays fixed.
  const glyphCells = props.glyph && !props.vertical ? 1 : 0
  const width = Math.max(1, props.vertical ? props.width : surface.columns ? surface.columns - glyphCells : props.width)
  const cells = props.isLine === false ? [] : railCells(width, props.active ? ref.phase : -1, props.marks, props.isMerge)
  // Horizontal runs share a Text; vertical cells each take one row.
  const runs: { text: string; isLit: boolean }[] = []
  for (const cell of cells) {
    const text = props.vertical && cell.text === '─' ? '│' : cell.text
    const last = runs[runs.length - 1]
    if (!props.vertical && last && last.isLit === cell.isLit) last.text += text
    else runs.push({ text, isLit: cell.isLit })
  }
  return (
    <Box flexDirection={props.vertical ? 'column' : 'row'}>
      {props.glyph && (
        <Text color={props.color} bold={props.active && props.isPulse !== false && pulseOn(ref.tick)}>
          {props.active ? props.glyph.on : props.glyph.off}
        </Text>
      )}
      {runs.map(r => (
        <Text color={r.isLit ? props.color : props.dim} bold={r.isLit}>
          {r.text}
        </Text>
      ))}
    </Box>
  )
}

export default Rail
