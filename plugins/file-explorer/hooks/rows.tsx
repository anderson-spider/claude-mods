// The tree rows' surface module: paints the segments register.tsx laid out and hands keys and clicks back to it.
// It keeps no tree state of its own, so a redraw from the hooks module is always the truth. The one thing it animates
// itself is the shimmer of a file Claude is writing, on the surface's frame clock, so no hook runs per frame.
import type { ClientModule } from 'claude-code'
import type { Segment } from './view'

export type RowsProps = { lines: Segment[][] }

/** A shimmer frame lasts this long, and the light moves this many cells a frame. */
const FRAME_MS = 90
const SPEED = 1.6
/** Cells of dark on each side of the name the light runs through before it starts again. */
const GAP = 4

type Live = { phase: number; isShimmering: boolean }

const Rows: ClientModule<RowsProps, { live: Live }> = (props, surface) => {
  const { Box, Text } = surface.elements
  let live = surface.state?.live
  if (live === undefined) {
    const fresh: Live = { phase: 0, isShimmering: false }
    live = fresh
    surface.onKey(key => surface.post({ key: key.key, ...(key.ctrl ? { ctrl: true } : {}), ...(key.shift ? { shift: true } : {}), ...(key.meta ? { meta: true } : {}) }))
    surface.onPointer(event => {
      if (event.type === 'down' && event.button === 'left') surface.post({ click: event.y })
    })
    // Ticks cost nothing while no row shimmers: the frame is drawn again only when one does.
    surface.every(FRAME_MS, () => {
      if (!fresh.isShimmering) return
      fresh.phase++
      surface.setState({ live: fresh })
    })
    surface.setState({ live: fresh })
  }
  live.isShimmering = props.lines.some(line => line.some(one => one.s))
  const phase = live.phase

  // The light: four steps from the rest of the name (0) to its centre (3), in the segment's colours where it has them,
  // else in its one colour from dim to bold.
  const shimmer = (one: Segment) => {
    const chars = [...one.t]
    const center = ((phase * SPEED) % (chars.length + 2 * GAP)) - GAP
    return chars.map((char, i) => {
      const d = Math.abs(i - center)
      const step = d < 0.8 ? 3 : d < 1.8 ? 2 : d < 2.8 ? 1 : 0
      const color = one.g?.[step] ?? one.c
      const bold = (one.g ? step === 3 : step >= 2) ? true : undefined
      const dim = !one.g && step === 0 ? true : undefined
      return <Text color={color} bold={bold} dimColor={dim} inverse={one.i}>{char}</Text>
    })
  }

  return (
    <Box flexDirection="column">
      {props.lines.map(line => (
        <Text wrap="truncate-end">
          {line.map(one => (one.s ? shimmer(one) : (
            <Text color={one.c} bold={one.b} dimColor={one.d} inverse={one.i}>{one.t}</Text>
          )))}
        </Text>
      ))}
    </Box>
  )
}

export default Rows
