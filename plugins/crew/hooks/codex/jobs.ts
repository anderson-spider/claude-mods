// Pure lifecycle of a Codex job: foreground, then background after `foregroundMs`; result, cancel and resume checks.
// Every effect is injected (spawn, clock, codec, ids, change and notice callbacks); in the crew the spawn is the tail
// of a detached worker's files (engine.ts).
import type { CodexEvent, JsonlReader, Tokens } from './events'

export type Role = 'code-reader' | 'research' | 'designer' | 'developer' | 'tester' | 'architect'

export type JobStatus = 'running' | 'background' | 'done' | 'error' | 'cancelled' | 'lost'

export type Job = {
  id: string
  agent: Role
  model?: string
  description?: string
  status: JobStatus
  startedAt: number
  endedAt?: number
  cwd: string
  /** The Codex thread id, once `thread.started` arrived; a job with one can be resumed. */
  sessionId?: string
  lastActivity?: string
  /** The last top-level `error` event: a diagnostic, never a failure by itself. */
  lastNote?: string
  /** The last agent_message. */
  result?: string
  error?: string
  tokens?: Tokens
  /** Paths of the completed file_change items, each once, in the order they came. */
  files?: string[]
  /** A graceful cancel was asked: the job ends `cancelled` once its process has. */
  cancelling?: boolean
}

/** What a job needs from a call; the codec may take a richer one (sandbox, instructions, ...). */
export type CallBase = {
  agent: Role
  model?: string
  prompt: string
  cwd: string
  resumeSessionId?: string
}

export type Clock = {
  now(): number | Promise<number>
  /** `id`: the job the timer belongs to (its foreground wait). */
  after(ms: number, fn: () => void, id?: string): { cancel(): void }
}

export type Codec<Call extends CallBase = CallBase> = {
  buildArgv(call: Call): string[]
  createJsonlReader(): JsonlReader
}

export type SpawnRequest = { argv: string[]; cwd: string; input: string }
export type SpawnChunk = { stream: 'stdout' | 'stderr'; text: string }
/**
 * How the process ended. A spawner that knows whether it interrupted the process says so in `interrupted`, which then
 * replaces the guess from the exit code; `lost`: the process is gone and how it ended is unknown (a detached worker
 * that left no exit code).
 */
export type SpawnEnd = { code: number | null; signal: string | null; interrupted?: boolean; lost?: boolean }

/**
 * What a spawn gives back.
 * - `lines`: text chunks (they need not be whole lines; the reader buffers). A plain string counts as stdout, a
 *   `{ stream, text }` chunk is what `$.process.spawn` yields.
 * - `exit`: how the process ended; it may reject.
 * - `cancel`: stop the work and end `lines`; it must be safe to call more than once.
 */
export type Spawned = {
  lines: AsyncIterable<string | SpawnChunk>
  exit: Promise<SpawnEnd>
  cancel(): void
}
export type Spawn = (request: SpawnRequest) => Spawned | Promise<Spawned>

type Deps<Call extends CallBase> = {
  spawn: Spawn
  clock: Clock
  codec: Codec<Call>
  newId: () => string
  onChange: (jobs: Job[]) => void
  notify: (text: string) => void
  initial?: Job[]
}

type RunOptions = {
  foregroundMs: number
  background: boolean
  signal?: AbortSignal
  description?: string
  /** Spawn of this call; absent, the one in `deps`. */
  spawn?: Spawn
  /** The job's id; absent, `deps.newId()`. Set to re-attach a detached worker under the id it started with. */
  id?: string
  /** When the job started; absent, now. Set with `id` when re-attaching. */
  startedAt?: number
  /**
   * A cancel asks the process to stop (`Spawned.cancel`) and the job ends when the process does, as `cancelled` when
   * the spawner reports the interrupt; without it, a cancel ends the job at once and drops the stream.
   */
  gracefulCancel?: boolean
}

type Outcome = 'done' | 'error' | 'background' | 'cancelled' | 'lost'
export type Reply = { job: Job; outcome: Outcome }

function copy(job: Job): Job {
  return { ...job, ...(job.tokens ? { tokens: { ...job.tokens } } : {}), ...(job.files ? { files: [...job.files] } : {}) }
}

