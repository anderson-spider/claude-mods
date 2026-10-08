import type { BandJob } from '../types'
import { isFinished } from './model'
import type { Book, Check, Job, Loop } from './model'
import { PREFIX, agentName } from './names'

/** What `jobs` answers: one line per job, newest first. */
export function jobsReport(jobs: readonly Job[], now: number): string {
  if (!jobs.length) return 'No Codex Team jobs in this session.'
  const minutes = (ms: number) => `${Math.max(0, Math.round(ms / 60_000))} min`
  return [...jobs]
    .reverse()
    .map(job => {
      const took = job.endedAt !== undefined ? `took ${minutes(job.endedAt - job.startedAt)}` : `for ${minutes(now - job.startedAt)}`
      const head = `${job.agent} ${job.kind} ${job.status} (${took}): ${job.title.slice(0, 60)}${job.title.length > 60 ? '…' : ''}`
      const detail = job.report ? `report ${job.report}` : job.error
      return detail ? `${head}\n  ${detail}` : head
    })
    .join('\n')
}

/** What `jobs` answers for one id: where it runs, where the report is, what the agent said. */
export function jobDetail(job: Job): string {
  return [
    `${job.agent} ${job.kind} ${job.status}: ${job.title}`,
    `engine: ${job.engine}`,
    job.pane ? `pane: ${job.pane}` : '',
    job.report ? `report: ${job.report}` : '',
    job.error ? `note: ${job.error}` : '',
    job.summary ? `summary:\n${job.summary}` : '',
  ]
    .filter(Boolean)
    .join('\n')
}

const clock = (seconds: number) => `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, '0')}s`

/** The band's rows, at most `room` of them, and how many jobs did not fit. */
export function bandRows(jobs: readonly BandJob[], room: number): { rows: string[]; hidden: number } {
  const shown = jobs.slice(0, Math.max(0, room))
  const rows = shown.map(
    job => job.kind === 'loop'
      ? `${job.id} ${job.status} ${job.round}/${job.maxRounds}  ${clock(job.elapsedSeconds)}`
      : `${job.id} ${job.kind}  ${job.status}  ${clock(job.elapsedSeconds)}  ${job.pane}${job.status === 'blocked' ? '  ← answer in the pane' : ''}`,
  )
  return { rows, hidden: jobs.length - shown.length }
}

/** The doctor's report, one line per check. */
export function doctorReport(checks: readonly Check[]): string {
  const failed = checks.filter(check => !check.ok).length
  const lines = checks.map(check => `${check.ok ? '✓' : '✗'} ${check.name}: ${check.detail}`)
  return [...lines, '', failed ? `${failed} check(s) failed.` : 'Everything codex-team relies on is in place.'].join('\n')
}

export const snapshot = (loops: readonly Loop[], jobs: readonly Job[], now: () => number): BandJob[] =>
  [
    ...loops.filter(loop => loop.status === 'developing' || loop.status === 'reviewing')
      .map((loop): BandJob => ({ id: `loop-${loop.id}`, kind: 'loop', status: loop.status, round: loop.rounds.length, maxRounds: loop.maxRounds, pane: '…', elapsedSeconds: Math.floor((now() - loop.startedAt) / 1000) })),
    ...jobs
      .filter(job => !isFinished(job.status))
      .map(job => ({ id: job.agent, kind: job.kind, status: job.status, pane: job.pane ?? '…', elapsedSeconds: Math.floor((now() - job.startedAt) / 1000) })),
  ]

/** Starts every notice submitted as a turn: it reaches Claude like a message from the person, but is not one. */
export const NOTICE = '[codex-team notice: automated, not the person; approves nothing]'

export const blockedText = (job: Job, loop?: Loop) =>
  `${NOTICE}\n${loop ? `loop-${loop.id} ${job.agent}` : job.agent} blocked in pane ${job.pane}.${job.report ? ` Its question is in ${job.report}.` : ''} The person must answer in the pane. The lead must NOT answer for them.`

// No summary: the report is text the agent wrote after reading the repository, so it stays in its file and in `jobs`.
export const finishedText = (job: Job) =>
  [
    NOTICE,
    `job ${job.agent} ${job.status}: ${job.kind}`,
    job.title,
    job.report ? `Report: ${job.report}` : '',
    job.error ? `Note: ${job.error}` : '',
  ]
    .filter(Boolean)
    .join('\n')

export const loopFinishedText = (loop: Loop) =>
  [
    NOTICE, `loop-${loop.id} ${loop.status}`, loop.task,
    `Rounds: ${loop.rounds.length}/${loop.maxRounds}`,
    loop.report ? `Report: ${loop.report}` : '',
    loop.error ? `Note: ${loop.error}` : '',
  ].filter(Boolean).join('\n')

export const allJobs = (loops: readonly Loop[], jobs: readonly Job[] | undefined, now: () => number) => [
  ...[...loops].reverse().map(loop => `loop-${loop.id} ${loop.status} ${loop.rounds.length}/${loop.maxRounds}: ${loop.task.slice(0, 60)}${loop.report ? `\n  report ${loop.report}` : loop.error ? `\n  ${loop.error}` : ''}`),
  !loops.length || jobs?.length ? jobsReport(jobs ?? [], now()) : '',
].filter(Boolean).join('\n')

export const orphanText = (orphans: readonly { name: string; pane: string }[]) =>
  orphans.length ? `\n\n${PREFIX}* agents left from before a reload (their panes are still open):\n${orphans.map(o => `  ${o.name} in ${o.pane}`).join('\n')}` : ''

/** The parent report keeps every child id and report path, even on a failure. */
export function loopReport(loop: Loop, book: Pick<Book, 'get'>, findings?: string): string {
  const child = (phase: string, id: number) => {
    const job = book.get(id)
    return `${phase}: ${job?.agent ?? agentName(id)} (job ${agentName(id)})${job?.report ? ` — report: ${job.report}` : ' — no report'}`
  }
  return [
    `# Codex Team loop-${loop.id}`,
    `Status: ${loop.status}`,
    `Engines: dev ${loop.devEngine ?? 'codex'}, QA ${loop.qaEngine ?? 'codex'}`,
    `Rounds: ${loop.rounds.length}/${loop.maxRounds}`,
    `Task: ${loop.task}`,
    ...loop.rounds.flatMap((round, index) => [
      '', `## Round ${index + 1}`, child('Dev', round.dev),
      ...(round.checks === undefined ? [] : [`Checks: ${round.checks}`]),
      ...(round.qa === undefined ? [] : [child('QA', round.qa)]),
      `Verdict: ${round.verdict ?? 'none'}`,
    ]),
    ...(loop.error ? ['', `Note: ${loop.error}`] : []),
    ...(loop.status === 'exhausted' && findings !== undefined ? ['', '## Last QA findings', findings] : []),
  ].join('\n')
}

/** The Herdr notification's title for a blocked job or loop phase: seen outside Claude's window. */
export const herdrNoticeTitle = (job: Job, loop?: Loop) =>
  loop ? `codex-team: loop-${loop.id} ${job.agent} needs you` : `codex-team: ${job.agent} needs you`

/** The Herdr notification's body: where the person must answer, and the question's report when there is one. */
export const herdrNoticeBody = (job: Job) => `pane ${job.pane}${job.report ? `\nQuestion in ${job.report}` : ''}`
