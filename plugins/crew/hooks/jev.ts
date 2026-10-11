// The Jev client for model routing. Pure: the HTTP call, the timer and the clock are injected and nothing here touches
// `$`. Endpoint, body and answer shape are those of the TypeSafe SDK's `systemOne` (POST /v1/systemone, bearer key,
// `{ model, state, questions }`, answers keyed by question id), checked live. `ask` resolves with the answers or throws a
// JevFailure whose `reason` is typed; its message holds a status or a reason code, never a response body or the key.

export const JEV_URL = 'https://api.typesafe.ai/v1/systemone'
/** One deadline for the whole call, retries included. */
export const JEV_DEADLINE_MS = 3_000
/** The longest a call holds its slot of the gate, whether or not its fetch has settled. */
export const SLOT_HOLD_MS = 60_000
/** A retry starts only when at least this much of the deadline is left. */
export const RETRY_MIN_LEFT_MS = 1_000
const RETRY_PAUSE_MS = 250
const RETRY_PAUSE_CAP_MS = 1_000
export const MAX_CONCURRENT = 4
/** Retried once: 429, the 5xx gateway and server errors, and the 529 overload. */
const RETRY_STATUSES: ReadonlySet<number> = new Set([429, 500, 502, 503, 504, 529])
const CONTROL = /[\s\u0000-\u001f\u007f]/
const MODEL_ID = /^[\w.:-]{1,64}$/

// --- Host access ---

export type JevInit = { method: string; headers: Record<string, string>; body: string }
export type JevResponse = { status: number; text: string; headers?: Record<string, string> }
export type JevIo = {
  fetch: (url: string, init: JevInit) => Promise<JevResponse>
  /** Starts a timer and returns its cancellation. */
  timer: (ms: number, fn: () => void) => () => void
  /** Milliseconds, any origin: only differences are read. */
  now: () => number
}

// --- Typed failures ---

export type JevFailureReason = 'http' | 'timeout' | 'network' | 'malformed' | 'breaker' | 'busy' | 'config'

export class JevFailure extends Error {
  readonly reason: JevFailureReason
  readonly status?: number

  constructor(reason: JevFailureReason, message: string, status?: number) {
    super(message)
    this.name = 'JevFailure'
    this.reason = reason
    this.status = status
  }
}

// --- Breaker and concurrency cap, shared by every call while the module lives ---

export type Breaker = {
  /** False while open. When the pause is over one call goes through as a probe: a failure reopens, a success closes. */
  allow(): boolean
  success(): void
  failure(): void
  /** An outcome that says nothing about the service (a rejected request): frees the probe. */
  release(): void
}

export const BREAKER_FAILURES = 3
export const BREAKER_PAUSE_MS = 5 * 60_000

export function createBreaker(now: () => number, opts: { failures?: number; pauseMs?: number } = {}): Breaker {
  const limit = opts.failures ?? BREAKER_FAILURES
  const pause = opts.pauseMs ?? BREAKER_PAUSE_MS
  let failures = 0
  let probing = false
  let until: number | undefined
  return {
    allow() {
      if (until === undefined) return true
      if (now() < until || probing) return false
      probing = true
      return true
    },
    success() { failures = 0; probing = false; until = undefined },
    failure() {
      failures += 1
      probing = false
      if (failures >= limit) until = now() + pause
    },
    release() { probing = false },
  }
}

/** Calls in flight, bounded: the rate limit is shared per account. */
export type Gate = { acquire(): boolean; release(): void }

export function createGate(max = MAX_CONCURRENT): Gate {
  let inflight = 0
  return {
    acquire() {
      if (inflight >= max) return false
      inflight += 1
      return true
    },
    release() { inflight = Math.max(0, inflight - 1) },
  }
}

// --- Client ---

export type Answers = Record<string, Record<string, unknown>>
export type JevReply = { answers: Answers; model?: string; ms: number }
export type AskFn = (questions: unknown, state: unknown) => Promise<JevReply>

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** The answers of a 2xx body; a body of another shape is `malformed` and is not retried. */
export function parseBody(text: string): { answers: Answers; model?: string } {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    throw new JevFailure('malformed', 'response is not JSON')
  }
  if (!isRecord(data) || !isRecord(data.answers)) throw new JevFailure('malformed', 'response has no answers object')
  for (const answer of Object.values(data.answers)) {
    if (!isRecord(answer)) throw new JevFailure('malformed', 'an answer is not an object')
  }
  // The model id only reaches the debug log: a value of another shape (an echoed header, say) is not kept.
  const model = typeof data.model === 'string' && MODEL_ID.test(data.model) ? data.model : undefined
  return { answers: data.answers as Answers, ...(model ? { model } : {}) }
}

