import { reportPath, requestOf } from './team'
import type { Deps, Job, createBook } from './team'

export type Verdict = 'approved' | 'changes'
export type Round = { dev: number; qa?: number; verdict?: Verdict }
export type LoopStatus = 'developing' | 'reviewing' | 'approved' | 'exhausted' | 'failed' | 'cancelled'
export type LoopRequest = { task: string; files: string[]; maxRounds: number }
export type Loop = LoopRequest & {
  id: number
  status: LoopStatus
  rounds: Round[]
  error?: string
  startedAt: number
  endedAt?: number
  report?: string
}

type Book = ReturnType<typeof createBook>
export type LoopDeps = Omit<Deps, 'notify'> & { notify: (event: 'finished', loop: Loop) => void }

/** Only an exact verdict on the last non-empty line decides the QA result. */
export function verdictOf(report?: string): Verdict | undefined {
  const last = report?.split('\n').map(line => line.trim()).filter(Boolean).at(-1)
  return last === 'VERDICT: APPROVED' ? 'approved' : last === 'VERDICT: CHANGES' ? 'changes' : undefined
}

export const qaFocus = (task: string) =>
  [
    `Acceptance criteria:\n${task}`,
    'Report only actionable findings, each with the file, the line and why it matters. Do not edit any file.',
    'End the report with exactly one last line: VERDICT: APPROVED or VERDICT: CHANGES.',
  ].join('\n')

export const fixTask = (task: string, qaReport: string) => `${task}\nRead the QA report at ${qaReport} and fix the findings.`

/** Reads the loop input with the same task and file rules as execute. */
export function loopOf(e: Record<string, unknown>): LoopRequest | string {
  const request = requestOf('execute', e)
  if (typeof request === 'string') return request
  const maxRounds = e.maxRounds === undefined ? 3 : e.maxRounds
  if (typeof maxRounds !== 'number' || !Number.isInteger(maxRounds) || maxRounds < 1) return 'Give maxRounds as an integer at least 1.'
  return { task: request.task, files: request.files, maxRounds }
}

const active = (loop: Loop) => loop.status === 'developing' || loop.status === 'reviewing'
const note = (loop: Loop, text: string) => { loop.error = [loop.error, text].filter(Boolean).join('\n') }

/** The parent report keeps every child id and report path, even on a failure. */
export function loopReport(loop: Loop, book: Book, findings?: string): string {
  const child = (phase: string, id: number) => {
    const job = book.get(id)
    return `${phase}: ct-${id}${job?.report ? ` — report: ${job.report}` : ' — no report'}`
  }
  return [
    `# Codex Team loop-${loop.id}`,
    `Status: ${loop.status}`,
    `Rounds: ${loop.rounds.length}/${loop.maxRounds}`,
    `Task: ${loop.task}`,
    ...loop.rounds.flatMap((round, index) => [
      '', `## Round ${index + 1}`, child('Dev', round.dev),
      ...(round.qa === undefined ? [] : [child('QA', round.qa)]),
      `Verdict: ${round.verdict ?? 'none'}`,
    ]),
    ...(loop.error ? ['', `Note: ${loop.error}`] : []),
    ...(loop.status === 'exhausted' && findings !== undefined ? ['', '## Last QA findings', findings] : []),
  ].join('\n')
}

/** Runs every round in one execute slot. Never rejects: an error becomes `failed`. */
export async function runLoop(deps: LoopDeps, loop: Loop, book: Book): Promise<void> {
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
        const dev = await book.start({ kind: 'execute', task: index === 1 ? loop.task : fixTask(loop.task, lastQaReport), files: loop.files }, { quiet: true, owned: true })
        const round: Round = { dev: dev.id }
        loop.rounds.push(round)
        if (cancelled()) await book.cancel(dev.id)
        await book.ended(dev.id)
        if (!check(dev, `dev ${index}`) || cancelled()) return
        if (!dev.report) note(loop, `dev ${index}: ${dev.error ?? 'no report was written; QA will review the diff'}`)

        loop.status = 'reviewing'
        const qa = await book.start({ kind: 'review', task: '', files: [], focus: qaFocus(loop.task) }, { quiet: true })
        round.qa = qa.id
        if (cancelled()) await book.cancel(qa.id)
        await book.ended(qa.id)
        if (!check(qa, `qa ${index}`) || cancelled()) return
        lastQaReport = qa.report ?? reportPath(deps.tmpdir, qa.id)
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
}

/** Reserves an id in the job book and answers before the first round finishes. */
export async function loopStart(deps: LoopDeps, book: Book, request: LoopRequest): Promise<Loop> {
  const loop: Loop = { id: await book.reserveId(), ...request, status: 'developing', rounds: [], startedAt: deps.now() }
  void runLoop(deps, loop, book)
  return loop
}

export async function cancelLoop(deps: Pick<LoopDeps, 'now'>, book: Book, loop: Loop): Promise<string> {
  if (!active(loop)) return `loop-${loop.id} is ${loop.status}: nothing to cancel.`
  loop.status = 'cancelled'
  loop.endedAt = deps.now()
  const round = loop.rounds.at(-1)
  const child = round?.qa ?? round?.dev
  const answer = child === undefined ? '' : await book.cancel(child)
  return `loop-${loop.id} is cancelled; no further rounds will start.${answer ? ` ${answer}` : ''}`
}
