import { atom, read, update } from 'claude-code'
import type { Elements, EngineInterface, Register, RenderElement } from 'claude-code'

import type { BandJob } from '../types'
import { herdrAvailable, herdrOf } from './herdr'
import { createBook } from './book'
import { createPaneLayout } from './pane-layout'
import { PROMPT } from './prompts'
import { allJobs, bandRows, blockedText, finishedText, loopFinishedText, orphanText, snapshot } from './presentation'
import { checkDoctor } from './doctor'
import { NOT_READY, failure, jobsTool, refusal, startJob, startLoop } from './tools'
import type { Job, Loop, LoopDeps } from './model'

type Kit = Pick<Elements['terminal'], 'Box' | 'Text'>

const TITLE = 'Codex Team'
// Border (2), title (1) and the 'and N more' line (1).
const CHROME_ROWS = 4

const jobsAtom = atom({ plugin: 'codex-team', key: 'jobs' } as const, [] as BandJob[])

// Jobs run long after the hook that started them returned, so the module keeps the
// book of this session; a reload starts it over. `$` is only ever passed on, never stored.
let book: ReturnType<typeof createBook> | undefined
let loops: Loop[] = []
let loopDeps: LoopDeps | undefined
let unavailable: string | undefined
let ticker: { cancel: () => void } | undefined

// The band draws what `$.state` holds; a one-second tick keeps the elapsed time moving while a job is active.
async function publish($: EngineInterface) {
  const jobs = snapshot(loops, book?.jobs() ?? [], Date.now)
  await update($, jobsAtom, () => jobs)
  if (jobs.length > 0 && !ticker) {
    ticker = $.clock.every(1000, () => void publish($))
  } else if (jobs.length === 0 && ticker) {
    ticker.cancel()
    ticker = undefined
  }
}

const notifier = ($: EngineInterface) => (event: 'blocked' | 'finished', job: Job) => {
  void publish($)
  if (event === 'blocked') {
    $.ui.toast(`Codex Team: ${job.agent} needs you in pane ${job.pane}`)
    void $.prompt.submit({ text: blockedText(job) }).catch(() => undefined)
    return
  }
  $.ui.toast(`Codex Team: ${job.agent} ${job.status}`)
  void $.prompt.submit({ text: finishedText(job) }).catch(() => undefined)
}

const loopNotifier = ($: EngineInterface) => (event: 'blocked' | 'finished', loop: Loop, job?: Job) => {
  void publish($)
  if (event === 'blocked' && job) {
    $.ui.toast(`Codex Team: loop-${loop.id} ${job.agent} needs you in pane ${job.pane}`)
    void $.prompt.submit({ text: blockedText(job, loop) }).catch(() => undefined)
    return
  }
  $.ui.toast(`Codex Team: loop-${loop.id} ${loop.status}`)
  void $.prompt.submit({ text: loopFinishedText(loop) }).catch(() => undefined)
}

const draw = ({ Box, Text }: Kit, jobs: BandJob[], room: number): RenderElement => {
  const { rows, hidden } = bandRows(jobs, room)

  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold>{TITLE}</Text>
      {rows.map(row => (
        <Text wrap="truncate-end" color={row.includes('← answer in the pane') ? 'warning' : undefined}>
          {row}
        </Text>
      ))}
      {hidden > 0 && <Text dimColor>{`… and ${hidden} more`}</Text>}
    </Box>
  )
}

async function doctor($: EngineInterface): Promise<string> {
  const run = (argv: string[]) => $.process.run(argv, { timeoutMs: 15_000 }).catch(() => undefined)
  const inside = (await $.env.get('HERDR_ENV')) === '1'
  return checkDoctor(run, inside)
}

