// The terminal mascot: rows of half-block runs, animated on the surface frame clock only while working.
import type { ClientModule } from 'claude-code'
import { clawdRuns, FRAMES } from './clawd.ts'
import type { Mood } from './clawd.ts'
import type { SlotName } from './roster'

export type MascotProps = {
  role: SlotName
  mood: Mood
  size: 'small' | 'large'
}

type Ref = { frame: number; mood: Mood }
type State = { ref: Ref }

export function frameAfter(frame: number, mood: Mood): number {
  return mood === 'work' ? (frame + 1) % FRAMES : frame
}

const Mascot: ClientModule<MascotProps, State> = (props, surface) => {
  const { Box, Text } = surface.elements
  const ref = surface.state?.ref ?? { frame: 0, mood: props.mood }
  ref.mood = props.mood
  if (surface.state === undefined) {
    surface.setState({ ref })
    // One timer for the module's life; it redraws only while the mood is work.
    surface.every(250, () => {
      if (ref.mood === 'work') {
        ref.frame = frameAfter(ref.frame, ref.mood)
        surface.setState({ ref })
      }
    })
  }
  const rows = clawdRuns(props.role, props.mood, ref.frame, props.size)
  return (
    <Box flexDirection="column">
      {rows.map(row => (
        <Box flexDirection="row">
          {row.map(run => (
            <Text color={run.fg} backgroundColor={run.bg}>{run.text}</Text>
          ))}
        </Box>
      ))}
    </Box>
  )
}

export default Mascot
