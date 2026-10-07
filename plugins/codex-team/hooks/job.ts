import { JOB_LIMIT_MS, WAIT_CHUNK_MS, reportPath } from './names'
import { buildPrompt, codexArgs } from './prompts'
import { HerdrError } from './model'
import { isWaiting } from './report'
import { owns } from './identity'
import { messageOf } from './text'
import type { AgentSession, AgentState, Deps, Herdr, JobHerdr, Job, Request, Status } from './model'

const SUMMARY_CHARS = 600
const LEFT_BLOCKED: AgentState[] = ['working', 'idle', 'done']

type JobDeps = Omit<Deps, 'herdr'> & { herdr: JobHerdr }

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
  return code === 'pane_mismatch'
    ? message
    : code === 'agent_prompt_stalled'
    ? `Codex showed no activity after the prompt${pane}; it may still have arrived, so it was not sent again: inspect the pane.`
    : code === 'timeout'
      ? `timeout: ${message}${pane}; Codex was not stopped.`
      : `${message}${pane}`
}

export type JobOptions = { limitMs?: number; chunkMs?: number; freshReport?: boolean; session?: AgentSession; reportPath?: string; paneName?: string }

type Phase = {
  deps: JobDeps
  job: Job
  request: Request
  options: JobOptions
  whileBlocked: (state: AgentState) => Promise<AgentState>
}

/**
 * Opens the pane, starts the agent (or reuses the session's) and records its terminal.
 * Answers false when the job was cancelled meanwhile: nothing may be sent afterwards.
 */
async function startAgent({ deps, job, request, options, whileBlocked }: Phase): Promise<boolean> {
  const { herdr } = deps
  const session = options.session
  const cancelled = () => job.status === 'cancelled'
  // The agent's terminal is read once it runs in its pane; a failed list leaves it unknown and does not fail the job.
  const recordTerminal = async () => {
    const terminal = await herdr.list().then(agents => agents.find(agent => agent.name === job.agent && agent.pane === job.pane)?.terminal, () => undefined)
    job.terminal = terminal
    if (session) session.terminal = terminal
  }
  setStatus(job, 'starting')
  job.pane = session?.pane
  if (!job.pane) {
    job.pane = await deps.layout.open(herdr)
    if (session) session.pane = job.pane
    // Best effort: a rename failure never fails the job.
    await herdr.rename(job.pane, options.paneName ?? `${job.agent} ${job.kind}`).catch(() => undefined)
  }
  // Cancelled while opening or naming the pane: never send a task afterwards.
  if (cancelled()) return false

  if (!session?.ready) {
    try {
      await herdr.start(job.agent, job.pane, codexArgs(request.kind))
    } catch (error) {
      // A startup error does not prove the role stopped.
      if (session) session.active = true
      if (!(error instanceof HerdrError) || error.code !== 'agent_not_ready') throw error
      if (cancelled()) return false
      await whileBlocked('blocked')
      if (session) session.active = false
    }
    if (session) session.ready = true
    await recordTerminal()
  } else {
    job.terminal = session.terminal
  }
  return true
}

type Run = Phase & {
  path: string
  settle: (first: (timeoutMs: number) => Promise<AgentState>, until?: AgentState[]) => Promise<AgentState>
  readReport: () => Promise<string | undefined>
}

/** Sends the task to the agent that still runs in the pane and waits until it settles. */
async function sendTask({ deps, job, request, options, whileBlocked, settle, path }: Run): Promise<void> {
  // The prompt goes only to the agent that still runs in this pane: a reload or a Herdr restart can reuse the pane id.
  if (!await owns(deps.herdr, job.agent, job.pane ?? '', job.terminal).catch(() => false)) {
    throw new HerdrError('pane_mismatch', `pane ${job.pane} no longer runs ${job.agent}; the prompt was not sent.`)
  }
  setStatus(job, 'working')
  if (options.session) options.session.active = true
  await whileBlocked(await settle(timeoutMs => deps.herdr.prompt(job.agent, buildPrompt(request.kind, request, path), timeoutMs)))
  if (options.session) options.session.active = false
}

/** Reads the report, following any question the agent leaves for the person, and records it. Answers false when cancelled meanwhile. */
async function collectReport({ deps, job, whileBlocked, settle, path, readReport }: Run): Promise<boolean> {
  const { herdr } = deps
  const cancelled = () => job.status === 'cancelled'
  let report = await readReport()
  // A report that opens with `STATUS: WAITING` holds a question: the agent waits for the person in its pane, then writes the real report.
  while (isWaiting(report)) {
    job.report = path
    setStatus(job, 'blocked')
    if (!cancelled()) deps.notify('blocked', job)
    await settle(timeoutMs => herdr.wait(job.agent, timeoutMs, ['working']), ['working'])
    if (cancelled()) return false
    setStatus(job, 'working')
    // Answered: a later blocked episode (an approval) has no question in the report.
    job.report = undefined
    await whileBlocked(await settle(timeoutMs => herdr.wait(job.agent, timeoutMs)))
    if (cancelled()) return false
    report = await readReport()
  }
  if (!recordReport(job, path, report)) {
    job.summary = await herdr.read(job.agent, 200)
    job.error = `no report was written to ${path}; the summary is the text of the pane${job.pane ? ` (pane ${job.pane})` : ''}`
  }
  setStatus(job, 'done')
  return true
}

/**
 * Runs one job in its own Herdr pane, or reuses the supplied role session. Never rejects: an error becomes `failed`.
 * Mutates `job`; `deps.notify` hears about each blocked episode and the end.
 */
export async function runJob(deps: JobDeps, job: Job, request: Request, options: JobOptions = {}): Promise<void> {
  const limit = options.limitMs ?? JOB_LIMIT_MS
  const deadline = deps.now() + limit
  const where = () => (job.pane ? ` (pane ${job.pane})` : '')
  const cancelled = () => job.status === 'cancelled'
  const path = options.reportPath ?? reportPath(deps.tmpdir, job.id)
  const { settle, whileBlocked } = waits(deps, job, { deadline, limit, chunk: options.chunkMs ?? WAIT_CHUNK_MS })
  // Loop children read an empty file as no report, so an old verdict cannot approve a new task.
  const readReport = async () => {
    const written = await deps.files.read(path)
    return options.freshReport && written === '' ? undefined : written
  }
  const run: Run = { deps, job, request, options, whileBlocked, settle, path, readReport }

  try {
    // Loop children must not inherit a verdict from a report left by an earlier session.
    if (options.freshReport) {
      await deps.files.write(path, '')
      if (cancelled()) return
    }
    if (!await startAgent(run)) return

    if (cancelled()) return
    await sendTask(run)
    if (cancelled()) return

    if (!await collectReport(run)) return
  } catch (error) {
    const code = error instanceof HerdrError ? error.code : ''
    setStatus(job, 'failed')
    job.error = errorText(code, messageOf(error), where())
  }

  if (cancelled()) return
  job.endedAt = deps.now()
  deps.notify('finished', job)
}

/** A cancelled loop keeps its execute slot until its active agent is known to have stopped. */
export async function waitForStop(herdr: Pick<Herdr, 'wait'>, session: AgentSession): Promise<void> {
  while (session.active) {
    try {
      const state = await herdr.wait(session.agent, WAIT_CHUNK_MS, ['idle', 'done'])
      if (state === 'idle' || state === 'done') session.active = false
    } catch (error) {
      if (error instanceof HerdrError && ['agent_not_found', 'pane_not_found'].includes(error.code)) session.active = false
      // A timeout or transport failure proves nothing; another cancel can retry Esc meanwhile.
    }
  }
}
