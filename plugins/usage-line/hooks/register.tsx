import type { Register } from 'claude-code'

import {
  CARD_GAP,
  borderOf,
  cardWidth,
  fillOf,
  isLightTheme,
  items,
  segments,
  styleOf,
  svgLine,
  textOf,
  type Segment,
} from './usage'

// The reset countdown and the pace move with the clock, not only with usage;
// the tick also picks up a theme change.
const TICK_MS = 30_000

export const register: Register = on => {
  let isTicking = false

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    // An early build pinned the usage as a status line, which the host keeps
    // until cleared; the band replaces it.
    $.ui.status(undefined)
    if (!isTicking) {
      isTicking = true
      $.clock.every(TICK_MS, () => $.ui.invalidate('ui.render'))
    }

    return result
  })

  on('session.measure', async ($, e, next) => {
    $.ui.invalidate('ui.render')

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // Another plugin's band (a held command, a PR preview) or a survey wins.
    const below = await next(e)
    if (below.type !== 'engine' || e.props.hasSurvey) {
      return below
    }

    const [usage, now, config] = await Promise.all([$.session.usage(), $.clock.now(), $.config.list().catch(() => [])])
    const shown = items(usage, now)
    if (shown.length === 0) {
      return below
    }

    const isLight = isLightTheme(config.find(row => row.key === 'theme')?.value)
    const { Box, Text } = $.ui.resolve(e)
    const line = (parts: Segment[]) => {
      // The desktop's UI font is not the diff's monospace: draw the text as one.
      if (e.surface === 'desktop') {
        const { Svg } = $.ui.resolve(e)

        return <Svg {...svgLine(parts, isLight)} alt={textOf(parts)} />
      }

      return (
        <Text wrap="truncate-end">
          {parts.map(part => (
            <Text {...styleOf(part.tone, isLight)}>{part.text}</Text>
          ))}
        </Text>
      )
    }
    const width = cardWidth(shown, e.props.bodyColumns, e.props.maxRows)

    if (width === undefined) {
      return <Box paddingX={1}>{line(segments(usage, now))}</Box>
    }

    return (
      <Box flexDirection="row" columnGap={CARD_GAP}>
        {shown.map(item => (
          <Box
            key={item.key}
            width={width}
            justifyContent="space-between"
            borderStyle="round"
            borderColor={borderOf(item.level, isLight)}
            backgroundColor={fillOf(isLight)}
            paddingX={1}
          >
            {line(item.left)}
            {item.right.length > 0 ? line(item.right) : null}
          </Box>
        ))}
      </Box>
    )
  })
}
