import type { createBook } from './book'
import type { createPaneLayout } from './pane-layout'

export type Kind = 'execute' | 'review'

/** The agent a job runs: its name is also the `--kind` Herdr starts it with. */
export type Engine = 'codex' | 'claude'

/** `engine` is Codex when absent. */
export type Request = { kind: Kind; task: string; files: string[]; target?: string; focus?: string; engine?: Engine }

export type Status = 'queued' | 'starting' | 'working' | 'blocked' | 'done' | 'failed' | 'cancelled'

/** Whether a job has ended, however it ended. */
export const isFinished = (status: Status): boolean => status === 'done' || status === 'failed' || status === 'cancelled'
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
  /** Splits the target (the lead when absent) without taking focus and returns the new pane's id. */
  split(direction: 'right' | 'down', target?: string): Promise<string>
  rename(pane: string, name: string): Promise<void>
  close(pane: string): Promise<void>
  /** Starts `engine` in the pane, with its own command-line `args`. */
  start(name: string, pane: string, engine: Engine, args: string[]): Promise<void>
  /** Sends the prompt and waits for the agent to settle; `timeout` means this chunk ran out, not the job. */
  prompt(name: string, text: string, timeoutMs: number): Promise<Settled>
  /** Waits for a settled state, or for one of `until` when given. */
  wait(name: string, timeoutMs: number, until?: AgentState[]): Promise<AgentState>
  read(name: string, lines: number): Promise<string>
  sendKeys(name: string, keys: string[]): Promise<void>
  /** Types `text` and Enter into the agent without waiting for it to settle. */
  submit(name: string, text: string): Promise<void>
  /** The `ct-*` agents with their pane and terminal: `terminal_id` changes when a pane id is reused after a restart. */
  list(): Promise<{ name: string; pane: string; terminal?: string }[]>
  /** A Herdr notification, seen outside Claude's window. */
  notify(title: string, body: string): Promise<void>
  /** Display-only metadata on one of the plugin's panes, under `--source codex-team`, gone after `ttlMs`. */
  annotate(pane: string, meta: { title?: string; stateLabel?: string; ttlMs: number }): Promise<void>
}

/** The Herdr calls a job run makes. */
export type JobHerdr = Pick<Herdr, 'split' | 'rename' | 'start' | 'prompt' | 'wait' | 'read' | 'list'>

/** One agent shared by the phase jobs of a loop role. */
export type AgentSession = { agent: string; pane?: string; terminal?: string; ready?: boolean; active?: boolean }

export type Job = {
  id: number
  kind: Kind
  engine: Engine
  title: string
  status: Status
  agent: string
  pane?: string
  /** The pane's `terminal_id` once the agent started; part of the identity checked before acting on the pane. */
  terminal?: string
  startedAt: number
  endedAt?: number
  report?: string
  summary?: string
  error?: string
}

export type NotifyEvent = 'blocked' | 'finished'
export type Files = { read(path: string): Promise<string | undefined>; write(path: string, text: string): Promise<void> }
export type Notify = (event: NotifyEvent, job: Job) => void
export type PaneLayout = ReturnType<typeof createPaneLayout>
/** `claudeMode` is the `--permission-mode` of Claude jobs that run commands; see engines.ts. */
export type Deps = { herdr: Herdr; layout: PaneLayout; files: Files; tmpdir: string | undefined; now: () => number; notify: Notify; claudeMode?: string }

export type Verdict = 'approved' | 'changes'
export type Checks = 'pass' | 'fail' | 'not run'
export type Round = { dev: number; qa?: number; verdict?: Verdict; checks?: Checks }
export type LoopStatus = 'developing' | 'reviewing' | 'approved' | 'exhausted' | 'failed' | 'cancelled'
/** The engines are Codex when absent. */
export type LoopRequest = { task: string; files: string[]; maxRounds: number; devEngine?: Engine; qaEngine?: Engine }
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
/** The part of the job book a loop uses. */
export type LoopBook = Pick<Book, 'exclusive' | 'start' | 'ended' | 'get' | 'cancel'>
export type LoopDeps = Pick<Deps, 'layout' | 'files' | 'tmpdir' | 'now'> & { herdr: Pick<Herdr, 'close' | 'wait' | 'list'>; notify: (event: NotifyEvent, loop: Loop, job?: Job) => void }

export type Check = { name: string; ok: boolean; detail: string }

/** What the adapter needs from the host: register.tsx hands `$.process.run` over this way. */
export type Run = (argv: string[], init?: { timeoutMs?: number }) => Promise<{ exitCode: number; stdout: string; stderr: string }>
