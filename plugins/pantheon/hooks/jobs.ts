import type { Clock, Codec, CodexCall, CodexEvent, Job, Spawn } from './types'

type Deps = {
  spawn: Spawn; clock: Clock; codec: Codec; newId: () => string
  onChange: (jobs: Job[]) => void; notify: (text: string) => void; initial?: Job[]
}
type RunOptions = {
  foregroundMs: number; background: boolean; signal?: AbortSignal; description?: string
  /** Spawn desta chamada; ausente, o de `deps`. */
  spawn?: Spawn
}
type Outcome = 'done' | 'error' | 'background' | 'cancelled'
type Reply = { job: Job; outcome: Outcome }

function copy(job: Job): Job {
  return { ...job, ...(job.tokens ? { tokens: { ...job.tokens } } : {}) }
}

function active(job: Job): boolean {
  return job.status === 'running' || job.status === 'background'
}

export function markLost(jobs: Job[]): Job[] {
  return jobs.map(job => ({ ...copy(job), status: active(job) ? 'lost' : job.status }))
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function createJobs(deps: Deps) {
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

  async function run(call: CodexCall, opts: RunOptions): Promise<Reply> {
    const job: Job = {
      id: deps.newId(), agent: call.agent, model: call.model, description: opts.description,
      status: opts.background ? 'background' : 'running',
      startedAt: await deps.clock.now(), cwd: call.cwd,
      // Um resume já nasce dono da sessão Codex, para que ela não seja retomada duas vezes.
      ...(call.resumeSessionId ? { sessionId: call.resumeSessionId } : {}),
    }
    jobs.push(job)
    changed()

    let finished = false
    let wasBackground = opts.background
    let close: (() => void) | undefined
    let timer: ReturnType<Clock['after']> | undefined
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
        deps.notify(`pantheon: job ${job.id} (${job.agent}) ended with ${status}; use delegate_result({ jobId: '${job.id}' }).`)
      }
    }

    live.set(job.id, {
      cancel() {
        if (finished) return
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
      })
    }

    function apply(events: CodexEvent[]) {
      for (const event of events) {
        if (finished) return
        switch (event.kind) {
          case 'session': job.sessionId = event.sessionId; break
          case 'activity': job.lastActivity = event.text; break
          case 'message': job.result = event.text; break
          case 'usage': job.tokens = { ...event.tokens }; break
          case 'failed': job.error = event.error || 'Codex reported a failure.'; break
        }
        changed()
      }
    }

    async function consume() {
      let stderr = ''
      const diagnostics = () => stderr.trim().split('\n').slice(-20).join('\n')
      try {
        const reader = deps.codec.createJsonlReader()
        const stream = (opts.spawn ?? deps.spawn)({ argv: deps.codec.buildArgv(call), cwd: call.cwd, input: call.prompt })
        // Observe exit rejection before pulling: it can precede the final chunk.
        const exit = stream.result.then(
          value => ({ ok: true as const, value }),
          error => ({ ok: false as const, error }),
        )
        const iterator = stream[Symbol.asyncIterator]()
        let closed = false
        close = () => {
          if (closed) return
          closed = true
          try {
            const returned = stream.return ? stream.return() : iterator.return?.()
            void Promise.resolve(returned).catch(() => {})
          } catch { /* Cancellation remains terminal even if teardown fails. */ }
        }
        while (!finished) {
          const chunk = await iterator.next()
          if (finished) return
          if (chunk.done) break
          if (chunk.value.stream === 'stderr') stderr = (stderr + chunk.value.text).slice(-8000)
          else apply(reader.push(chunk.value.text))
        }
        if (finished) return
        apply(reader.end())
        const ended = await exit
        if (finished) return
        if (!ended.ok) throw ended.error
        const errors = job.error ? [job.error] : []
        if (ended.value.code !== 0) {
          errors.push(ended.value.code === null ? 'Codex exited without an exit code.' : `codex exited with code ${ended.value.code}`)
        }
        if (ended.value.signal) errors.push(`Codex exited on signal ${ended.value.signal}.`)
        if (!job.result?.trim()) errors.push('Codex exited without a final message (agent_message).')
        if (errors.length) {
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
    resumeTarget(id: string): { sessionId: string; cwd: string; agent: string } | { error: string } {
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
