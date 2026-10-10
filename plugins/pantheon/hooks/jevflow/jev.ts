// The Jev client of JevFlow's judge (jev_client.py), on OpenRouter's decisions endpoint. Pure: the HTTP call and the
// timers are injected, and nothing here touches `$`, Node or the DOM. `createJev` returns the `ask` that questions.ts
// calls: it resolves with the answers object, or throws a JevFailure whose `reason` is typed. A 2xx body of the wrong
// shape is `malformed` and is not retried. The key never reaches an error message.

import type { AskFn, Answers, Questions } from './questions'
import { head, redactSecrets } from './redact'

export const JEV_URL = 'https://openrouter.ai/api/alpha/decisions'
export const JEV_MODEL = 'typesafe/jev-1.13'
/** Per attempt (jev_client.py `DEFAULT_TIMEOUT_S`). */
export const JEV_TIMEOUT_MS = 15_000
export const JEV_MAX_RETRIES = 3
export const BACKOFF_BASE_MS = 500
export const MAX_BACKOFF_MS = 8_000
/** Retried with backoff: 429, the 5xx gateway and server errors, and the 529 overload. */
export const RETRY_STATUSES: ReadonlySet<number> = new Set([429, 500, 502, 503, 504, 529])
const ERROR_DETAIL_CHARS = 300
const ERROR_TEXT_CHARS = 200
const CONTROL = /[\s\u0000-\u001f\u007f]/

// --- Host access ---

export type JevInit = { method: string; headers: Record<string, string>; body: string }
export type JevFetch = (url: string, init: JevInit) => Promise<{ status: number; text: string; headers?: Record<string, string> }>
/** Starts a timer and returns its cancellation. */
export type JevTimer = (ms: number, fn: () => void) => () => void
/** The host access the client needs. The clock belongs to the breaker, which takes its own `now`. */
export type JevIo = { fetch: JevFetch; timer: JevTimer }

// --- Typed failures ---

export type JevFailureReason = 'http' | 'timeout' | 'network' | 'malformed' | 'breaker' | 'config' | 'error'

/** What `ask` throws. `http` carries the status; `malformed` is a 2xx body that is not the expected shape. */
export class JevFailure extends Error {
  readonly reason: JevFailureReason
  readonly status: number | undefined

  constructor(reason: JevFailureReason, message: string, status?: number) {
    super(message)
    this.name = 'JevFailure'
    this.reason = reason
    this.status = status
  }
}

// --- Breaker (shared by every caller of one judge) ---

export type Breaker = {
  /** False while open. When the pause is over exactly one call is let through as a probe and the rest stay refused
   *  until it reports: a failure reopens, a success closes. */
  allow(): boolean
  success(): void
  failure(): void
  /** An outcome that says nothing about the service (a rejected request): frees the probe without closing or reopening. */
  release?(): void
  status(): { open: boolean; failures: number; until?: number }
}

export const BREAKER_FAILURES = 3
export const BREAKER_PAUSE_MS = 5 * 60_000
/** Refused calls after which one is let through anyway; see `createBreaker`. */
export const BREAKER_MAX_REFUSALS = 50

/**
 * Three consecutive failures open it for five minutes; then one probe goes through (half-open): a failure reopens it
 * for another five minutes, a success closes it. `now` is the injected clock; share one breaker across callers.
 * Fail safe against a clock that stands still (stuck at 0, or not a clock at all) and against a probe that never
 * reports: every 50th refused call is let through anyway, so the breaker can never stay shut for good.
 */
export function createBreaker(now: () => number, opts: { failures?: number; pauseMs?: number } = {}): Breaker {
  const clock = safeClock(now)
  const limit = opts.failures ?? BREAKER_FAILURES
  const pause = opts.pauseMs ?? BREAKER_PAUSE_MS
  let failures = 0
  let refused = 0
  let probing = false
  let until: number | undefined
  const refuse = () => {
    refused += 1
    if (refused < BREAKER_MAX_REFUSALS) return false
    refused = 0
    return true
  }
  return {
    allow() {
      if (until === undefined) return true
      if (clock() < until) return refuse()
      // half-open: one probe at a time
      if (probing) return refuse()
      probing = true
      refused = 0
      return true
    },
    success() { failures = 0; refused = 0; probing = false; until = undefined },
    failure() {
      failures += 1
      refused = 0
      probing = false
      if (failures >= limit) until = clock() + pause
    },
    release() { probing = false },
    status: () => ({ open: until !== undefined && clock() < until, failures, ...(until === undefined ? {} : { until }) }),
  }
}

