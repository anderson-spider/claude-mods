import type { createBook } from './book'

export type Kind = 'execute' | 'review'

export type Request = { kind: Kind; task: string; files: string[]; target?: string; focus?: string }

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

export type Files = { read(path: string): Promise<string | undefined>; write(path: string, text: string): Promise<void> }
export type Notify = (event: 'blocked' | 'finished', job: Job) => void
export type Deps = { herdr: Herdr; files: Files; tmpdir: string | undefined; now: () => number; notify: Notify }

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

export type Book = ReturnType<typeof createBook>
export type LoopDeps = Pick<Deps, 'files' | 'tmpdir' | 'now'> & { notify: (event: 'finished', loop: Loop) => void }

export type Check = { name: string; ok: boolean; detail: string }

/** What the adapter needs from the host: register.tsx hands `$.process.run` over this way. */
export type Run = (argv: string[], init?: { timeoutMs?: number }) => Promise<{ exitCode: number; stdout: string; stderr: string }>
