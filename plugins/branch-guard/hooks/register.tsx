import { atom, read } from 'claude-code'
import type { Elements, EngineInterface, Register, RenderElement } from 'claude-code'

import type { BranchGuardHeld, BranchGuardReport } from '../types'
import { classify } from './classify'
import type { Risk } from './classify'
import { isProtectedTarget, measure } from './measure'
import type { Probe } from './measure'

type Kit = Pick<Elements['terminal'], 'Box' | 'Text' | 'Button'>
type Decision = 'proceed' | 'cancel'
type Outcome = Decision | 'aborted'
type Slot = { id: string; decision: Decision | null }
/** The call being held, if any; the others wait for it to be decided. */
type Queue = { current: Slot | undefined }

const TITLE = 'Branch Guard'
// Waiting inside a `$` call does not use up the hook's time; `$.clock.sleep` would.
const POLL = ['sleep', '0.25']
// Border, title, Command, Would, the two blank lines, the footer, the 'and N more' and the buttons.
// Keep it in step with the band's layout. The band's English strings (Command, Would, Proceed, Cancel,
// '… and N more') are asserted by tests/register.test.ts: change both together.
const CHROME_ROWS = 10
const MAX_LINES = 8

const ref = { plugin: 'branch-guard', key: 'held' } as const
const held = atom(ref, null)

// Reads of `$.state` in a dispatch see a single moment: the decision the hook
// is waiting for would not arrive that way, so it travels here and the state holds only the drawing.
const queue: Queue = { current: undefined }

const probe = ($: EngineInterface): Probe => ({
  run: (argv, init) => $.process.run(argv, init),
  home: () => $.env.get('HOME'),
  real: path =>
    $.fs.stat(path, { resolve: true }).then(
      stat => stat.realPath,
      () => undefined,
    ),
})

const decide = (line: Queue, decision: Decision) => {
  if (line.current?.decision === null) {
    line.current.decision = decision
  }
}

/** Holds the call until the person decides; never rejects, so the command cannot slip through on an error. */
const hold = async (
  $: EngineInterface,
  line: Queue,
  mine: BranchGuardHeld,
  signal: AbortSignal,
): Promise<Outcome> => {
  const slot: Slot = { id: mine.id, decision: null }

  try {
    // One held call at a time: the second waits for the first to be decided.
    while (line.current !== undefined) {
      if (signal.aborted) {
        return 'aborted'
      }

      await $.process.run(POLL)
    }

    line.current = slot
    await $.state.set(ref, mine)

    while (slot.decision === null && !signal.aborted) {
      await $.process.run(POLL)
    }

    return slot.decision ?? 'aborted'
  } catch {
    return 'aborted'
  } finally {
    if (line.current === slot) {
      line.current = undefined
      await $.state.set(ref, null).catch(() => undefined)
    }
  }
}

const BRANCH = 'Open a working branch with `git switch -c <name>` (keeps your changes and commits), follow the project naming convention and rerun the command on it.'
const REVIEW = 'Pushing to the protected branch from another branch is a PR case: open one instead of pushing directly.'

const advise = (risks: readonly Risk[]) =>
  risks.some(risk => risk.kind === 'publish' && risk.refspecs.some(spec => spec.includes(':'))) ? REVIEW : BRANCH

// Only the protected branch asks; everything else, and any repository in a temp directory, passes. One at a time, in order.
const screen = async (host: Probe, found: readonly Risk[], cwd: string) => {
  const risks: Risk[] = []

  for (const risk of found) {
    if (await isProtectedTarget(host, risk, cwd)) {
      risks.push(risk)
    }
  }

  return risks
}

// What Claude is told when the call is not let through.
const denyFor = (outcome: Exclude<Outcome, 'proceed'>, report: BranchGuardReport, risks: readonly Risk[]) =>
  outcome === 'cancel'
    ? `Branch Guard held this command: the person pressed Cancel. It would ${report.summary}. ${advise(risks)}`
    : `Branch Guard held this command and the wait was interrupted before a decision. It would ${report.summary}.`

const draw = ({ Box, Text, Button }: Kit, now: BranchGuardHeld, room: number, line: Queue): RenderElement => {
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
        <Text bold color="error">
          {report.summary}
        </Text>
      </Box>
      <Box flexDirection="column" marginTop={1} paddingLeft={2}>
        {shown.map(line => (
          <Text wrap="truncate-end">{line}</Text>
        ))}
        {hidden > 0 && <Text dimColor>{`… and ${hidden} more`}</Text>}
      </Box>
      {report.notes.map(note => (
        <Text dimColor italic wrap="truncate-end">
          {note}
        </Text>
      ))}
      <Box marginTop={1} gap={2}>
        <Button key="proceed" label="Proceed" hotkey="1" plain onPress={() => decide(line, 'proceed')} />
        <Button key="cancel" label="Cancel" hotkey="2" plain autoFocus onPress={() => decide(line, 'cancel')} />
        <Text dimColor>Claude is waiting for your answer</Text>
      </Box>
    </Box>
  )
}

export const register: Register = on => {
  // A reload in the middle of a wait would leave the value stuck and hold everything after it.
  on('session.start', async ($, e, next) => {
    queue.current = undefined
    await $.state.set(ref, null)

    return next(e)
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const found = classify(e.command)

    if (found.length === 0) {
      return next(e)
    }

    const host = probe($)
    const cwd = await $.session.cwd()
    const risks = await screen(host, found, cwd)

    if (risks.length === 0) {
      return next(e)
    }

    const report = await measure(host, risks, cwd)
    const outcome = await hold(
      $,
      queue,
      { id: e.tool_use_id, command: e.command, report },
      next.signal,
    )

    if (outcome === 'proceed') {
      return next(e)
    }

    return { deny: denyFor(outcome, report, risks) }
  })

  // The report goes in the band above the prompt, at any width.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const now = await read($, held)

    if (now === null || e.props.hasSurvey) {
      return next(e)
    }

    return draw($.ui.resolve(e), now, Math.min(MAX_LINES, e.props.maxRows - CHROME_ROWS), queue)
  })
}
