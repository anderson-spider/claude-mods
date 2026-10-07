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
      job.status = 'blocked'
      deps.notify('blocked', job)
      state = await settle(timeoutMs => herdr.wait(job.agent, timeoutMs, LEFT_BLOCKED))
      if (state === 'working') {
        job.status = 'working'
        state = await settle(timeoutMs => herdr.wait(job.agent, timeoutMs))
      }
    }
    return state
  }

  try {
    job.status = 'starting'
    job.pane = await herdr.split(splitDirection(await herdr.size()))

    try {
      await herdr.start(job.agent, job.pane, codexArgs(request.kind))
    } catch (error) {
      if (!(error instanceof HerdrError) || error.code !== 'agent_not_ready') throw error
      await whileBlocked('blocked')
    }

    const path = reportPath(deps.tmpdir, job.id)
    job.status = 'working'
    await whileBlocked(await settle(timeoutMs => herdr.prompt(job.agent, buildPrompt(request.kind, request, path), timeoutMs)))

    const report = await deps.files.read(path)
    if (report !== undefined) {
      job.report = path
      job.summary = report.slice(0, SUMMARY_CHARS)
    } else {
      job.summary = await herdr.read(job.agent, 200)
      job.error = `no report was written to ${path}; the summary is the text of the pane${where()}`
    }
    job.status = 'done'
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const code = error instanceof HerdrError ? error.code : ''
    job.status = 'failed'
    job.error =
      code === 'agent_prompt_stalled'
        ? `Codex showed no activity after the prompt${where()}; it may still have arrived, so it was not sent again: inspect the pane.`
        : code === 'timeout'
          ? `timeout: ${message}${where()}; Codex was not stopped.`
          : `${message}${where()}`
  }

  job.endedAt = deps.now()
  deps.notify('finished', job)
}
