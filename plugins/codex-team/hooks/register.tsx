import { atom, read, update } from 'claude-code'
import type { Elements, EngineInterface, Register, RenderElement } from 'claude-code'

import type { BandJob } from '../types'
import { herdrAvailable, herdrOf } from './herdr'
import { PROMPT, bandRows, createBook, doctorReport, jobDetail, jobsReport, requestOf } from './team'
import type { Check, Job, Kind } from './team'
import { cancelLoop, loopOf, loopReport, loopStart } from './loop'
import type { Loop, LoopDeps } from './loop'

type Kit = Pick<Elements['terminal'], 'Box' | 'Text'>

const TITLE = 'Codex Team'
// Border (2), title (1) and the 'and N more' line (1).
const CHROME_ROWS = 4
const SUMMARY_LINES = 12

const jobsAtom = atom({ plugin: 'codex-team', key: 'jobs' } as const, [] as BandJob[])

// Jobs run long after the hook that started them returned, so the module keeps the
// book of this session; a reload starts it over. `$` is only ever passed on, never stored.
let book: ReturnType<typeof createBook> | undefined
let loops: Loop[] = []
let loopDeps: LoopDeps | undefined
let unavailable: string | undefined
let ticker: { cancel: () => void } | undefined

const FINISHED: Job['status'][] = ['done', 'failed', 'cancelled']
const NOT_READY = 'codex-team is not ready: the session has not started it yet.'

const snapshot = (): BandJob[] =>
  [
    ...loops.filter(loop => loop.status === 'developing' || loop.status === 'reviewing')
      .map((loop): BandJob => ({ id: `loop-${loop.id}`, kind: 'loop', status: loop.status, round: loop.rounds.length, maxRounds: loop.maxRounds, pane: '…', elapsedSeconds: Math.floor((Date.now() - loop.startedAt) / 1000) })),
    ...(book?.jobs() ?? [])
    .filter(job => !FINISHED.includes(job.status))
    .map(job => ({ id: job.agent, kind: job.kind, status: job.status, pane: job.pane ?? '…', elapsedSeconds: Math.floor((Date.now() - job.startedAt) / 1000) })),
  ]

// The band draws what `$.state` holds; a one-second tick keeps the elapsed time moving while a job is active.
async function publish($: EngineInterface) {
  const jobs = snapshot()
  await update($, jobsAtom, () => jobs)
  if (jobs.length > 0 && !ticker) {
    ticker = $.clock.every(1000, () => void publish($))
  } else if (jobs.length === 0 && ticker) {
    ticker.cancel()
    ticker = undefined
  }
}

const finishedText = (job: Job) =>
  [
    `[codex-team job ${job.agent} ${job.status}: ${job.kind}]`,
    job.title,
    job.report ? `Report: ${job.report}` : '',
    job.error ? `Note: ${job.error}` : '',
    job.summary ? `Summary:\n${job.summary.split('\n').slice(0, SUMMARY_LINES).join('\n')}` : '',
  ]
    .filter(Boolean)
    .join('\n')

const notifier = ($: EngineInterface) => (event: 'blocked' | 'finished', job: Job) => {
  void publish($)
  if (event === 'blocked') {
    $.ui.toast(`Codex Team: ${job.agent} needs you in pane ${job.pane}`)
    return
  }
  $.ui.toast(`Codex Team: ${job.agent} ${job.status}`)
  void $.prompt.submit({ text: finishedText(job) }).catch(() => undefined)
}

