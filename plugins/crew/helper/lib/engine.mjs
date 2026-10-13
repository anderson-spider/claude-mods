// The Codex threads of the twins: one `codex app-server` process, one thread per caller (an agent id), one turn at a
// time per caller, a bounded number of turns at once. A turn is started, then polled: the caller never holds a
// request open for the length of a turn.
import { createCollector } from './collector.mjs'
import { LANES, laneOf, refusalFor, SANDBOX_POLICY, THREAD } from './lanes.mjs'
import { resolveLane } from './paths.mjs'

const MODEL = /^[A-Za-z0-9._-]{1,64}$/
const EFFORTS = ['low', 'medium', 'high', 'xhigh']
const MAX_PROMPT = 200_000
const MAX_INSTRUCTIONS = 50_000

export const DEFAULTS = Object.freeze({ limit: 4, turnTimeoutMs: 15 * 60_000, keepThreads: 64, graceMs: 30_000 })

const fail = message => ({ status: 'error', message })

export class Engine {
  #createClient
  #limit
  #turnTimeoutMs
  #keepThreads
  #graceMs
  #resolve
  #now
  #client
  #starting
  #threads = new Map()
  #jobs = new Map()
  #byThread = new Map()

  constructor({ createClient, limit = DEFAULTS.limit, turnTimeoutMs = DEFAULTS.turnTimeoutMs, keepThreads = DEFAULTS.keepThreads, graceMs = DEFAULTS.graceMs, resolve = resolveLane, now = Date.now }) {
    this.#createClient = createClient
    this.#graceMs = graceMs
    this.#resolve = resolve
    this.#limit = limit
    this.#turnTimeoutMs = turnTimeoutMs
    this.#keepThreads = keepThreads
    this.#now = now
  }