function active(job: Job): boolean {
  return job.status === 'running' || job.status === 'background'
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// Codex emits neither turn.completed nor turn.failed when a turn is interrupted, and 0.162 handles SIGINT itself and
// exits 1, the code of a failure: the exit code cannot tell them apart. The spawner that sent the interrupt says so
// (`interrupted`; the crew's worker tail always does); a process that ended on SIGINT is one too.
function interrupted(end: SpawnEnd): boolean {
  return end.interrupted ?? end.signal === 'SIGINT'
}

export function createJobs<Call extends CallBase>(deps: Deps<Call>) {
  const jobs = (deps.initial ?? []).map(copy)
  const live = new Map<string, { cancel: () => void }>()
  const list = (): Job[] => jobs.map(copy)
  const changed = () => deps.onChange(list())
  const find = (id: string) => jobs.find(job => job.id === id)

  function cancel(id: string): Job | { error: string } {
    const job = find(id)
    if (!job) return { error: `Unknown job ${id}.` }
    if (active(job)) {
      const runtime = live.get(id)
      if (!runtime) return { error: `Job ${id} has no live process; reload its state as lost.` }
      runtime.cancel()
    }
    return copy(job)
  }

  async function run(call: Call, opts: RunOptions): Promise<Reply> {
    const job: Job = {
      id: opts.id ?? deps.newId(), agent: call.agent, model: call.model, description: opts.description,
      status: opts.background ? 'background' : 'running',
      startedAt: opts.startedAt ?? await deps.clock.now(), cwd: call.cwd,
      // A resume owns its Codex session from the start, so the session cannot be resumed twice.
      ...(call.resumeSessionId ? { sessionId: call.resumeSessionId } : {}),
    }
    // A job read back from its record and now followed (another session's, once its Codex is gone) is replaced.
    const listed = jobs.findIndex(other => other.id === job.id && !live.has(other.id))
    if (listed >= 0) jobs.splice(listed, 1)
    jobs.push(job)
    changed()

    let finished = false
    let wasBackground = opts.background
    let close: (() => void) | undefined
    let timer: ReturnType<Clock['after']> | undefined
    let completedTurn = false
    let failedTurn = false
    let cancelAsked = false
    let stop: (() => void) | undefined
    let resolveCompletion!: (reply: Reply) => void
    const completion = new Promise<Reply>(resolve => { resolveCompletion = resolve })
    let resolveBackground!: (reply: Reply) => void
    const background = new Promise<Reply>(resolve => { resolveBackground = resolve })
    const abort = () => { cancel(job.id) }
    const detach = () => opts.signal?.removeEventListener('abort', abort)

    async function finish(status: Exclude<Outcome, 'background'>, error?: string) {
      if (finished) return
      finished = true
      timer?.cancel()
      detach()
      live.delete(job.id)
      job.status = status
      if (error !== undefined) job.error = error
      job.endedAt = await deps.clock.now()
      changed()
      resolveCompletion({ job: copy(job), outcome: status })
      if (wasBackground) {
        // Only the id and the status: Codex output reaches the lead through codex_result, as a tool result.
        deps.notify(`crew: Codex job ${job.id} (${job.agent}) ended with ${status}; use codex_result({ jobId: '${job.id}' }).`)
      }
    }

    live.set(job.id, {
      cancel() {
        if (finished) return
        if (opts.gracefulCancel) {
          // Asked once; the job stays active until the process ends, which the spawner reports as interrupted.
          if (cancelAsked) return
          cancelAsked = true
          job.cancelling = true
          changed()
          stop?.()
          return
        }
        // Mark first so a late stream result cannot overwrite cancellation.
        void finish('cancelled')
        close?.()
      },
    })

    if (!opts.background) {
      opts.signal?.addEventListener('abort', abort, { once: true })
      if (opts.signal?.aborted) {
        cancel(job.id)
        return completion
      }
      timer = deps.clock.after(opts.foregroundMs, () => {
        if (finished) return
        wasBackground = true
        job.status = 'background'
        detach()
        changed()
        resolveBackground({ job: copy(job), outcome: 'background' })
      }, job.id)
    }

    function apply(events: CodexEvent[]) {
      for (const event of events) {
        if (finished) return
        switch (event.kind) {
          case 'session': job.sessionId = event.sessionId; break
          case 'activity': job.lastActivity = event.text; break
          case 'message': job.result = event.text; break
          case 'started': break
          case 'files':
            job.files = [...new Set([...(job.files ?? []), ...event.paths])]
            break
          case 'completed':
            completedTurn = true
            if (event.tokens) job.tokens = { ...event.tokens }
            break
          case 'failed':
            failedTurn = true
            job.error = event.error || 'Codex reported a failure.'
            break
          case 'note':
            job.lastNote = event.text
            job.lastActivity = `error: ${event.text}`
            break
          case 'warning':
            job.lastActivity = `warning: ${event.text}`
            break
        }
        changed()
      }
    }

    async function consume() {
      let stderr = ''
      const diagnostics = () => stderr.trim().split('\n').slice(-20).join('\n')
      try {
        const reader = deps.codec.createJsonlReader()
        const spawned = await (opts.spawn ?? deps.spawn)({ argv: deps.codec.buildArgv(call), cwd: call.cwd, input: call.prompt })
        // Observe exit rejection before pulling: it can precede the final chunk.
        const exit = spawned.exit.then(
          value => ({ ok: true as const, value }),
          error => ({ ok: false as const, error }),
        )
        const iterator = spawned.lines[Symbol.asyncIterator]()
        let closed = false
        close = () => {
          if (closed) return
          closed = true
          try { spawned.cancel() } catch { /* Cancellation remains terminal even if teardown fails. */ }
          try { void Promise.resolve(iterator.return?.()).catch(() => {}) } catch { /* Same. */ }
        }
        stop = () => { try { spawned.cancel() } catch { /* The process ends on its own or is found lost. */ } }
        // Cancelled while the spawn was still starting.
        if (finished) { close(); return }
        if (cancelAsked) stop()
        while (!finished) {
          const chunk = await iterator.next()
          if (finished) return
          if (chunk.done) break
          const { stream, text } = typeof chunk.value === 'string' ? { stream: 'stdout', text: chunk.value } : chunk.value
          if (stream === 'stderr') stderr = (stderr + text).slice(-8000)
          else apply(reader.push(text))
        }
        if (finished) return
        apply(reader.end())
        const ended = await exit
        if (finished) return
        if (!ended.ok) throw ended.error
        const { code, signal } = ended.value

        // No terminal event and an interrupt: the turn was stopped, not failed.
        if (!completedTurn && !failedTurn && interrupted(ended.value)) {
          await finish('cancelled')
          return
        }
        // No terminal event and no exit code: nobody knows how it ended.
        if (!completedTurn && !failedTurn && ended.value.lost) {
          await finish('lost', 'The Codex process ended without leaving an exit code.')
          return
        }
        const errors = job.error ? [job.error] : []
        if (code !== 0 && !(code === null && signal)) {
          errors.push(code === null ? 'Codex exited without an exit code.' : `codex exited with code ${code}`)
        }
        if (signal) errors.push(`Codex exited on signal ${signal}.`)
        if (!completedTurn && !failedTurn) errors.push('Codex exited without turn.completed.')
        if (errors.length) {
          if (!job.error && job.lastNote) errors.push(`Last Codex error: ${job.lastNote}`)
          if (diagnostics()) errors.push(diagnostics())
          await finish('error', errors.join('\n'))
        } else await finish('done')
      } catch (error) {
        close?.()
        await finish('error', [job.error, errorText(error), diagnostics()].filter(Boolean).join('\n'))
      }
    }

    void consume()
    if (finished) return completion
    if (opts.background) return { job: copy(job), outcome: 'background' }
    return Promise.race([completion, background])
  }

  return {
    run, cancel, list,
    get(id: string): Job | undefined { const job = find(id); return job && copy(job) },
    resumeTarget(id: string): { sessionId: string; cwd: string; agent: Role } | { error: string } {
      const job = find(id)
      if (!job) return { error: `Unknown job ${id}.` }
      if (active(job)) return { error: `Job ${id} is still active; wait for it or cancel it before resuming.` }
      if (!job.sessionId) {
        return { error: `Job ${id} died before Codex opened its session; delegate it again.` }
      }
      const busy = jobs.find(other => other.sessionId === job.sessionId && active(other))
      if (busy) return { error: `The Codex session of job ${id} is already in use by job ${busy.id}; wait for it or cancel it before resuming.` }
      return { sessionId: job.sessionId, cwd: job.cwd, agent: job.agent }
    },
  }
}