/** A clock that cannot throw or return a non-number: those read as 0. */
function safeClock(now: () => number): () => number {
  return () => {
    try {
      const value = Number(now())
      return Number.isFinite(value) ? value : 0
    } catch { return 0 }
  }
}

// --- Client ---

export type JevOptions = {
  breaker?: Breaker
  /** Per attempt. Default `JEV_TIMEOUT_MS`. */
  timeoutMs?: number
  /** Retries after the first attempt. Default `JEV_MAX_RETRIES`. */
  maxRetries?: number
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** The `answers` of a 2xx body, shape-checked as jev_client.py `_parse` does; the judge reads the values. */
export function parseAnswersBody(text: string): Answers {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    throw new JevFailure('malformed', 'Jev response is not JSON')
  }
  if (!isRecord(data) || !isRecord(data.answers)) throw new JevFailure('malformed', 'Jev response has no answers object')
  const answers = data.answers
  for (const [name, answer] of Object.entries(answers)) {
    const label = head(name, 40)
    if (!isRecord(answer) || !('type' in answer)) throw new JevFailure('malformed', `Jev answer "${label}" is malformed`)
    if (answer.type === 'noul' && typeof answer.noul !== 'number') {
      throw new JevFailure('malformed', `Jev noul answer "${label}" has no value`)
    }
    if (answer.type === 'choice' && !isRecord(answer.probabilities)) {
      throw new JevFailure('malformed', `Jev choice answer "${label}" has no probabilities`)
    }
    if (answer.type === 'score' && typeof answer.score !== 'number') {
      throw new JevFailure('malformed', `Jev score answer "${label}" has no score`)
    }
  }
  return answers as Answers
}

function headerValue(headers: Record<string, string> | undefined, name: string): string | undefined {
  if (!headers) return undefined
  for (const [key, value] of Object.entries(headers)) if (key.toLowerCase() === name) return String(value)
  return undefined
}

/** `Retry-After` in seconds, as milliseconds; undefined when absent or not a number (jev_client.py `_retry_after_s`). */
export function retryAfterMs(headers: Record<string, string> | undefined): number | undefined {
  const raw = headerValue(headers, 'retry-after')?.trim()
  if (!raw) return undefined
  const seconds = Number(raw)
  return Number.isFinite(seconds) ? Math.max(0, seconds) * 1000 : undefined
}

/** The pause before retry `attempt` (0-based): `Retry-After` when given, else exponential; both capped at 8 s. */
export function backoffMs(attempt: number, retryAfter: number | undefined): number {
  if (retryAfter !== undefined) return Math.min(retryAfter, MAX_BACKOFF_MS)
  return Math.min(BACKOFF_BASE_MS * 2 ** attempt, MAX_BACKOFF_MS)
}

type Sent =
  | { kind: 'response'; status: number; text: string; headers: Record<string, string> | undefined }
  | { kind: 'timeout' }
  | { kind: 'network'; message: string }

/** One attempt, raced against its own deadline. A fetch that rejects, throws or never answers is reported, not raised. */
async function sendOnce(io: JevIo, init: JevInit, timeoutMs: number): Promise<Sent> {
  let expire: () => void = () => {}
  const deadline = new Promise<'timeout'>(resolve => { expire = () => resolve('timeout') })
  const cancel = io.timer(timeoutMs, () => expire())
  const sent = (async (): Promise<Sent> => {
    try {
      const response = await io.fetch(JEV_URL, init)
      return { kind: 'response', status: response.status, text: String(response.text ?? ''), headers: response.headers }
    } catch (error) {
      return { kind: 'network', message: error instanceof Error ? error.message : String(error) }
    }
  })()
  try {
    const winner = await Promise.race([sent, deadline])
    return winner === 'timeout' ? { kind: 'timeout' } : winner
  } finally {
    cancel()
  }
}

const sleep = (io: JevIo, ms: number) => new Promise<void>(resolve => { io.timer(ms, () => resolve()) })