  /** Starts a turn for `caller`; answers `started`, `busy`, `full` or an error with its message. Never rejects. */
  async start(input) {
    const bad = this.#invalid(input)

    if (bad !== undefined) {
      return fail(bad)
    }

    const { caller, role, repo, model, prompt } = input
    // The lane is resolved on every start: a link swapped in after the thread began must not widen it.
    const lane = this.#resolve(role, repo)

    if (!lane.ok) {
      return fail(lane.message)
    }

    const existing = this.#jobs.get(caller)

    if (existing !== undefined && !existing.collector.finished) {
      return { status: 'busy' }
    }

    if ([...this.#jobs.values()].filter(job => !job.collector.finished).length >= this.#limit) {
      return { status: 'full', message: `${this.#limit} turns are already running` }
    }

    const job = { caller, collector: createCollector(), startedAt: this.#now(), threadId: undefined, turnId: undefined, stop: false, timedOut: false }
    // Registered first, so a refusal below and a notification that beats the response both find it.
    this.#jobs.set(caller, job)

    try {
      const client = await this.#connect()
      const cwd = lane.cwd
      let known = this.#threads.get(caller)

      if (known === undefined || known.role !== role || known.cwd !== cwd) {
        const params = { cwd, model, ...THREAD }

        if (typeof input.instructions === 'string' && input.instructions !== '') {
          params.developerInstructions = input.instructions
        }

        const started = await client.request('thread/start', params)
        known = { threadId: String(started.thread.id), role, cwd }
        this.#remember(caller, known)
      }

      job.threadId = known.threadId
      this.#byThread.set(known.threadId, caller)
      const turn = { threadId: known.threadId, model, sandboxPolicy: SANDBOX_POLICY, input: [{ type: 'text', text: prompt, text_elements: [] }] }

      if (EFFORTS.includes(input.effort)) {
        turn.effort = input.effort
      }

      const begun = await client.request('turn/start', turn)
      job.turnId = String(begun.turn.id)

      if (job.stop) {
        await this.#interrupt(job)
      }

      return { status: 'started' }
    } catch (error) {
      this.#jobs.delete(caller)

      return fail(error instanceof Error ? error.message : String(error))
    }
  }

  /** `running`, `idle` (nothing started) or the finished turn, which is taken off the books. */
  poll(caller) {
    const job = this.#jobs.get(caller)

    if (job === undefined) {
      return { status: 'idle' }
    }

    if (!job.collector.finished) {
      return { status: 'running', seconds: Math.floor((this.#now() - job.startedAt) / 1000) }
    }

    this.#jobs.delete(caller)
    const result = job.collector.result()

    return {
      status: 'ok',
      turn: job.timedOut ? 'timeout' : result.turn,
      text: result.text,
      files: result.files,
      commands: result.commands,
      declined: result.declined,
      error: result.error ?? null,
    }
  }

  async interrupt(caller) {
    const job = this.#jobs.get(caller)

    if (job === undefined || job.collector.finished) {
      return { status: 'ok', interrupted: false }
    }

    job.stop = true

    return { status: 'ok', interrupted: await this.#interrupt(job) }
  }

  /** Ends the caller's turn and forgets its thread. */
  async reset(caller) {
    await this.interrupt(caller)
    const known = this.#threads.get(caller)

    if (known !== undefined) {
      this.#byThread.delete(known.threadId)
    }

    this.#threads.delete(caller)
    this.#jobs.delete(caller)

    return { status: 'ok' }
  }

  /** Interrupts the turns past the time limit; the poll then answers `timeout`. */
  async sweep() {
    const now = this.#now()

    for (const job of [...this.#jobs.values()]) {
      if (job.collector.finished) {
        continue
      }

      // An interrupt the server took but never confirmed ends the turn for the caller after the grace period, and the
      // thread is dropped: it may still be running, so a new turn must not share it.
      if (job.interruptedAt !== undefined && now - job.interruptedAt > this.#graceMs) {
        this.#abandon(job, 'the turn did not stop after the interrupt')
      } else if (now - job.startedAt > this.#turnTimeoutMs) {
        job.timedOut = true
        job.stop = true

        if (!(await this.#interrupt(job))) {
          this.#abandon(job, 'the turn timed out')
        }
      }
    }
  }

  #abandon(job, message) {
    job.timedOut = true
    job.collector.feed('turn/completed', { turn: { status: 'failed', error: { message } } })
    const known = this.#threads.get(job.caller)

    if (known !== undefined) {
      this.#byThread.delete(known.threadId)
      this.#threads.delete(job.caller)
    }
  }

  status() {
    return {
      jobs: [...this.#jobs.values()].filter(job => !job.collector.finished).length,
      threads: this.#threads.size,
    }
  }

  close() {
    this.#client?.close()
    this.#client = undefined
  }

  #invalid(input) {
    if (input === null || typeof input !== 'object') {
      return 'the request is not an object'
    }

    if (typeof input.caller !== 'string' || input.caller === '') {
      return 'caller must be a non-empty string'
    }

    if (laneOf(input.role) === undefined) {
      return `role must be ${Object.keys(LANES).join(' or ')}`
    }

    if (typeof input.model !== 'string' || !MODEL.test(input.model)) {
      return 'model is not a model id'
    }

    if (typeof input.prompt !== 'string' || input.prompt.trim() === '' || input.prompt.length > MAX_PROMPT) {
      return `prompt must be text of at most ${MAX_PROMPT} characters`
    }

    if (input.instructions !== undefined && (typeof input.instructions !== 'string' || input.instructions.length > MAX_INSTRUCTIONS)) {
      return `instructions must be text of at most ${MAX_INSTRUCTIONS} characters`
    }

    return undefined
  }

  /** Keeps the caller's thread, dropping the oldest threads with no turn running past the cap. */
  #remember(caller, known) {
    const old = this.#threads.get(caller)

    if (old !== undefined) {
      this.#byThread.delete(old.threadId)
    }

    this.#threads.delete(caller)
    this.#threads.set(caller, known)

    for (const key of this.#threads.keys()) {
      if (this.#threads.size <= this.#keepThreads) {
        break
      }

      const job = this.#jobs.get(key)

      if (key !== caller && (job === undefined || job.collector.finished)) {
        this.#byThread.delete(this.#threads.get(key).threadId)
        this.#threads.delete(key)
      }
    }
  }

  async #interrupt(job) {
    if (job.threadId === undefined || job.turnId === undefined || this.#client === undefined) {
      return false
    }

    try {
      await this.#client.request('turn/interrupt', { threadId: job.threadId, turnId: job.turnId })
      job.interruptedAt ??= this.#now()

      return true
    } catch {
      return false
    }
  }

  /** The one server process, started on first use; every caller waits for the same start. */
  #connect() {
    if (this.#client !== undefined && !this.#client.closed) {
      return Promise.resolve(this.#client)
    }

    this.#starting ??= (async () => {
      const client = this.#createClient()
      client.onNotification((method, params) => this.#notified(method, params))
      client.serve(method => refusalFor(method))
      client.onExit(() => this.#lost(client))

      try {
        await client.request('initialize', {
          clientInfo: { name: 'crew', title: null, version: '0.0.0' },
          capabilities: { experimentalApi: false, requestAttestation: false },
        })
      } catch (error) {
        client.close()
        throw error
      }

      client.notify('initialized')
      // Published only once initialized: a caller that arrives meanwhile waits for this start, never for a half-open client.
      this.#client = client

      return client
    })().catch(error => {
      // A server that never initialized is not kept: a stuck child must not outlive the start that spawned it.
      this.#starting = undefined
      throw error
    }).finally(() => {
      this.#starting = undefined
    })

    return this.#starting
  }

  #notified(method, params) {
    const caller = this.#byThread.get(params?.threadId)
    const job = caller === undefined ? undefined : this.#jobs.get(caller)
    job?.collector.feed(method, params)
  }

  /** The server went away: its threads are gone with it and every running turn ends as failed. */
  #lost(client) {
    if (this.#client !== client) {
      return
    }

    this.#client = undefined
    this.#threads.clear()
    this.#byThread.clear()

    for (const job of this.#jobs.values()) {
      job.collector.feed('turn/completed', { turn: { status: 'failed', error: { message: 'the Codex app-server exited' } } })
    }
  }
}
