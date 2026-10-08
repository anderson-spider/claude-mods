import { loopAgentName, loopReportPath, phaseReportPath } from './names'
import { waitForStop } from './job'
import { fixTask, qaFocus } from './prompts'
import { loopReport } from './presentation'
import { checksOf, verdictOf } from './report'
import { appendNote, messageOf } from './text'
import type { AgentSession, Book, Job, Loop, LoopBook, LoopDeps, LoopRequest, NotifyEvent, Round } from './model'

const active = (loop: Loop) => loop.status === 'developing' || loop.status === 'reviewing'

/** Runs every round in one execute slot. Never rejects: an error becomes `failed`. */
export async function runLoop(deps: LoopDeps, loop: Loop, book: LoopBook): Promise<void> {
  const devSession: AgentSession = { agent: loopAgentName(loop.id, 'dev') }
  const qaSession: AgentSession = { agent: loopAgentName(loop.id, 'qa') }
  const notify = (event: NotifyEvent, job: Job) => {
    if (event === 'blocked') deps.notify(event, loop, job)
  }
  // What the next dev round fixes: the last QA report, or the dev's own report whose checks failed.
  let fix: { path: string; source: 'qa' | 'checks' } | undefined
  let findings: string | undefined
  const cancelled = () => loop.status === 'cancelled'
  const check = (job: Job, phase: string) => {
    if (job.status === 'done') return true
    if (!cancelled()) loop.status = job.status === 'cancelled' ? 'cancelled' : 'failed'
    appendNote(loop, `${phase}: ${job.agent} ${job.status}${job.error ? `: ${job.error}` : ''}`)
    return false
  }

  try {
    await book.exclusive(async () => {
      for (let index = 1; index <= loop.maxRounds; index++) {
        if (cancelled()) return
        loop.status = 'developing'
        const dev = await book.start({ kind: 'execute', task: index === 1 || !fix ? loop.task : fixTask(loop.task, fix.path, fix.source), files: loop.files, engine: loop.devEngine }, {
          quiet: true, owned: true, session: devSession, paneName: `loop-${loop.id} dev`,
          reportPath: phaseReportPath(deps.tmpdir, loop.id, 'dev', index), notify,
        })
        const round: Round = { dev: dev.id }
        loop.rounds.push(round)
        if (cancelled()) await book.cancel(dev.id)
        await book.ended(dev.id)
        if (!check(dev, `dev ${index}`) || cancelled()) return
        if (!dev.report) appendNote(loop, `dev ${index}: ${dev.error ?? 'no report was written; QA will review the diff'}`)
        else {
          round.checks = checksOf(await deps.files.read(dev.report))
          if (cancelled()) return
          if (round.checks === 'fail') {
            // The dev's own checks failed: skip QA and send the dev back with its report.
            appendNote(loop, `dev ${index}: CHECKS: FAIL, QA skipped — report: ${dev.report}`)
            fix = { path: dev.report, source: 'checks' }
            findings = undefined
            continue
          }
          if (round.checks === 'not run') appendNote(loop, `dev ${index}: CHECKS: NOT RUN`)
          if (round.checks === undefined) appendNote(loop, `dev ${index}: no CHECKS line`)
        }

        loop.status = 'reviewing'
        const qa = await book.start({ kind: 'review', task: '', files: [], focus: qaFocus(loop.task), engine: loop.qaEngine }, {
          quiet: true, session: qaSession, paneName: `loop-${loop.id} qa`,
          reportPath: phaseReportPath(deps.tmpdir, loop.id, 'qa', index), notify,
        })
        round.qa = qa.id
        if (cancelled()) await book.cancel(qa.id)
        await book.ended(qa.id)
        if (!check(qa, `qa ${index}`) || cancelled()) return
        const qaReport = qa.report ?? phaseReportPath(deps.tmpdir, loop.id, 'qa', index)
        fix = { path: qaReport, source: 'qa' }
        findings = await deps.files.read(qaReport)
        if (cancelled()) return
        round.verdict = verdictOf(findings)
        if (!round.verdict) {
          loop.status = 'failed'
          appendNote(loop, `QA report has no VERDICT line: ${qaReport}`)
          return
        }
        if (round.verdict === 'approved') { loop.status = 'approved'; return }
      }
      loop.status = 'exhausted'
    })
  } catch (error) {
    if (!cancelled()) loop.status = 'failed'
    appendNote(loop, messageOf(error))
  }

  loop.endedAt = deps.now()
  try {
    const path = loopReportPath(deps.tmpdir, loop.id)
    await deps.files.write(path, loopReport(loop, book, findings))
    loop.report = path
  } catch (error) {
    if (!cancelled()) loop.status = 'failed'
    appendNote(loop, messageOf(error))
  }
  try {
    deps.notify('finished', loop)
  } catch {
    // The completed loop stays readable through jobs if its notification fails.
  }

  const sessions = [devSession, qaSession]
  // A failed phase may still be active; cancelled phases already waited in book.ended.
  for (const session of sessions) await waitForStop(deps.herdr, session)
  for (const session of sessions) {
    if (!session.pane) continue
    try {
      await deps.layout.close(deps.herdr, session.pane, session.agent, session.terminal)
    } catch {
      // Closing panes is best effort: the report, notification and status stand.
    }
  }
}

/** Reserves an id in the job book and answers before the first round finishes. */
export async function loopStart(deps: LoopDeps, book: LoopBook & Pick<Book, 'reserveId'>, request: LoopRequest): Promise<Loop> {
  const loop: Loop = { id: await book.reserveId(), ...request, status: 'developing', rounds: [], startedAt: deps.now() }
  void runLoop(deps, loop, book)
  return loop
}

export async function cancelLoop(deps: Pick<LoopDeps, 'now'>, book: Pick<Book, 'cancel'>, loop: Loop): Promise<string> {
  if (!active(loop) && !(loop.status === 'cancelled' && loop.endedAt === undefined)) return `loop-${loop.id} is ${loop.status}: nothing to cancel.`
  loop.status = 'cancelled'
  const round = loop.rounds.at(-1)
  const child = round?.qa ?? round?.dev
  const answer = child === undefined ? '' : await book.cancel(child)
  return `loop-${loop.id} is cancelled; no further rounds will start.${answer ? ` ${answer}` : ''}`
}
