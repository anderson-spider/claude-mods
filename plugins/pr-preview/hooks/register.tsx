import { atom, read } from 'claude-code'
import type { Elements, EngineInterface, Register, RenderElement } from 'claude-code'

import type { PrPreviewHeld } from '../types'
import { classify, measure } from './guard'
import type { Probe } from './guard'

type Kit = Pick<Elements['terminal'], 'Box' | 'Text' | 'Button'>
type Decision = 'proceed' | 'fix' | 'cancel'
type Slot = { id: string; decision: Decision | null }

const TITLE = 'PR Preview'
// Waiting inside a `$` call does not use up the hook's time; `$.clock.sleep` would.
const POLL = ['sleep', '0.25']
// Border, title, Command, Would, the two blank lines, the 'and N more' and the buttons; the problems and notes are counted apart.
const CHROME_ROWS = 9
const MAX_LINES = 14

const ref = { plugin: 'pr-preview', key: 'held' } as const
const held = atom(ref, null)

// Reads of `$.state` in a dispatch see a single moment: the decision the hook
// is waiting for would not arrive that way, so it travels here and the state holds only the drawing.
let waiting: Slot | undefined

const probe = ($: EngineInterface): Probe => ({
  run: (argv, init) => $.process.run(argv, init),
  home: () => $.env.get('HOME'),
})

const decide = (decision: Decision) => {
  if (waiting?.decision === null) {
    waiting.decision = decision
  }
}

/** Holds the call until the person decides; never rejects, so the command cannot slip through on an error. */
const hold = async (
  $: EngineInterface,
  mine: PrPreviewHeld,
  signal: AbortSignal,
): Promise<Decision | 'aborted'> => {
  const slot: Slot = { id: mine.id, decision: null }

  try {
    // One held call at a time: the second waits for the first to be decided.
    while (waiting !== undefined) {
      if (signal.aborted) {
        return 'aborted'
      }

      await $.process.run(POLL)
    }

    waiting = slot
    await $.state.set(ref, mine)

    while (slot.decision === null && !signal.aborted) {
      await $.process.run(POLL)
    }

    return slot.decision ?? 'aborted'
  } catch {
    return 'aborted'
  } finally {
    if (waiting === slot) {
      waiting = undefined
      await $.state.set(ref, null).catch(() => undefined)
    }
  }
}

const draw = ({ Box, Text, Button }: Kit, now: PrPreviewHeld, room: number): RenderElement => {
  const { report } = now
  const shown = report.lines.slice(0, Math.max(0, room))
  const hidden = report.total - shown.length

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="warning" paddingX={1}>
      <Text bold color="warning">
        ⚠ {TITLE} · {report.title}
      </Text>
      <Box>
        <Text dimColor>{'Command  '}</Text>
        <Text bold wrap="truncate-end">
          {now.command.replace(/\s*\n\s*/g, ' ')}
        </Text>
      </Box>
      <Box>
        <Text dimColor>{'Would    '}</Text>
        <Text bold color={report.problems.length > 0 ? 'error' : 'warning'}>
          {report.summary}
        </Text>
      </Box>
      <Box flexDirection="column" marginTop={1} paddingLeft={2}>
        {shown.map(line => (
          <Text wrap="truncate-end">{line}</Text>
        ))}
        {hidden > 0 && <Text dimColor>{`… and ${hidden} more`}</Text>}
      </Box>
      {report.problems.map(problem => (
        <Text color="error" wrap="truncate-end">
          {`✗ ${problem}`}
        </Text>
      ))}
      {report.notes.map(note => (
        <Text dimColor italic wrap="truncate-end">
          {note}
        </Text>
      ))}
      <Box marginTop={1} gap={2}>
        <Button key="proceed" label="Proceed" hotkey="1" plain onPress={() => decide('proceed')} />
        {report.problems.length > 0 && <Button key="fix" label="Fix" hotkey="2" plain onPress={() => decide('fix')} />}
        <Button key="cancel" label="Cancel" hotkey="3" plain autoFocus onPress={() => decide('cancel')} />
        <Text dimColor>Claude is waiting for your answer</Text>
      </Box>
    </Box>
  )
}

export const register: Register = on => {
  // A reload in the middle of a wait would leave the value stuck and hold everything after it.
  on('session.start', async ($, e, next) => {
    waiting = undefined
    await $.state.set(ref, null)

    return next(e)
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const found = classify(e.command)

    if (found.length === 0) {
      return next(e)
    }

    const cwd = await $.session.cwd()
    const { report, advice } = await measure(probe($), found, cwd)
    const outcome = await hold(
      $,
      { id: e.tool_use_id, command: e.command, report },
      next.signal,
    )

    if (outcome === 'proceed') {
      return next(e)
    }

    return {
      deny:
        outcome === 'fix'
          ? `PR Preview held this command: the person asked for a fix before it runs. It would ${report.summary}. ${advice} Rerun the command once it follows the conventions.`
          : outcome === 'cancel'
            ? `PR Preview held this command: the person pressed Cancel. It would ${report.summary}.`
            : `PR Preview held this command and the wait was interrupted before a decision. It would ${report.summary}.`,
    }
  })

  // The report goes in the band above the prompt, at any width.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const now = await read($, held)

    if (now === null || e.props.hasSurvey) {
      return next(e)
    }

    return draw($.ui.resolve(e), now, Math.min(MAX_LINES, e.props.maxRows - CHROME_ROWS - now.report.problems.length - now.report.notes.length))
  })
}
