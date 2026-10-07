import type { BandJob } from '../types'

// Pure logic of the codex-team plugin: names, Codex arguments, prompts and the
// job lifecycle, all against an injected `Herdr` so tests need no real host.

export type Kind = 'execute' | 'review'

export type Request = { kind: Kind; task: string; files: string[]; target?: string; focus?: string }

const PREFIX = 'ct-'

/** The Herdr agent name of job `id`. */
export const agentName = (id: number) => `${PREFIX}${id}`

/** The smallest id from `from` whose agent name is not among the live ones. */
export function nextFreeId(from: number, live: readonly string[]): number {
  let id = from
  while (live.includes(agentName(id))) id++
  return id
}

/** Codex's own arguments: the sandbox by kind, asking the person when it needs more. */
export const codexArgs = (kind: Kind): string[] => ['-s', kind === 'execute' ? 'workspace-write' : 'read-only', '-a', 'on-request']

/** Terminal cells are about twice as tall as wide: split a wide pane to the right, a narrow or tall one down. */
export const splitDirection = (size: { width: number; height: number }): 'right' | 'down' => (size.width >= size.height * 2 ? 'right' : 'down')

/** Where Codex writes the final report of job `id`. */
export const reportPath = (tmpdir: string | undefined, id: number) => `${(tmpdir || '/tmp').replace(/\/+$/, '')}/codex-team/${id}.md`

type PromptInput = { task?: string; files?: string[]; target?: string; focus?: string }

const REPORT_RULE = (report: string) =>
  `When you are done, write your final report as Markdown to ${report} and answer with only that path.`

/** The prompt sent to Codex: the work, the rules and where to leave the report. */
export function buildPrompt(kind: Kind, input: PromptInput, report: string): string {
  if (kind === 'execute') {
    const files = input.files?.length ? [`Start from these files: ${input.files.join(', ')}.`] : []
    return [
      `Task: ${input.task ?? ''}`,
      ...files,
      'Work only inside the current directory and stay inside the scope of the task. Do not commit and do not push.',
      REPORT_RULE(report),
    ].join('\n')
  }
  return [
    `Review ${input.target ? `the changes of ${input.target}` : 'the current uncommitted diff'}.`,
    ...(input.focus ? [`Focus on: ${input.focus}.`] : []),
    'Report only actionable findings, each with the file, the line and why it matters. Do not edit any file.',
    REPORT_RULE(report),
  ].join('\n')
}

const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : undefined)

/** Reads a tool call's input into a request, or the error to answer. */
export function requestOf(kind: Kind, e: Record<string, unknown>): Request | string {
  const task = text(e.task) ?? ''
  if (kind === 'execute' && !task) return 'Give a non-empty task.'
  const files = Array.isArray(e.files) ? e.files.filter((f): f is string => typeof f === 'string' && f.trim() !== '').map(f => f.trim()) : []
  const target = text(e.target)
  const focus = text(e.focus)
  return { kind, task, files, ...(target ? { target } : {}), ...(focus ? { focus } : {}) }
}

// --- Job lifecycle ---

export type Status = 'queued' | 'starting' | 'working' | 'blocked' | 'done' | 'failed' | 'cancelled'
/** What Herdr reports for an agent; `idle` and `done` both mean it is ready for input. */
export type AgentState = 'idle' | 'working' | 'blocked' | 'done'
/** The states a wait settles on by default. */
export type Settled = 'idle' | 'done' | 'blocked'

/** A failed herdr call; `code` is the CLI's error code (`agent_not_ready`, `agent_prompt_stalled`, `timeout`, …). */
export class HerdrError extends Error {
  code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'HerdrError'
    this.code = code
  }
}

/** What the plugin needs from Herdr; hooks/herdr.ts implements it over the CLI. */
export type Herdr = {
  size(): Promise<{ width: number; height: number }>
  /** Opens a sibling pane without taking focus and returns its id. */
  split(direction: 'right' | 'down'): Promise<string>
  start(name: string, pane: string, args: string[]): Promise<void>
  /** Sends the prompt and waits for the agent to settle; `timeout` means this chunk ran out, not the job. */
  prompt(name: string, text: string, timeoutMs: number): Promise<Settled>
  /** Waits for a settled state, or for one of `until` when given. */
  wait(name: string, timeoutMs: number, until?: AgentState[]): Promise<AgentState>
  read(name: string, lines: number): Promise<string>
  sendKeys(name: string, keys: string[]): Promise<void>
  list(): Promise<{ name: string; pane: string }[]>
}

export type Job = {
  id: number
  kind: Kind
  title: string
  status: Status
  agent: string
  pane?: string
  startedAt: number
  endedAt?: number
  report?: string
  summary?: string
  error?: string
}

export type Files = { read(path: string): Promise<string | undefined> }
export type Notify = (event: 'blocked' | 'finished', job: Job) => void
export type Deps = { herdr: Herdr; files: Files; tmpdir: string | undefined; now: () => number; notify: Notify }

