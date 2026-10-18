// The tree rows' surface module: paints the segments register.tsx laid out and hands keys and clicks back to it.
// It keeps no tree state of its own, so a redraw from the hooks module is always the truth.
import type { ClientModule } from 'claude-code'
import type { Segment } from './view'

export type RowsProps = { lines: Segment[][] }

const Rows: ClientModule<RowsProps, true> = (props, surface) => {
  const { Box, Text } = surface.elements
  if (surface.state === undefined) {
    surface.onKey(key => surface.post({ key: key.key, ...(key.ctrl ? { ctrl: true } : {}), ...(key.shift ? { shift: true } : {}), ...(key.meta ? { meta: true } : {}) }))
    surface.onPointer(event => {
      if (event.type === 'down' && event.button === 'left') surface.post({ click: event.y })
    })
    surface.setState(true)
  }
  return (
    <Box flexDirection="column">
      {props.lines.map(line => (
        <Text wrap="truncate-end">
          {line.map(one => (
            <Text color={one.c} bold={one.b} dimColor={one.d} inverse={one.i}>{one.t}</Text>
          ))}
        </Text>
      ))}
    </Box>
  )
}

export default Rows