const loopNotifier = ($: EngineInterface) => (_event: 'finished', loop: Loop) => {
  void publish($)
  $.ui.toast(`Codex Team: loop-${loop.id} ${loop.status}`)
  void $.prompt.submit({ text: [
    `[codex-team loop-${loop.id} ${loop.status}]`, loop.task,
    `Rounds: ${loop.rounds.length}/${loop.maxRounds}`,
    loop.report ? `Report: ${loop.report}` : '',
    loop.error ? `Note: ${loop.error}` : '',
  ].filter(Boolean).join('\n') }).catch(() => undefined)
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

const refusal = (text: string) => ({ result: text, isError: true as const })

// A tool handler never rejects: an error becomes a refusal the model can read.
const failure = (error: unknown) => refusal(`codex-team failed: ${error instanceof Error ? error.message : String(error)}`)

async function start($: EngineInterface, kind: Kind, e: Record<string, unknown>) {
  if (!book) return refusal(unavailable ?? NOT_READY)
  const request = requestOf(kind, e)
  if (typeof request === 'string') return refusal(request)
  const job = await book.start(request)
  await publish($)
  return { result: `Started job ${job.agent} (${kind}). A message arrives when it finishes; the jobs tool lists it meanwhile.` }
}

async function startLoop($: EngineInterface, e: Record<string, unknown>) {
  if (!book || !loopDeps) return refusal(unavailable ?? NOT_READY)
  const request = loopOf(e)
  if (typeof request === 'string') return refusal(request)
  const loop = await loopStart(loopDeps, book, request)
  loops.push(loop)
  await publish($)
  return { result: `Started loop-${loop.id}. One message arrives at the end with the verdict and report path; the jobs tool lists it meanwhile.` }
}

const allJobs = () => [
  ...[...loops].reverse().map(loop => `loop-${loop.id} ${loop.status} ${loop.rounds.length}/${loop.maxRounds}: ${loop.task.slice(0, 60)}${loop.report ? `\n  report ${loop.report}` : loop.error ? `\n  ${loop.error}` : ''}`),
  !loops.length || book?.jobs().length ? jobsReport(book?.jobs() ?? [], Date.now()) : '',
].filter(Boolean).join('\n')

async function jobsTool($: EngineInterface, e: Record<string, unknown>) {
  if (!book) return refusal(unavailable ?? NOT_READY)
  const loop = typeof e.id === 'number' ? loops.find(loop => loop.id === e.id) : undefined
  if (e.action === 'cancel') {
    if (typeof e.id !== 'number') return refusal('Give the id of the job to cancel.')
    const answer = loop ? await cancelLoop({ now: Date.now }, book, loop) : await book.cancel(e.id)
    await publish($)
    return { result: answer }
  }
  if (typeof e.id === 'number') {
    if (loop) return { result: [loopReport(loop, book), loop.report ? `Report: ${loop.report}` : ''].filter(Boolean).join('\n') }
    const job = book.get(e.id)
    return job ? { result: jobDetail(job) } : refusal(`No job ct-${e.id} in this session.`)
  }
  return { result: allJobs() }
}

async function doctor($: EngineInterface): Promise<string> {
  const run = (argv: string[]) => $.process.run(argv, { timeoutMs: 15_000 }).catch(() => undefined)
  const inside = (await $.env.get('HERDR_ENV')) === '1'
  const checks: Check[] = [
    { name: 'inside Herdr', ok: inside, detail: inside ? 'HERDR_ENV=1' : 'HERDR_ENV is not 1: run Claude Code in a Herdr pane' },
  ]
  for (const tool of ['herdr', 'codex']) {
    const found = await run([tool, '--version'])
    checks.push({ name: tool, ok: found?.exitCode === 0, detail: found?.exitCode === 0 ? found.stdout.trim().split('\n')[0]! : 'not installed or not in PATH' })
  }
  const listed = await run(['herdr', 'agent', 'list'])
  checks.push({ name: 'herdr agent list', ok: listed?.exitCode === 0, detail: listed?.exitCode === 0 ? 'answers' : (listed?.stderr || 'no answer').trim().slice(0, 200) })
  return doctorReport(checks)
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
        'A cancel sends ctrl+c to its active Codex and leaves the pane open; a cancelled loop starts no further rounds.',
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
        files: { read: (path: string) => $.fs.read(path).catch(() => undefined), write: (path: string, text: string) => $.fs.write(path, text) },
        tmpdir,
        now: Date.now,
      }
      book = createBook({ ...deps, notify: notifier($) })
      loopDeps = { ...deps, notify: loopNotifier($) }
    }

    return next(e)
  })

  on('tool.call', { tool: 'mcp__codex-team__execute' }, ($, e) => start($, 'execute', e).catch(failure))

  on('tool.call', { tool: 'mcp__codex-team__review' }, ($, e) => start($, 'review', e).catch(failure))

  on('tool.call', { tool: 'mcp__codex-team__loop' }, ($, e) => startLoop($, e).catch(failure))
    .catch(() => refusal('codex-team loop failed before it could answer.'))

  on('tool.call', { tool: 'mcp__codex-team__jobs' }, ($, e) => jobsTool($, e).catch(failure))

  on('command.run', { command: 'codex-team' }, async ($, e) => {
    if (!book) return { text: unavailable ?? NOT_READY }
    const orphans = await book.orphans()
    const left = orphans.length ? `\n\nct-* agents left from before a reload (their panes are still open):\n${orphans.map(o => `  ${o.name} in ${o.pane}`).join('\n')}` : ''
    return { text: allJobs() + left }
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