export const JOB_LIMIT_MS = 30 * 60_000
// `$.process.run` kills a child after 10 minutes at most: every wait runs in chunks below that.
export const WAIT_CHUNK_MS = 540_000
const SUMMARY_CHARS = 600
const LEFT_BLOCKED: AgentState[] = ['working', 'idle', 'done']

/**
 * Runs one job in its own Herdr pane. Never rejects: an error becomes `failed`.
 * Mutates `job`; `deps.notify` hears about each blocked episode and the end.
 */
export async function runJob(deps: Deps, job: Job, request: Request, options: { limitMs?: number; chunkMs?: number } = {}): Promise<void> {
  const { herdr } = deps
  const limit = options.limitMs ?? JOB_LIMIT_MS
  const chunk = options.chunkMs ?? WAIT_CHUNK_MS
  const deadline = deps.now() + limit
  const where = () => (job.pane ? ` (pane ${job.pane})` : '')
  // A cancel from outside wins: nothing the run learns afterwards changes a cancelled job.
  const set = (status: Status) => {
    if (job.status !== 'cancelled') job.status = status
  }
  const cancelled = () => job.status === 'cancelled'

  // Runs `step` in chunks until it settles or the job limit passes; a chunk's own timeout carries on with `wait`.
  const settle = async <T extends AgentState>(first: (timeoutMs: number) => Promise<T>): Promise<AgentState> => {
    let step: (timeoutMs: number) => Promise<AgentState> = first
    for (;;) {
      const remaining = deadline - deps.now()
      if (remaining <= 0) throw new HerdrError('timeout', `the job limit of ${Math.round(limit / 60_000)} minutes passed`)
      try {
        return await step(Math.min(chunk, remaining))
      } catch (error) {
        if (!(error instanceof HerdrError) || error.code !== 'timeout') throw error
        step = timeoutMs => herdr.wait(job.agent, timeoutMs)
      }
    }
  }

  // A blocked agent waits for the person: say so once, then wait for it to leave that state, then for the next settle.
  const whileBlocked = async (state: AgentState): Promise<AgentState> => {
    while (state === 'blocked') {
      set('blocked')
      if (!cancelled()) deps.notify('blocked', job)
      state = await settle(timeoutMs => herdr.wait(job.agent, timeoutMs, LEFT_BLOCKED))
      if (state === 'working') {
        set('working')
        state = await settle(timeoutMs => herdr.wait(job.agent, timeoutMs))
      }
    }
    return state
  }

  try {
    set('starting')
    job.pane = await herdr.split(splitDirection(await herdr.size()))
    // Cancelled while the pane was opening: the empty pane stays for the person to close.
    if (cancelled()) return

    try {
      await herdr.start(job.agent, job.pane, codexArgs(request.kind))
    } catch (error) {
      if (!(error instanceof HerdrError) || error.code !== 'agent_not_ready') throw error
      await whileBlocked('blocked')
    }

    const path = reportPath(deps.tmpdir, job.id)
    set('working')
    await whileBlocked(await settle(timeoutMs => herdr.prompt(job.agent, buildPrompt(request.kind, request, path), timeoutMs)))
    if (cancelled()) return

    const report = await deps.files.read(path)
    if (report !== undefined) {
      job.report = path
      job.summary = report.slice(0, SUMMARY_CHARS)
    } else {
      job.summary = await herdr.read(job.agent, 200)
      job.error = `no report was written to ${path}; the summary is the text of the pane${where()}`
    }
    set('done')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const code = error instanceof HerdrError ? error.code : ''
    set('failed')
    job.error =
      code === 'agent_prompt_stalled'
        ? `Codex showed no activity after the prompt${where()}; it may still have arrived, so it was not sent again: inspect the pane.`
        : code === 'timeout'
          ? `timeout: ${message}${where()}; Codex was not stopped.`
          : `${message}${where()}`
  }

  if (cancelled()) return
  job.endedAt = deps.now()
  deps.notify('finished', job)
}

// --- The job book ---

/** Runs `task` after the ones queued before it: execute jobs share the working directory, so they take turns. */
function taskQueue(): <T>(task: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve()
  return task => {
    const run = tail.then(task, task)
    tail = run.catch(() => undefined)
    return run
  }
}

const titleOf = (request: Request) => (request.kind === 'execute' ? request.task : `review of ${request.target ?? 'the current diff'}`)

const FINISHED: Status[] = ['done', 'failed', 'cancelled']

