import { reportPath } from './names'
import { buildPrompt, codexArgs } from './prompts'
import { HerdrError } from './model'
import { isWaiting } from './report'
import type { AgentSession, AgentState, Deps, Herdr, Job, Request, Status } from './model'

export const JOB_LIMIT_MS = 30 * 60_000
// `$.process.run` kills a child after 10 minutes at most: every wait runs in chunks below that.
export const WAIT_CHUNK_MS = 540_000
const SUMMARY_CHARS = 600
const LEFT_BLOCKED: AgentState[] = ['working', 'idle', 'done']

type JobDeps = Omit<Deps, 'herdr'> & { herdr: Pick<Herdr, 'split' | 'rename' | 'start' | 'prompt' | 'wait' | 'read'> }

// A cancel from outside wins: nothing the run learns afterwards changes a cancelled job.
const setStatus = (job: Job, status: Status) => {
  if (job.status !== 'cancelled') job.status = status
}

function waits(deps: Pick<Deps, 'now' | 'notify'> & { herdr: Pick<Herdr, 'wait'> }, job: Job, timing: { deadline: number; limit: number; chunk: number }) {
  const { herdr } = deps
  const { deadline, limit, chunk } = timing
  const set = (status: Status) => setStatus(job, status)
  const cancelled = () => job.status === 'cancelled'

  // Runs `step` in chunks until it settles or the job limit passes; a chunk's own timeout carries on with `wait`, for the same `until`.
  const settle = async <T extends AgentState>(first: (timeoutMs: number) => Promise<T>, until?: AgentState[]): Promise<AgentState> => {
    let step: (timeoutMs: number) => Promise<AgentState> = first
    for (;;) {
      const remaining = deadline - deps.now()
      if (remaining <= 0) throw new HerdrError('timeout', `the job limit of ${Math.round(limit / 60_000)} minutes passed`)
      try {
        return await step(Math.min(chunk, remaining))
      } catch (error) {
        if (!(error instanceof HerdrError) || error.code !== 'timeout') throw error
        step = timeoutMs => herdr.wait(job.agent, timeoutMs, until)
      }
    }
  }

  // A blocked agent waits for the person: say so once, then wait for it to leave that state, then for the next settle.
  const whileBlocked = async (state: AgentState): Promise<AgentState> => {
    while (state === 'blocked') {
      set('blocked')
      if (!cancelled()) deps.notify('blocked', job)
      state = await settle(timeoutMs => herdr.wait(job.agent, timeoutMs, LEFT_BLOCKED), LEFT_BLOCKED)
      if (state === 'working') {
        set('working')
        state = await settle(timeoutMs => herdr.wait(job.agent, timeoutMs))
      }
    }
    return state
  }

  return { settle, whileBlocked }
}

function recordReport(job: Job, path: string, report: string | undefined): boolean {
  if (report === undefined) return false
  job.report = path
  job.summary = report.slice(0, SUMMARY_CHARS)
  return true
}

function errorText(code: string, message: string, pane: string): string {
  return code === 'agent_prompt_stalled'
    ? `Codex showed no activity after the prompt${pane}; it may still have arrived, so it was not sent again: inspect the pane.`
    : code === 'timeout'
      ? `timeout: ${message}${pane}; Codex was not stopped.`
      : `${message}${pane}`
}

export type JobOptions = { limitMs?: number; chunkMs?: number; freshReport?: boolean; session?: AgentSession; reportPath?: string; paneName?: string }

/**
 * Runs one job in its own Herdr pane, or reuses the supplied role session. Never rejects: an error becomes `failed`.
 * Mutates `job`; `deps.notify` hears about each blocked episode and the end.
 */
export async function runJob(deps: JobDeps, job: Job, request: Request, options: JobOptions = {}): Promise<void> {
  const { herdr } = deps
  const limit = options.limitMs ?? JOB_LIMIT_MS
  const chunk = options.chunkMs ?? WAIT_CHUNK_MS
  const deadline = deps.now() + limit
  const where = () => (job.pane ? ` (pane ${job.pane})` : '')
  const set = (status: Status) => setStatus(job, status)
  const cancelled = () => job.status === 'cancelled'
  const path = options.reportPath ?? reportPath(deps.tmpdir, job.id)
  const session = options.session
  const { settle, whileBlocked } = waits(deps, job, { deadline, limit, chunk })

  try {
    // Loop children must not inherit a verdict from a report left by an earlier session.
    if (options.freshReport) {
      await deps.files.write(path, '')
      if (cancelled()) return
    }
    set('starting')
    job.pane = session?.pane
    if (!job.pane) {
      job.pane = await deps.layout.open(herdr)
      if (session) session.pane = job.pane
      await herdr.rename(job.pane, options.paneName ?? `${job.agent} ${job.kind}`).catch(() => undefined)
    }
    // Cancelled while opening or naming the pane: never send a task afterwards.
    if (cancelled()) return

    if (!session?.ready) {
      try {
        await herdr.start(job.agent, job.pane, codexArgs(request.kind))
      } catch (error) {
        // A startup error does not prove the role stopped.
        if (session) session.active = true
        if (!(error instanceof HerdrError) || error.code !== 'agent_not_ready') throw error
        if (cancelled()) return
        await whileBlocked('blocked')
        if (session) session.active = false
      }
      if (session) session.ready = true
    }

    if (cancelled()) return
    set('working')
    if (session) session.active = true
    await whileBlocked(await settle(timeoutMs => herdr.prompt(job.agent, buildPrompt(request.kind, request, path), timeoutMs)))
    if (session) session.active = false
    if (cancelled()) return

    let written = await deps.files.read(path)
    let report = options.freshReport && written === '' ? undefined : written
    // A report that opens with `STATUS: WAITING` holds a question: the agent waits for the person in its pane, then writes the real report.
    while (isWaiting(report)) {
      job.report = path
      set('blocked')
      if (!cancelled()) deps.notify('blocked', job)
      await settle(timeoutMs => herdr.wait(job.agent, timeoutMs, ['working']), ['working'])
      if (cancelled()) return
      set('working')
      // Answered: a later blocked episode (an approval) has no question in the report.
      job.report = undefined
      await whileBlocked(await settle(timeoutMs => herdr.wait(job.agent, timeoutMs)))
      if (cancelled()) return
      written = await deps.files.read(path)
      report = options.freshReport && written === '' ? undefined : written
    }
    if (!recordReport(job, path, report)) {
      job.summary = await herdr.read(job.agent, 200)
      job.error = `no report was written to ${path}; the summary is the text of the pane${where()}`
    }
    set('done')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const code = error instanceof HerdrError ? error.code : ''
    set('failed')
    job.error = errorText(code, message, where())
  }

  if (cancelled()) return
  job.endedAt = deps.now()
  deps.notify('finished', job)
}
