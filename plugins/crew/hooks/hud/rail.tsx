// A connector between two cards, drawn on the surface's frame clock (UI spec 8): packets travel along it while `active`,
// one cell every RAIL_STEP_MS; a still rail is a faint line. Only this region redraws. The runs are `railRuns`, the
// function the tests measure.
import type { ClientModule } from 'claude-code'

import { RAIL_STEP_MS, railRuns, type RailProps } from './live'

type Ref = { phase: number; active: boolean }
type State = { ref: Ref }

const Rail: ClientModule<RailProps, State> = (props, surface) => {
  const { Box, Text } = surface.elements
  const ref = surface.state?.ref ?? { phase: 0, active: props.active }
  ref.active = props.active
  if (surface.state === undefined) {
    surface.setState({ ref })
    surface.every(RAIL_STEP_MS, () => {
      if (ref.active) {
        ref.phase += 1
        surface.setState({ ref })
      }
    })
  }
  const width = Math.max(1, props.width)
  return (
    <Box>
      {railRuns(width, ref.active ? ref.phase : null).map(run => (
        <Text color={run.isLit ? props.color : props.faint} bold={run.isLit}>
          {run.text}
        </Text>
      ))}
    </Box>
  )
}

export default Rail