export const register: Register = on => {
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)

    return { sections: [...composed.sections, { id: 'codex-team:lead', text: PROMPT, scope: 'session' as const }] }
  })

  on('session.start', async ($, e, next) => {
    ticker?.cancel()
    ticker = undefined
    book = undefined
    loops = []
    loopDeps = undefined
    await update($, jobsAtom, () => [])

    await $.tool.register({
      name: 'execute',
      description:
        'Delegates a well-bounded implementation task to a Codex agent running in its own Herdr pane (sandbox workspace-write, in the ' +
        'current directory; it never commits). Returns a job id at once; when Codex finishes, a message arrives with the report path. ' +
        'One execute runs at a time: the next ones wait in a queue. Write a self-contained task: the goal, the files, the constraints and how to check it.',
      inputSchema: {
        type: 'object',
        properties: {
          task: { type: 'string', description: 'The whole task, self-contained.' },
          files: { type: 'array', items: { type: 'string' }, description: 'Optional files or folders Codex should start from.' },
        },
        required: ['task'],
      },
    })
    await $.tool.register({
      name: 'review',
      description:
        'Has a Codex agent review code read-only in its own Herdr pane: the current uncommitted diff, or a branch or commit named in target. ' +
        'Returns a job id at once; when Codex finishes, a message arrives with the report path. Reviews run in parallel.',
      inputSchema: {
        type: 'object',
        properties: {
          target: { type: 'string', description: 'Optional branch, commit or range to review; absent, the current uncommitted diff.' },
          focus: { type: 'string', description: 'Optional concern to look at first (races, security, a module).' },
        },
      },
    })
    await $.tool.register({
      name: 'loop',
      description:
        'Runs dev then read-only QA rounds for a self-contained task, holding the execute queue across all rounds. Returns a loop id at once; ' +
        'one message arrives at the end with the verdict and report path. maxRounds defaults to 3. Use execute and review for manual control.',
      inputSchema: {
        type: 'object',
        properties: {
          task: { type: 'string', description: 'The whole task, self-contained.' },
          files: { type: 'array', items: { type: 'string' }, description: 'Optional files or folders Codex should start from.' },
          maxRounds: { type: 'integer', minimum: 1, default: 3, description: 'Maximum dev and QA rounds.' },
        },
        required: ['task'],
      },
    })
    await $.tool.register({
      name: 'jobs',
      description:
        'Lists the Codex jobs and loops of this session (status, pane, report path), reads one by id, or cancels one with action: "cancel". ' +
        'A cancel sends Esc to its active Codex. Standalone panes stay open; a cancelled loop starts no further rounds and closes its panes once the agents stop.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'number', description: 'Optional job or loop id, the number after "ct-" or "loop-" (one shared id space).' },
          action: { type: 'string', enum: ['cancel'], description: 'Optional: cancel the job or loop named by id.' },
        },
      },
    })
    await $.command.register({ name: 'codex-team', description: 'Lists the Codex Team jobs and any ct-* panes left behind: /codex-team' })
    await $.command.register({ name: 'codex-team-doctor', description: 'Checks that Herdr and Codex are in place: /codex-team-doctor' })

    const run = (argv: string[], init?: { timeoutMs?: number }) => $.process.run(argv, init)
    unavailable = await herdrAvailable(run, { HERDR_ENV: await $.env.get('HERDR_ENV') })
    const pane = await $.env.get('HERDR_PANE_ID')
    if (unavailable === undefined && !pane) unavailable = 'HERDR_PANE_ID is not set: codex-team needs to know the pane it runs in.'
    if (unavailable === undefined && pane) {
      const cwd = await $.session.cwd()
      const tmpdir = await $.env.get('TMPDIR')
      const deps = {
        herdr: herdrOf((argv, init) => $.process.run(argv, init), { pane, cwd }),
        layout: createPaneLayout(),
        files: { read: (path: string) => $.fs.read(path).catch(() => undefined), write: (path: string, text: string) => $.fs.write(path, text) },
        tmpdir,
        now: Date.now,
      }
      book = createBook({ ...deps, notify: notifier($) })
      loopDeps = { ...deps, notify: loopNotifier($) }
    }

    return next(e)
  })

  on('tool.call', { tool: 'mcp__codex-team__execute' }, ($, e) => startJob({ book, unavailable }, 'execute', e, () => publish($)).catch(failure))

  on('tool.call', { tool: 'mcp__codex-team__review' }, ($, e) => startJob({ book, unavailable }, 'review', e, () => publish($)).catch(failure))

  on('tool.call', { tool: 'mcp__codex-team__loop' }, ($, e) => startLoop({ book, loopDeps, unavailable }, e, loop => loops.push(loop), () => publish($)).catch(failure))
    .catch(() => refusal('codex-team loop failed before it could answer.'))

  on('tool.call', { tool: 'mcp__codex-team__jobs' }, ($, e) => jobsTool({ book, loops, unavailable }, e, () => publish($), Date.now).catch(failure))

  on('command.run', { command: 'codex-team' }, async ($, e) => {
    if (!book) return { text: unavailable ?? NOT_READY }
    const orphans = await book.orphans()
    const left = orphanText(orphans)
    return { text: allJobs(loops, book?.jobs(), Date.now) + left }
  })

  on('command.run', { command: 'codex-team-doctor' }, async ($, e) => ({ text: await doctor($) }))

  // The band above the prompt: one row per active job, no buttons (the decision is in the pane).
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const jobs = await read($, jobsAtom)

    if (jobs.length === 0 || e.props.hasSurvey) {
      return next(e)
    }

    return draw($.ui.resolve(e), jobs, Math.max(0, e.props.maxRows - CHROME_ROWS))
  })
}