/** `Retry-After` in seconds as milliseconds; undefined when absent or not a number. */
function retryAfterMs(headers: Record<string, string> | undefined): number | undefined {
  if (!headers) return undefined
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() !== 'retry-after') continue
    const seconds = Number(String(value).trim())
    return Number.isFinite(seconds) ? Math.max(0, seconds) * 1000 : undefined
  }
  return undefined
}

export type JevOptions = { model: string; breaker?: Breaker; gate?: Gate; deadlineMs?: number; holdMs?: number }

/** One call is one judgment. Throws a JevFailure, never anything else. */
export function createJev(io: JevIo, key: string, opts: JevOptions): AskFn {
  const token = typeof key === 'string' ? key.trim() : ''
  const deadlineMs = opts.deadlineMs ?? JEV_DEADLINE_MS
  const holdMs = opts.holdMs ?? SLOT_HOLD_MS

  return async (questions, state) => {
    if (!token) throw new JevFailure('config', 'no key')
    if (CONTROL.test(token)) throw new JevFailure('config', 'the key has whitespace or control characters')
    if (opts.gate && !opts.gate.acquire()) throw new JevFailure('busy', 'too many calls in flight')
    if (opts.breaker && !opts.breaker.allow()) {
      opts.gate?.release()
      throw new JevFailure('breaker', 'paused after repeated failures')
    }
    // The request cannot be aborted: the slot is held until the fetch settles, which may be after the deadline, and
    // for `holdMs` at most (a fetch that never settles must not take the slot for the module's life).
    let running = 0
    let done = false
    let released = false
    let cancelHold: () => void = () => {}
    const release = () => {
      if (released) return
      released = true
      cancelHold()
      opts.gate?.release()
    }
    const free = () => {
      if (done && running === 0) release()
    }
    const tracked: JevIo = {
      ...io,
      fetch: (url, init) => {
        running += 1
        const sent = (async () => io.fetch(url, init))()
        const settled = () => { running -= 1; free() }
        sent.then(settled, settled)
        return sent
      },
    }
    const init: JevInit = {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: opts.model, state, questions }),
    }
    const started = io.now()
    let expire: () => void = () => {}
    const deadline = new Promise<'timeout'>(resolve => { expire = () => resolve('timeout') })
    const cancel = io.timer(deadlineMs, () => expire())
    const left = () => deadlineMs - (io.now() - started)
    if (opts.gate) cancelHold = io.timer(holdMs, release)

    try {
      const reply = await attempts(tracked, init, deadline, left)
      opts.breaker?.success()
      return { ...reply, ms: Math.max(0, io.now() - started) }
    } catch (error) {
      const failure = error instanceof JevFailure ? error : new JevFailure('network', 'request failed')
      // A rejected request or an unreadable 2xx says nothing about the service's health.
      const says = failure.reason === 'malformed' || (failure.reason === 'http' && (failure.status === 400 || failure.status === 422))
      if (says) opts.breaker?.release()
      else opts.breaker?.failure()
      throw failure
    } finally {
      cancel()
      done = true
      free()
    }
  }
}

type Outcome = { kind: 'response'; response: JevResponse } | { kind: 'timeout' } | { kind: 'network' }

async function once(io: JevIo, init: JevInit, deadline: Promise<'timeout'>): Promise<Outcome> {
  const sent = (async (): Promise<Outcome> => {
    try {
      return { kind: 'response', response: await io.fetch(JEV_URL, init) }
    } catch {
      // The reason only: an error message could carry request details.
      return { kind: 'network' }
    }
  })()
  const winner = await Promise.race([sent, deadline])
  return winner === 'timeout' ? { kind: 'timeout' } : winner
}

/** The first attempt and, while the one deadline allows, a single retry of a transient failure. */
async function attempts(io: JevIo, init: JevInit, deadline: Promise<'timeout'>, left: () => number) {
  for (let attempt = 0; ; attempt++) {
    const out = await once(io, init, deadline)
    if (out.kind === 'timeout') throw new JevFailure('timeout', 'deadline passed')
    let failure: JevFailure
    let pause = RETRY_PAUSE_MS
    if (out.kind === 'network') {
      failure = new JevFailure('network', 'request failed')
    } else {
      const { status, text, headers } = out.response
      if (status >= 200 && status < 300) return parseBody(String(text ?? ''))
      failure = new JevFailure('http', `HTTP ${status}`, status)
      if (!RETRY_STATUSES.has(status)) throw failure
      pause = Math.min(retryAfterMs(headers) ?? RETRY_PAUSE_MS, RETRY_PAUSE_CAP_MS)
    }
    if (attempt >= 1 || left() < RETRY_MIN_LEFT_MS) throw failure
    const slept = await Promise.race([
      new Promise<'slept'>(resolve => { io.timer(pause, () => resolve('slept')) }),
      deadline,
    ])
    if (slept === 'timeout') throw new JevFailure('timeout', 'deadline passed')
  }
}