/** The jobs of this session: ids, the execute queue, cancel and the lists the person and Claude read. */
export function createBook(deps: Deps) {
  const jobs: Job[] = []
  const queue = taskQueue()
  let counter = 1

  const live = async () => (await deps.herdr.list().catch(() => [])).map(agent => agent.name)

  return {
    /** Registers the job and starts it (an execute one after the others); answers at once. */
    async start(request: Request): Promise<Job> {
      const id = nextFreeId(counter, await live())
      counter = id + 1
      const job: Job = { id, kind: request.kind, title: titleOf(request), status: 'queued', agent: agentName(id), startedAt: deps.now() }
      jobs.push(job)
      const run = async () => {
        if (job.status !== 'cancelled') await runJob(deps, job, request)
      }
      void (request.kind === 'execute' ? queue(run) : run())
      return job
    },

    async cancel(id: number): Promise<string> {
      const job = jobs.find(j => j.id === id)
      if (!job) return `No job ${agentName(id)} in this session.`
      if (FINISHED.includes(job.status)) return `${job.agent} is ${job.status}: nothing to cancel.`
      if (job.status === 'queued' || !job.pane) {
        job.status = 'cancelled'
        job.endedAt = deps.now()
        return `${job.agent} had not started and is now cancelled.`
      }
      try {
        await deps.herdr.sendKeys(job.agent, ['ctrl+c'])
      } catch (error) {
        return `Could not send ctrl+c to ${job.agent} (pane ${job.pane}): ${error instanceof Error ? error.message : String(error)}`
      }
      job.status = 'cancelled'
      job.endedAt = deps.now()
      return `Sent ctrl+c to ${job.agent} (pane ${job.pane}) and marked it cancelled; the pane stays open.`
    },

    jobs: (): readonly Job[] => jobs,
    get: (id: number) => jobs.find(j => j.id === id),

    /** Live `ct-*` agents that no job of this session owns (left by a reload). */
    async orphans() {
      const owned = new Set(jobs.map(j => j.agent))
      return (await deps.herdr.list().catch(() => [])).filter(agent => !owned.has(agent.name))
    },
  }
}

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

/** What `jobs` answers for one id: where it runs, where the report is, what Codex said. */
export function jobDetail(job: Job): string {
  return [
    `${job.agent} ${job.kind} ${job.status}: ${job.title}`,
    job.pane ? `pane: ${job.pane}` : '',
    job.report ? `report: ${job.report}` : '',
    job.error ? `note: ${job.error}` : '',
    job.summary ? `summary:\n${job.summary}` : '',
  ]
    .filter(Boolean)
    .join('\n')
}

// --- The band, the prompt section and the doctor ---

const clock = (seconds: number) => `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, '0')}s`

/** The band's rows, at most `room` of them, and how many jobs did not fit. */
export function bandRows(jobs: readonly BandJob[], room: number): { rows: string[]; hidden: number } {
  const shown = jobs.slice(0, Math.max(0, room))
  const rows = shown.map(
    job => `${job.id} ${job.kind}  ${job.status}  ${clock(job.elapsedSeconds)}  ${job.pane}${job.status === 'blocked' ? '  ← answer in the pane' : ''}`,
  )
  return { rows, hidden: jobs.length - shown.length }
}

const EXECUTE_TOOL = 'mcp__codex-team__execute'
const REVIEW_TOOL = 'mcp__codex-team__review'
const JOBS_TOOL = 'mcp__codex-team__jobs'

// Added to the system prompt so Claude leads on its own; the tools may be deferred, so their descriptions
// alone are not seen until loaded.
export const PROMPT = [
  '# Leading Codex agents (codex-team mod)',
  '',
  'You can delegate work to Codex agents that run in their own Herdr panes as background jobs; the person can watch each pane.',
  '',
  `- \`${EXECUTE_TOOL}\` { task, files? }: Codex implements a well-bounded task in the current directory (sandbox workspace-write, it never commits). One execute runs at a time: a second waits in the queue, so do not start a second while one is running or queued in the same directory.`,
  `- \`${REVIEW_TOOL}\` { target?, focus? }: Codex reviews the current diff (or the target) read-only; reviews run in parallel.`,
  `- \`${JOBS_TOOL}\` { id?, action? }: lists the jobs, reads one, or cancels it (\`action: "cancel"\`).`,
  '',
  '- Say in one line what you delegate before the call. If the tools are deferred, load them by name first.',
  '- Write a self-contained task: the goal, the files, the constraints and how to check it.',
  '- A call answers with a job id at once: keep working on something else. A message arrives when the job ends; read the job\'s report file (its path is in the message), not the pane, and check the work (run the tests, read the diff) before building on it.',
  '- Call review before integrating an execute result.',
  '- A blocked job waits for the person in its pane: never answer for them.',
].join('\n')

export type Check = { name: string; ok: boolean; detail: string }

/** The doctor's report, one line per check. */
export function doctorReport(checks: readonly Check[]): string {
  const failed = checks.filter(check => !check.ok).length
  const lines = checks.map(check => `${check.ok ? '✓' : '✗'} ${check.name}: ${check.detail}`)
  return [...lines, '', failed ? `${failed} check(s) failed.` : 'Everything codex-team relies on is in place.'].join('\n')
}