/** Up to `maxRetries` retries of timeouts, network errors and RETRY_STATUSES; anything else returns or throws at once. */
async function exchange(io: JevIo, init: JevInit, timeoutMs: number, maxRetries: number, key: string): Promise<Answers> {
  for (let attempt = 0; ; attempt++) {
    const sent = await sendOnce(io, init, timeoutMs)
    if (sent.kind === 'response' && sent.status >= 200 && sent.status < 300) return parseAnswersBody(sent.text)
    let failure: JevFailure
    let retryAfter: number | undefined
    if (sent.kind === 'timeout') {
      failure = new JevFailure('timeout', `Jev request timed out after ${timeoutMs} ms`)
    } else if (sent.kind === 'network') {
      failure = new JevFailure('network', `Jev connection failed: ${scrub(sent.message, key, ERROR_TEXT_CHARS)}`)
    } else {
      const detail = scrub(sent.text, key, ERROR_DETAIL_CHARS)
      const message = `Jev HTTP ${sent.status}${detail ? `: ${detail}` : ''}`
      if (!RETRY_STATUSES.has(sent.status)) throw new JevFailure('http', message, sent.status)
      retryAfter = retryAfterMs(sent.headers)
      failure = new JevFailure('http', message, sent.status)
    }
    if (attempt >= maxRetries) throw failure
    await sleep(io, backoffMs(attempt, retryAfter))
  }
}

/** The key is replaced wherever a provider's text could echo it, and the text is redacted and capped. */
function scrub(text: string, key: string, cap: number): string {
  const withoutKey = key ? text.split(key).join('[REDACTED]') : text
  return head(redactSecrets(withoutKey), cap)
}

function allowed(breaker: Breaker): boolean {
  try {
    return breaker.allow()
  } catch {
    return true // fail open: a broken breaker never blocks the judge
  }
}

function report(breaker: Breaker | undefined, outcome: 'success' | 'failure' | 'release'): void {
  if (!breaker) return
  try {
    if (outcome === 'success') breaker.success()
    else if (outcome === 'failure') breaker.failure()
    else breaker.release?.()
  } catch {
    // a broken breaker never breaks the judge
  }
}

/**
 * The `ask` for questions.ts: one call is one judgment. The timeout is per attempt; timeouts, network errors and
 * RETRY_STATUSES are retried with backoff (Retry-After honoured, capped at 8 s). A rejected request (400/422) frees
 * the breaker's probe without counting against it. Throws a JevFailure, never anything else.
 */
export function createJev(io: JevIo, key: string, opts: JevOptions = {}): AskFn {
  const timeoutMs = opts.timeoutMs !== undefined && opts.timeoutMs > 0 ? opts.timeoutMs : JEV_TIMEOUT_MS
  const maxRetries = Math.max(0, Math.trunc(opts.maxRetries ?? JEV_MAX_RETRIES))
  const token = typeof key === 'string' ? key.trim() : ''
  const breaker = opts.breaker

  return async (questions: Questions, state: string): Promise<Answers> => {
    if (!token) throw new JevFailure('config', 'no Jev API key: set the plugin option or JEV_API_KEY')
    if (CONTROL.test(token)) throw new JevFailure('config', 'Jev API key contains whitespace or control characters')
    if (typeof questions !== 'object' || questions === null || Object.keys(questions).length === 0) {
      throw new JevFailure('config', 'questions must be non-empty')
    }
    if (breaker && !allowed(breaker)) throw new JevFailure('breaker', 'Jev is paused after repeated failures; nothing was sent')
    const init: JevInit = {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'User-Agent': 'jevflow' },
      body: JSON.stringify({ state, model: JEV_MODEL, questions }),
    }
    try {
      const answers = await exchange(io, init, timeoutMs, maxRetries, token)
      report(breaker, 'success')
      return answers
    } catch (error) {
      const failure = error instanceof JevFailure
        ? error
        : new JevFailure('error', scrub(error instanceof Error ? error.message : String(error), token, ERROR_TEXT_CHARS))
      const rejected = failure.reason === 'http' && (failure.status === 400 || failure.status === 422)
      report(breaker, rejected ? 'release' : 'failure')
      throw failure
    }
  }
}
