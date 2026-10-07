import { atom, read, update } from 'claude-code'
import type { Elements, EngineInterface, Register, RenderElement } from 'claude-code'

import type { BandJob } from '../types'
import { herdrAvailable, herdrOf } from './herdr'
import type { Herdr } from './model'
import { createBook } from './book'
import { createPaneLayout } from './pane-layout'
import { JOB_LIMIT_MS } from './names'
import { PROMPT } from './prompts'
import { EXECUTE, REVIEW, LOOP, JOBS } from './schemas'
import { allJobs, bandRows, blockedText, finishedText, herdrNoticeBody, herdrNoticeTitle, loopFinishedText, orphanText, snapshot } from './presentation'
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

// Best effort: a Herdr notification or pane label that fails never fails the job or the toast.
function herdrNotice(herdr: Herdr, job: Job, loop?: Loop) {
  void herdr.notify(herdrNoticeTitle(job, loop), herdrNoticeBody(job)).catch(() => undefined)
  if (!job.pane) return
  const title = loop ? `loop-${loop.id} ${job.kind === 'execute' ? 'dev' : 'qa'}` : `${job.agent} ${job.kind}`
  void herdr.annotate(job.pane, { title, stateLabel: 'needs you', ttlMs: JOB_LIMIT_MS }).catch(() => undefined)
}

const notifier = ($: EngineInterface, herdr: Herdr) => (event: 'blocked' | 'finished', job: Job) => {
  void publish($)
  if (event === 'blocked') {
    $.ui.toast(`Codex Team: ${job.agent} needs you in pane ${job.pane}`)
    void $.prompt.submit({ text: blockedText(job) }).catch(() => undefined)
    herdrNotice(herdr, job)
    return
  }
  $.ui.toast(`Codex Team: ${job.agent} ${job.status}`)
  void $.prompt.submit({ text: finishedText(job) }).catch(() => undefined)
}

const loopNotifier = ($: EngineInterface, herdr: Herdr) => (event: 'blocked' | 'finished', loop: Loop, job?: Job) => {
  void publish($)
  if (event === 'blocked' && job) {
    $.ui.toast(`Codex Team: loop-${loop.id} ${job.agent} needs you in pane ${job.pane}`)
    void $.prompt.submit({ text: blockedText(job, loop) }).catch(() => undefined)
    herdrNotice(herdr, job, loop)
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

    await $.tool.register(EXECUTE)
    await $.tool.register(REVIEW)
    await $.tool.register(LOOP)
    await $.tool.register(JOBS)
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
      book = createBook({ ...deps, notify: notifier($, deps.herdr) })
      loopDeps = { ...deps, notify: loopNotifier($, deps.herdr) }
    }

    return next(e)
  })

  on('tool.call', { tool: 'mcp__codex-team__execute' }, ($, e) => startJob({ book, unavailable }, 'execute', e, () => publish($)).catch(failure))

  on('tool.call', { tool: 'mcp__codex-team__review' }, ($, e) => startJob({ book, unavailable }, 'review', e, () => publish($)).catch(failure))

  on('tool.call', { tool: 'mcp__codex-team__loop' }, ($, e) => startLoop({ book, loopDeps, unavailable }, e, loop => loops.push(loop), () => publish($)).catch(failure))
    .catch(() => refusal('codex-team loop failed before it could answer.'))

  on('tool.call', { tool: 'mcp__codex-team__jobs' }, ($, e) => jobsTool({ book, loops, unavailable }, e, () => publish($), Date.now).catch(failure))

  on('command.run', { command: 'codex-team' }, async ($) => {
    if (!book) return { text: unavailable ?? NOT_READY }
    const orphans = await book.orphans()
    const left = orphanText(orphans)
    return { text: allJobs(loops, book.jobs(), Date.now) + left }
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
