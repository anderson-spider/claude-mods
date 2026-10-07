import { loopAgentName, phaseReportPath, reportPath } from './names'
import { fixTask, qaFocus } from './prompts'
import { loopReport } from './presentation'
import { waitForStop } from './stopping'
import type { AgentSession, Book, Job, Loop, LoopDeps, LoopRequest, Round, Verdict } from './model'

/** Only an exact verdict on the last non-empty line decides the QA result. */
export function verdictOf(report?: string): Verdict | undefined {
  const last = report?.split('\n').map(line => line.trim()).filter(Boolean).at(-1)
  return last === 'VERDICT: APPROVED' ? 'approved' : last === 'VERDICT: CHANGES' ? 'changes' : undefined
}

const active = (loop: Loop) => loop.status === 'developing' || loop.status === 'reviewing'
const note = (loop: Loop, text: string) => { loop.error = [loop.error, text].filter(Boolean).join('\n') }

/** Runs every round in one execute slot. Never rejects: an error becomes `failed`. */
export async function runLoop(deps: LoopDeps, loop: Loop, book: Pick<Book, 'exclusive' | 'start' | 'ended' | 'get' | 'cancel'>): Promise<void> {
  const devSession: AgentSession = { agent: loopAgentName(loop.id, 'dev') }
  const qaSession: AgentSession = { agent: loopAgentName(loop.id, 'qa') }
  const notify = (event: 'blocked' | 'finished', job: Job) => {
    if (event === 'blocked') deps.notify(event, loop, job)
  }
  let lastQaReport = ''
  let findings: string | undefined
  const cancelled = () => loop.status === 'cancelled'
  const check = (job: Job, phase: string) => {
    if (job.status === 'done') return true
    if (!cancelled()) loop.status = job.status === 'cancelled' ? 'cancelled' : 'failed'
    note(loop, `${phase}: ${job.agent} ${job.status}${job.error ? `: ${job.error}` : ''}`)
    return false
  }

  try {
    await book.exclusive(async () => {
      for (let index = 1; index <= loop.maxRounds; index++) {
        if (cancelled()) return
        loop.status = 'developing'
        const dev = await book.start({ kind: 'execute', task: index === 1 ? loop.task : fixTask(loop.task, lastQaReport), files: loop.files }, {
          quiet: true, owned: true, session: devSession, paneName: `loop-${loop.id} dev`,
          reportPath: phaseReportPath(deps.tmpdir, loop.id, 'dev', index), notify,
        })
        const round: Round = { dev: dev.id }
        loop.rounds.push(round)
        if (cancelled()) await book.cancel(dev.id)
        await book.ended(dev.id)
        if (!check(dev, `dev ${index}`) || cancelled()) return
        if (!dev.report) note(loop, `dev ${index}: ${dev.error ?? 'no report was written; QA will review the diff'}`)

        loop.status = 'reviewing'
        const qa = await book.start({ kind: 'review', task: '', files: [], focus: qaFocus(loop.task) }, {
          quiet: true, session: qaSession, paneName: `loop-${loop.id} qa`,
          reportPath: phaseReportPath(deps.tmpdir, loop.id, 'qa', index), notify,
        })
        round.qa = qa.id
        if (cancelled()) await book.cancel(qa.id)
        await book.ended(qa.id)
        if (!check(qa, `qa ${index}`) || cancelled()) return
        lastQaReport = qa.report ?? phaseReportPath(deps.tmpdir, loop.id, 'qa', index)
        findings = await deps.files.read(lastQaReport)
        if (cancelled()) return
        round.verdict = verdictOf(findings)
        if (!round.verdict) {
          loop.status = 'failed'
          note(loop, `QA report has no VERDICT line: ${lastQaReport}`)
          return
        }
        if (round.verdict === 'approved') { loop.status = 'approved'; return }
      }
      loop.status = 'exhausted'
    })
  } catch (error) {
    if (!cancelled()) loop.status = 'failed'
    note(loop, error instanceof Error ? error.message : String(error))
  }

  loop.endedAt = deps.now()
  try {
    const path = reportPath(deps.tmpdir, loop.id).replace(/\/\d+\.md$/, `/loop-${loop.id}.md`)
    await deps.files.write(path, loopReport(loop, book, findings))
    loop.report = path
  } catch (error) {
    if (!cancelled()) loop.status = 'failed'
    note(loop, error instanceof Error ? error.message : String(error))
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
      await deps.layout.close(deps.herdr, session.pane)
    } catch {
      // Closing panes is best effort: the report, notification and status stand.
    }
  }
}

/** Reserves an id in the job book and answers before the first round finishes. */
export async function loopStart(deps: LoopDeps, book: Pick<Book, 'reserveId' | 'exclusive' | 'start' | 'ended' | 'get' | 'cancel'>, request: LoopRequest): Promise<Loop> {
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
