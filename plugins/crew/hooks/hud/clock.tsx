// A clock that ticks on the surface's frame clock, so the pane need not redraw each second (UI spec 8). The drawing hands
// it the time it drew at; between redraws it adds its own ticks. The text is `elapsedCell`, the function the tests measure.
import type { ClientModule } from 'claude-code'

import { elapsedCell, type ElapsedProps } from './live'

type Ref = { lastNow: number; ticks: number; isRunning: boolean }
type State = { ref: Ref }

const Clock: ClientModule<ElapsedProps, State> = (props, surface) => {
  const { Text } = surface.elements
  const ref = surface.state?.ref ?? { lastNow: props.now, ticks: 0, isRunning: props.endAt === null }
  if (props.now !== ref.lastNow) {
    // A fresh drawing: count again from its time.
    ref.lastNow = props.now
    ref.ticks = 0
  }
  ref.isRunning = props.endAt === null
  if (surface.state === undefined) {
    surface.setState({ ref })
    surface.every(1000, () => {
      if (ref.isRunning) {
        ref.ticks += 1
        surface.setState({ ref })
      }
    })
  }
  return (
    <Text color={props.color} dimColor={props.dimColor} bold={props.bold} wrap="truncate">
      {elapsedCell(props, ref.ticks)}
    </Text>
  )
}

export default Clock
